/**
 * Kernel 2: atomic multi-operation write core.
 *
 * Generalises the validate-project-commit shape of
 * {@link applyPinnedOperations} (pinned.ts) into a core that executes an
 * ordered list of typed write operations all-or-nothing. Every operation
 * is validated and projected against the current disk state in memory
 * FIRST; only if every operation passes does the core commit them, in
 * order. The first invalid operation aborts with a typed
 * {@link WriteBatchError} that names the offending operation index, and
 * no disk write happens - so a later invalid operation never lets an
 * earlier one land.
 *
 * The core takes typed operations only; MCP layers map their request
 * params onto these types (no MCP shapes leak in here). The note write
 * operations reuse the exact create-note safety envelope
 * ({@link resolveNoteTarget}) and the atomic-write pipeline, so a
 * single-operation update or append that fails mid-write leaves its
 * target byte-identical.
 *
 * Atomicity model: this is validate-all-then-commit, matching the pinned
 * batch. Full multi-file rollback of a fault that strikes DURING the
 * commit phase (e.g. ENOSPC after the first of several files is written)
 * is not attempted - the guarantee is that a detectable-invalid operation
 * aborts the batch before ANY write. Each individual file write is atomic
 * (temp file + rename), so no single target is ever left half-written.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { CreateNoteError, createNote, resolveNoteTarget } from "./notes/create-note.ts";
import { refuseBlankOverwrite } from "./notes/blank-overwrite-guard.ts";
import {
  NOTE_WRITE_OP,
  recordNoteWrite,
  storeBeforeImage,
  type NoteWriteOp,
} from "./notes/write-record.ts";
import { formatFrontmatter, parseFrontmatterWithNotices } from "../vault.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import {
  appendApplyEvidence,
  type AppendApplyEvidenceInput,
  type AppendApplyEvidenceOptions,
} from "./apply-evidence.ts";
import { appendBrainNote, type AppendBrainNoteInput } from "./note.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { BRAIN_APPLY_RESULT } from "./types.ts";

/** Separator inserted between the existing body and appended text. */
const APPEND_SEPARATOR = "\n\n";

/**
 * Upper bound on operations in a single batch. Each committed operation
 * performs synchronous file I/O (read + atomic temp-file + rename), which
 * blocks the event loop for the duration of the whole batch; an unbounded
 * batch would let one caller stall the server. 100 is comfortably above any
 * legitimate batch while capping the worst-case blocking window.
 */
export const MAX_BATCH_OPERATIONS = 100;

/**
 * Create a new vault note. Refuses to clobber an existing file. Maps to
 * the {@link createNote} core writer.
 */
export interface CreateNoteOperation {
  readonly kind: "create_note";
  readonly path: string;
  readonly frontmatter?: FrontmatterMap;
  readonly content?: string;
}

/**
 * Update an EXISTING note: merge `frontmatter` keys into the current
 * frontmatter and/or replace the body with `body`. At least one of the
 * two must be present.
 */
export interface UpdateNoteOperation {
  readonly kind: "update_note";
  readonly path: string;
  readonly frontmatter?: FrontmatterMap;
  readonly body?: string;
  /**
   * Permit `body` to be blank, clearing the note's contents. Default
   * false: see {@link refuseBlankOverwrite}, which exists because an
   * accidentally-empty body is byte-identical to a deliberate clear.
   */
  readonly allowEmpty?: boolean;
}

/** Append `content` to the body of an EXISTING note. */
export interface AppendNoteOperation {
  readonly kind: "append_note";
  readonly path: string;
  readonly content: string;
}

/**
 * Record one apply-evidence event against a preference. Maps to the
 * {@link appendApplyEvidence} core writer; the kernel only pre-validates
 * so an invalid op aborts the batch before any commit.
 */
export interface ApplyEvidenceOperation {
  readonly kind: "apply_evidence";
  readonly input: AppendApplyEvidenceInput;
  readonly options?: AppendApplyEvidenceOptions;
}

/**
 * Append one narrative note line to today's Brain log. Maps to the
 * {@link appendBrainNote} core writer. `vault` is supplied by the batch.
 */
