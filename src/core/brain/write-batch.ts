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

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { CreateNoteError, createNote, resolveNoteTarget } from "./notes/create-note.ts";
import { formatFrontmatter, parseFrontmatter } from "../vault.ts";
import {
  appendApplyEvidence,
  type AppendApplyEvidenceInput,
  type AppendApplyEvidenceOptions,
} from "./apply-evidence.ts";
import { appendBrainNote, type AppendBrainNoteInput } from "./note.ts";
import { preferencePath, validateSlug } from "./paths.ts";
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
  | "duplicate_target"
  | "too_many_operations"
  | "preference_not_found";

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

/** Per-operation outcome, discriminated by `kind`. */
export type WriteBatchOpResult =
  | { readonly kind: "create_note"; readonly path: string; readonly created: true }
  | { readonly kind: "update_note"; readonly path: string; readonly updated: true }
  | { readonly kind: "append_note"; readonly path: string; readonly appended: true }
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

/**
 * Apply an ordered batch of write operations atomically. Validates and
 * projects every operation in memory first; only if all pass does it
 * commit them in order. The first invalid operation throws
 * {@link WriteBatchError} naming its index, before any disk write.
 */
export function applyWriteBatch(
  vault: string,
  operations: ReadonlyArray<WriteOperation>,
): WriteBatchResult {
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
    projectOperation(vault, operation, index, noteTargets),
  );

  const results = planned.map((p) => p.commit());
  return { applied: operations.length, results, done: true };
}

function projectOperation(
  vault: string,
  operation: WriteOperation,
  index: number,
  noteTargets: Set<string>,
): PlannedOperation {
  const kind = (operation as { readonly kind?: unknown } | null | undefined)?.kind;
  switch (kind) {
    case "create_note":
      return projectCreateNote(vault, operation as CreateNoteOperation, index, noteTargets);
    case "update_note":
      return projectUpdateNote(vault, operation as UpdateNoteOperation, index, noteTargets);
    case "append_note":
      return projectAppendNote(vault, operation as AppendNoteOperation, index, noteTargets);
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
        });
        return { kind: "create_note", path: res.path, created: true };
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
  const frontmatter =
    op.frontmatter !== undefined ? { ...state.frontmatter, ...op.frontmatter } : state.frontmatter;
  const body = op.body !== undefined ? op.body : state.body;
  const contents = formatFrontmatter(frontmatter, body);
  return {
    commit: () => {
      mkdirSync(dirname(target.abs), { recursive: true });
      atomicWriteFileSync(target.abs, contents);
      return { kind: "update_note", path: target.relPath, updated: true };
    },
  };
}

function projectAppendNote(
  vault: string,
  op: AppendNoteOperation,
  index: number,
  noteTargets: Set<string>,
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
      mkdirSync(dirname(target.abs), { recursive: true });
      atomicWriteFileSync(target.abs, contents);
      return { kind: "append_note", path: target.relPath, appended: true };
    },
  };
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
}

/**
 * Read and parse an existing note, or throw a typed `target_missing`
 * error. update and append only touch notes that already exist.
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
  const [frontmatter, body] = parseFrontmatter(abs);
  return { frontmatter: { ...frontmatter }, body };
}