export interface AppendLogLineOperation {
  readonly kind: "append_log_line";
  readonly input: Omit<AppendBrainNoteInput, "vault">;
}

/** Typed operation the write-batch core understands. */
export type WriteOperation =
  | CreateNoteOperation
  | UpdateNoteOperation
  | AppendNoteOperation
  | ApplyEvidenceOperation
  | AppendLogLineOperation;

/** Machine-readable reason a write batch was refused. */
export type WriteBatchErrorCode =
  | "invalid_operation"
  | "invalid_path"
  | "excluded"
  | "outside_vault"
  | "exists"
  | "target_missing"
  // nothing-writes-silently, unit B. The target exists and the process
  // could not read it (a permission bit, a directory in its place, a
  // transient I/O fault, a file mid-sync). Until this code existed the
  // parser resolved that to `[{}, ""]` and the projection believed it:
  // an update then wrote the caller's body over an empty frontmatter
  // map and reported `updated: true`, and an append wrote just the
  // appended text over a body it never saw. Read failure is now a
  // refusal that names the path and the reason.
  | "target_unreadable"
  // nothing-writes-silently, unit B. The target was read and the
  // frontmatter scanner reported a line it could not express as a
  // key/value pair or a list item, so that line is absent from the parsed
  // map. Both update and append re-serialise that map over the file, so
  // proceeding would delete the line and answer `updated: true` - the
  // same loss `target_unreadable` refuses, on the half of the read the
  // parser DID manage. The operator's way through is to fix the
  // frontmatter the scanner names.
  | "target_frontmatter_lossy"
  // nothing-writes-silently, unit B. The update would replace a body
  // that carries text with a blank one. See
  // {@link refuseBlankOverwrite}; `allowEmpty` is the way through.
  | "blank_overwrite_refused"
  | "duplicate_target"
  | "too_many_operations"
  | "preference_not_found"
  // provenance-at-the-boundary, unit B. Propagated from the shared
  // create-note envelope by `envelopeError`, which preserves the
  // envelope's code rather than flattening every refusal into
  // `invalid_operation`. The check runs in the projection phase, so an
  // operation outside the operator's declared binding aborts the whole
  // batch before any commit - including the operations that WERE
  // admitted.
  | "write_binding"
  // provenance-at-the-boundary, unit C. Declared because
  // `envelopeError` preserves whatever code the shared create-note
  // envelope raises, so the two unions have to stay in step. Neither is
  // reachable from a batch today: `create_note` operations expose
  // neither the `strict` validator nor template-mode bodies, and they
  // are not going to. A batch is all-or-nothing, and per-operation
  // authoring modes - above all `if_exists: "skip"` - would make one
  // `applied` count mean two different things in one result list. The
  // batch keeps refusing an occupied target outright.
  | "invalid_document"
  | "invalid_template"
  // The vault's `Brain/_brain.yaml` exists and does not validate, so
  // neither the vault scope nor the write binding can be determined.
  // Propagated from the same envelope: no operation in the batch can be
  // projected, and the operator - not the caller - holds the fix.
  | "config_invalid";

/**
 * All-or-nothing failure for {@link applyWriteBatch}. Thrown during the
 * validate/project phase, before any commit, so the vault is guaranteed
 * unchanged. Carries the offending operation `index` (`-1` for
 * batch-level failures) and machine-readable `details` so an MCP layer
 * can surface a structured rejection.
 */
export class WriteBatchError extends Error {
  readonly code: WriteBatchErrorCode;
  readonly index: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: WriteBatchErrorCode,
    index: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WriteBatchError";
    this.code = code;
    this.index = index;
    this.details = details;
  }
}

/**
 * The audit half every note-write result carries (who-wrote-what, Task A).
 *
 * `write_id` names the `note-write` event that attributes the write; it is
 * null when the bytes landed and the event could not be appended, and in
 * that case - and only that case - `audit_reason` says why. The two travel
 * together so a caller can never read an unrecorded write as a recorded
 * one.
 */
export interface NoteWriteAudit {
  readonly write_id: string | null;
  readonly audit_reason?: string;
}

/** Per-operation outcome, discriminated by `kind`. */
export type WriteBatchOpResult =
  | ({
      readonly kind: "create_note";
      readonly path: string;
      readonly created: true;
    } & NoteWriteAudit)
  | ({
      readonly kind: "update_note";
      readonly path: string;
      readonly updated: true;
    } & NoteWriteAudit)
  | ({
      readonly kind: "append_note";
      readonly path: string;
      readonly appended: true;
    } & NoteWriteAudit)
  | { readonly kind: "apply_evidence"; readonly logged_at: string; readonly log_path: string }
  | { readonly kind: "append_log_line"; readonly logged_at: string; readonly log_path: string };

export interface WriteBatchResult {
  /** Number of operations committed (== operations.length on success). */
  readonly applied: number;
  /** One result per operation, in input order. */
  readonly results: ReadonlyArray<WriteBatchOpResult>;
  /** Terminal success marker: the batch committed, do not re-call. */
  readonly done: true;
}

/** A validated operation paired with the closure that commits it. */
interface PlannedOperation {
  readonly commit: () => WriteBatchOpResult;
}

/** Facts the kernel needs that are not part of any single operation. */
export interface ApplyWriteBatchOptions {
  /**
   * Config file that names the writing agent, for the note-write record
   * (who-wrote-what, Task A). Absent falls back to the shared discovery;
   * a caller that knows which config it runs under passes it so the
   * record names the agent the caller is.
   */
  readonly configPath?: string;
}

/**
 * Apply an ordered batch of write operations atomically. Validates and
 * projects every operation in memory first; only if all pass does it
 * commit them in order. The first invalid operation throws
 * {@link WriteBatchError} naming its index, before any disk write.
 */
export function applyWriteBatch(
  vault: string,
  operations: ReadonlyArray<WriteOperation>,
  opts: ApplyWriteBatchOptions = {},
): WriteBatchResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new WriteBatchError("invalid_operation", -1, "operations must be a non-empty array");
  }
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new WriteBatchError(
      "too_many_operations",
      -1,
      `a batch may contain at most ${MAX_BATCH_OPERATIONS} operations, got ${operations.length}`,
      { max: MAX_BATCH_OPERATIONS, count: operations.length },
    );
  }

  // A note target may appear at most once per batch: projecting each note
  // op against the pre-batch disk state means a second op on the same file
  // would silently clobber the first at commit time. Refuse it loudly.
  const noteTargets = new Set<string>();
  const planned: PlannedOperation[] = operations.map((operation, index) =>
    projectOperation(vault, operation, index, noteTargets, opts),
  );

  const results = planned.map((p) => p.commit());
  return { applied: operations.length, results, done: true };
}

function projectOperation(
  vault: string,
  operation: WriteOperation,
  index: number,
  noteTargets: Set<string>,
  opts: ApplyWriteBatchOptions,
): PlannedOperation {
  const kind = (operation as { readonly kind?: unknown } | null | undefined)?.kind;
  switch (kind) {
    case "create_note":
      return projectCreateNote(vault, operation as CreateNoteOperation, index, noteTargets, opts);
    case "update_note":
      return projectUpdateNote(vault, operation as UpdateNoteOperation, index, noteTargets, opts);
    case "append_note":
      return projectAppendNote(vault, operation as AppendNoteOperation, index, noteTargets, opts);
    case "apply_evidence":
      return projectApplyEvidence(vault, operation as ApplyEvidenceOperation, index);
    case "append_log_line":
      return projectAppendLogLine(vault, operation as AppendLogLineOperation, index);
    default:
      throw new WriteBatchError(
        "invalid_operation",
        index,
        `operation ${index}: unknown kind '${String(kind)}'`,
      );
  }
}

/**
 * Translate a {@link CreateNoteError} from the shared safety envelope
 * into an index-bearing {@link WriteBatchError}, preserving the code.
 */
function envelopeError(err: unknown, index: number): WriteBatchError {
  if (err instanceof CreateNoteError) {
    return new WriteBatchError(err.code, index, `operation ${index}: ${err.message}`);
  }
  return new WriteBatchError(
    "invalid_operation",
    index,
    `operation ${index}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Reserve a note target for this batch, refusing a duplicate. Returns the
 * resolved target so callers project against it.
 */
function reserveNoteTarget(
  vault: string,
  path: string,
  index: number,
  noteTargets: Set<string>,
): { readonly relPath: string; readonly abs: string } {
  let target;
  try {
    target = resolveNoteTarget(vault, path);
  } catch (err) {
    throw envelopeError(err, index);
  }
  if (noteTargets.has(target.abs)) {
    throw new WriteBatchError(
      "duplicate_target",
      index,
      `operation ${index}: note ${target.relPath} is already targeted earlier in this batch`,
      { path: target.relPath },
    );
  }
  noteTargets.add(target.abs);
  return target;
}

function projectCreateNote(
  vault: string,
  op: CreateNoteOperation,
  index: number,
  noteTargets: Set<string>,
  opts: ApplyWriteBatchOptions,
): PlannedOperation {
  const target = reserveNoteTarget(vault, op.path, index, noteTargets);
  // Pre-check existence so a clobber aborts the batch before any commit.
  // The commit still goes through the exclusive create-note writer, whose
  // link(2) exclusivity closes the residual TOCTOU race race-free.
  if (existsSync(target.abs)) {
    throw new WriteBatchError(
      "exists",
      index,
      `operation ${index}: note already exists: ${target.relPath}`,
      { path: target.relPath },
    );
  }
  return {
    commit: () => {
      try {
        const res = createNote(vault, {
          path: op.path,
          ...(op.frontmatter !== undefined ? { frontmatter: op.frontmatter } : {}),
          ...(op.content !== undefined ? { content: op.content } : {}),
          ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
        });
        if (res.outcome !== "created") {
          // Unreachable by construction: the batch exposes none of the
          // authoring modes, so `ifExists` is never sent and an occupied
          // target is a refusal rather than a skip. Named rather than
          // cast, because a cast would report `created: true` for a call
          // that created nothing.
          throw new WriteBatchError(
            "exists",
            index,
            `operation ${index}: note already exists: ${res.path}`,
            { path: res.path },
          );
        }
        // The create writer records its own event, so the batch carries
        // its receipt through rather than appending a second one.
        return {
          kind: "create_note",
          path: res.path,
          created: true,
          write_id: res.write_id,
          ...(res.audit_reason !== undefined ? { audit_reason: res.audit_reason } : {}),
        };
      } catch (err) {
        throw envelopeError(err, index);
      }
    },
  };
}

function projectUpdateNote(
  vault: string,
  op: UpdateNoteOperation,
  index: number,
  noteTargets: Set<string>,
  opts: ApplyWriteBatchOptions,
): PlannedOperation {
  if (op.frontmatter === undefined && op.body === undefined) {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: update_note requires 'frontmatter' or 'body'`,
    );
  }
  const target = reserveNoteTarget(vault, op.path, index, noteTargets);
  const state = readExistingNote(target.abs, target.relPath, index);
  // The one seam the blank-overwrite guard is wired at - it covers both
  // callers, `brain_update_note` and `brain_write_batch`'s update op,
  // because both project through here.
  if (
    op.body !== undefined &&
    refuseBlankOverwrite({
      existingBody: state.body,
      nextBody: op.body,
      allowEmpty: op.allowEmpty === true,
    })
  ) {
    throw new WriteBatchError(
      "blank_overwrite_refused",
      index,
      `operation ${index}: refusing to replace the body of ${target.relPath} with an empty ` +
        "one; pass allow_empty to clear the note deliberately",
      { path: target.relPath },
    );
  }
  const frontmatter =
    op.frontmatter !== undefined ? { ...state.frontmatter, ...op.frontmatter } : state.frontmatter;
  const body = op.body !== undefined ? op.body : state.body;
  const contents = formatFrontmatter(frontmatter, body);
  return {
    commit: () => {
      const audit = commitNoteRewrite(
        vault,
        target,
        state.raw,
        contents,
        NOTE_WRITE_OP.update,
        opts,
      );
      return { kind: "update_note", path: target.relPath, updated: true, ...audit };
    },
  };
}

function projectAppendNote(
  vault: string,
  op: AppendNoteOperation,
  index: number,
  noteTargets: Set<string>,
  opts: ApplyWriteBatchOptions,
): PlannedOperation {
  if (typeof op.content !== "string" || op.content.trim().length === 0) {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: append_note requires non-empty 'content'`,
    );
  }
  const target = reserveNoteTarget(vault, op.path, index, noteTargets);
  const state = readExistingNote(target.abs, target.relPath, index);
  const appended = op.content.trim();
  const body = state.body.length > 0 ? `${state.body}${APPEND_SEPARATOR}${appended}` : appended;
  const contents = formatFrontmatter(state.frontmatter, body);
  return {
    commit: () => {
      const audit = commitNoteRewrite(
        vault,
        target,
        state.raw,
        contents,
        NOTE_WRITE_OP.append,
        opts,
      );
      return { kind: "append_note", path: target.relPath, appended: true, ...audit };
    },
  };
}

/**
 * Commit one note rewrite and attribute it, in the order the design
 * fixes: keep the bytes this write replaces, write, record.
 *
 * The image goes FIRST because it is the only copy of the prior content
 * that survives the rename - a process that dies between the rename and
 * the record loses the audit line, which is recoverable, rather than the
 * bytes, which are not. The record goes LAST and cannot fail the write:
 * `recordNoteWrite` returns its failure, and this returns it too.
 */
function commitNoteRewrite(
  vault: string,
  target: { readonly relPath: string; readonly abs: string },
  before: string,
  contents: string,
  op: NoteWriteOp,
  opts: ApplyWriteBatchOptions,
): NoteWriteAudit {
  mkdirSync(dirname(target.abs), { recursive: true });
  storeBeforeImage(vault, before);
  atomicWriteFileSync(target.abs, contents);
  return recordNoteWrite(vault, {
    op,
    target: target.relPath,
    before: { bytes: before },
    after: { bytes: contents },
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
}

/** Accepted apply-evidence result values, for phase-1 validation. */
const APPLY_RESULTS: ReadonlySet<string> = new Set([
  BRAIN_APPLY_RESULT.applied,
  BRAIN_APPLY_RESULT.violated,
  BRAIN_APPLY_RESULT.outdated,
]);

/**
 * Project an apply_evidence operation. Pre-validates the required fields,
 * the result enum, and the target preference's existence so an invalid
 * op aborts the batch before any commit. The commit delegates to the
 * {@link appendApplyEvidence} core writer, which re-validates and renders
 * the log event - the kernel does not reimplement it.
 */
function projectApplyEvidence(
  vault: string,
  op: ApplyEvidenceOperation,
  index: number,
): PlannedOperation {
  const input = op.input;
  if (input === null || typeof input !== "object") {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: missing evidence input`,
    );
  }
  const prefId = typeof input.pref_id === "string" ? input.pref_id.trim() : "";
  if (prefId === "") {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: apply_evidence requires pref_id`,
    );
  }
  if (typeof input.artifact !== "string" || input.artifact.trim() === "") {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: apply_evidence requires artifact`,
    );
  }
  if (typeof input.agent !== "string" || input.agent.trim() === "") {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: apply_evidence requires agent`,
    );
  }
  if (!APPLY_RESULTS.has(input.result)) {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: apply_evidence result must be applied, violated, or outdated`,
    );
  }
  // Existence pre-check mirrors appendApplyEvidence's own resolution so a
  // missing preference aborts the whole batch before any write happens.
  const slug = prefId.startsWith("pref-") ? prefId.slice("pref-".length) : prefId;
  try {
    validateSlug(slug);
  } catch (err) {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!existsSync(preferencePath(vault, slug))) {
    throw new WriteBatchError(
      "preference_not_found",
      index,
      `operation ${index}: preference not found: pref-${slug}`,
      { pref_id: `pref-${slug}` },
    );
  }
  return {
    commit: () => {
      const res = appendApplyEvidence(vault, input, op.options ?? {});
      return { kind: "apply_evidence", logged_at: res.logged_at, log_path: res.log_path };
    },
  };
}

/**
 * Project an append_log_line operation. Pre-validates that the text is a
 * non-empty string; the commit delegates to the {@link appendBrainNote}
 * core writer.
 */
function projectAppendLogLine(
  vault: string,
  op: AppendLogLineOperation,
  index: number,
): PlannedOperation {
  const input = op.input;
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.text !== "string" ||
    input.text.trim() === ""
  ) {
    throw new WriteBatchError(
      "invalid_operation",
      index,
      `operation ${index}: append_log_line requires non-empty text`,
    );
  }
  return {
    commit: () => {
      const res = appendBrainNote({ vault, ...input });
      return { kind: "append_log_line", logged_at: res.logged_at, log_path: res.log_path };
    },
  };
}

interface ExistingNote {
  readonly frontmatter: FrontmatterMap;
  readonly body: string;
  /**
   * The target's bytes exactly as they sit on disk (who-wrote-what,
   * Task A).
   *
   * Not `formatFrontmatter(frontmatter, body)`: the before-image and the
   * `hash_before` have to describe what a revert would put BACK, and a
   * re-serialisation of the parsed halves is what this build would have
   * written, not what the previous writer did. Key order, spacing and a
   * hand-edited block all survive here and would not survive there.
   */
  readonly raw: string;
}

/** Attribution for the frontmatter notices this reader inspects. */
const READ_EXISTING_NOTE_SITE = "brain.write-batch.read-existing-note";

/**
 * Read and parse an existing note, or throw a typed error naming which
 * of the two ways it was unavailable. update and append only touch
 * notes that already exist.
 *
 * An UNREADABLE file raises rather than resolving to an empty note. The
 * two-tuple `parseFrontmatter` reports a read failure as `[{}, ""]` -
 * correct for the fail-soft walkers it was written for, and fatal here,
 * because this result is the base of a read-modify-write: an update
 * would write the caller's body under an empty frontmatter map and an
 * append would write its text over a body nobody read, both reporting
 * success. The projection runs before any commit, so raising leaves the
 * file byte-identical.
 *
 * A DROPPED frontmatter line raises for the same reason. The parse
 * succeeded, and the scanner reported by name a line it could not
 * express; the callers below re-serialise the parsed map with
 * `formatFrontmatter`, so that line would be deleted from disk by a
 * write the caller never asked to touch it - a frontmatter-only update
 * that answers `updated: true` while removing a field it never mentioned.
 * Both notices come off the same parse, and both mean the same thing:
 * part of the content this write would replace is unknown to it.
 */
function readExistingNote(abs: string, relPath: string, index: number): ExistingNote {
  if (!existsSync(abs)) {
    throw new WriteBatchError(
      "target_missing",
      index,
      `operation ${index}: note does not exist: ${relPath}`,
      { path: relPath },
    );
  }
  const [frontmatter, body, notices] = parseFrontmatterWithNotices(abs, {
    site: READ_EXISTING_NOTE_SITE,
  });
  const unreadable = notices.find((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable);
  if (unreadable !== undefined) {
    throw new WriteBatchError(
      "target_unreadable",
      index,
      `operation ${index}: note ${relPath} exists but could not be read ` +
        `(${unreadable.detail}), so the content this write would replace is unknown`,
      { path: relPath, reason: unreadable.detail },
    );
  }
  const dropped = notices.filter((n) => n.code === DEGRADATION_CODE.frontmatterLineDropped);
  if (dropped.length > 0) {
    const reason = dropped.map((n) => n.detail).join("; ");
    throw new WriteBatchError(
      "target_frontmatter_lossy",
      index,
      `operation ${index}: note ${relPath} has frontmatter this build cannot round-trip ` +
        `(${reason}), and rewriting it would delete those lines`,
      { path: relPath, reason },
    );
  }
  // Read after the parse rather than before it: the two notices above
  // are the named ways this file can be unavailable, and a raw read that
  // ran first would have to invent a third.
  return { frontmatter: { ...frontmatter }, body, raw: readFileSync(abs, "utf8") };
}
