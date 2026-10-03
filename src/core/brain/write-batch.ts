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

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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
import { writePathAdvisoryField, type WritePathAdvisoryField } from "./write-path-advisory.ts";
import {
  appendApplyEvidence,
  isApplyEvidenceTargetPresent,
  type AppendApplyEvidenceInput,
  type AppendApplyEvidenceOptions,
} from "./apply-evidence.ts";
import { appendBrainNote, type AppendBrainNoteInput } from "./note.ts";
import { ORIGIN_CHANNEL_FIELD } from "../origin-channel.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { BRAIN_APPLY_RESULT } from "./types.ts";
import {
  computePayloadHash,
  IdempotencyPayloadMismatchError,
  lookupKey,
  REMEMBER_KEY_STATUS,
  rememberKey,
  type RememberKeyStatus,
} from "./idempotency-ledger.ts";

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
 * The idempotency-ledger key space of write-batch request IDs. Request IDs
 * come from a different client vocabulary than the `idempotency_key` of
 * brain_feedback and apply-evidence, so they live in their own namespace:
 * the same string supplied to both tools never collides.
 */
const WRITE_BATCH_KEY_NAMESPACE = "write_batch";

/**
 * What a request receipt says about the call that returned it:
 * - `applied`: this call committed the batch and recorded the ID.
 * - `duplicate`: the ID was already recorded with the same payload; this
 *   call wrote nothing and every other result field is the retained
 *   receipt of the call that committed.
 * - `concurrent_duplicate`: this call committed the batch, but a concurrent
 *   call recorded the same ID with the same payload between this call's
 *   consult and its record. Both calls' writes landed; the result fields
 *   are this call's own.
 * - `payload_conflict`: this call committed the batch - its writes landed
 *   and the result fields are this call's own - but a concurrent call
 *   recorded the same ID with a DIFFERENT payload between this call's
 *   consult and its record. The ID stays bound to that other payload, so
 *   this call's receipt was not recorded and a retry under the same ID is
 *   refused as a mismatch. Never retry this batch under a new ID: it is
 *   already applied.
 */
export const WRITE_BATCH_RECEIPT_STATUS = Object.freeze({
  applied: "applied",
  duplicate: "duplicate",
  concurrent_duplicate: "concurrent_duplicate",
  payload_conflict: "payload_conflict",
} as const);

export type WriteBatchReceiptStatus =
  (typeof WRITE_BATCH_RECEIPT_STATUS)[keyof typeof WRITE_BATCH_RECEIPT_STATUS];

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
  // refusal that names the path and the reason. On Windows it also
  // covers a note carrying the read-only attribute, which the rewrite's
  // rename could not replace (see `refuseReadOnlyAttribute`).
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
  // The caller's frontmatter names a key the server owns. `visibility`
  // is the read-boundary token field (private-is-not-a-suggestion), and
  // `origin_channel` is the server-derived transport stamp that creation
  // writes and mutation deliberately never re-stamps. The update merge
  // is `{...existing, ...caller}` - caller wins - so leaving these keys
  // free would let one update demote a private page out of the boundary
  // or forge the creating channel. The operator edits them in the file,
  // where the boundary's authority lives.
  | "reserved_frontmatter_key"
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

/**
 * The advisory half every note-write result MAY carry (p4
 * silent-failure-hardening, Task 3): the absolute home paths the call's
 * authored content embeds. Byte-identical-when-absent - the key is simply
 * not there for a clean write - and never a refusal: the write lands and
 * the receipt says what it embeds. Log-line and evidence ops author no
 * note content and never carry it.
 */
export type NoteWriteAdvisory = WritePathAdvisoryField;

/**
 * Per-operation outcome, discriminated by `kind`.
 *
 * The update and append arms split on their flag so a caller cannot read
 * a write that did not happen as one that did: `updated: true` /
 * `appended: true` always carry the audit half (an id, or null plus the
 * reason there is none), while the `false` arms carry no audit fields at
 * all - a skipped write stored no before-image and recorded no event, so
 * there is no null that could be mistaken for a lost one, the same shape
 * the create skip spells. Both arms carry the advisory: the caller
 * authored that content either way.
 */
export type WriteBatchOpResult =
  | ({
      readonly kind: "create_note";
      readonly path: string;
      readonly created: true;
    } & NoteWriteAudit &
      NoteWriteAdvisory)
  | ({
      readonly kind: "update_note";
      readonly path: string;
      readonly updated: true;
    } & NoteWriteAudit &
      NoteWriteAdvisory)
  | ({
      readonly kind: "update_note";
      readonly path: string;
      /** The target already held these bytes; nothing was written. */
      readonly updated: false;
    } & NoteWriteAdvisory)
  | ({
      readonly kind: "append_note";
      readonly path: string;
      readonly appended: true;
    } & NoteWriteAudit &
      NoteWriteAdvisory)
  | ({
      readonly kind: "append_note";
      readonly path: string;
      /** The target already held the would-be result; nothing was written. */
      readonly appended: false;
    } & NoteWriteAdvisory)
  | { readonly kind: "apply_evidence"; readonly logged_at: string; readonly log_path: string }
  | { readonly kind: "append_log_line"; readonly logged_at: string; readonly log_path: string };

export interface WriteBatchResult {
  /** Number of operations committed (== operations.length on success). */
  readonly applied: number;
  /** One result per operation, in input order. */
  readonly results: ReadonlyArray<WriteBatchOpResult>;
  /** Terminal success marker: the batch committed, do not re-call. */
  readonly done: true;
  /**
   * Present exactly when the caller supplied a request ID (see
   * {@link ReceiptedWriteBatchResult}); {@link WRITE_BATCH_RECEIPT_STATUS}
   * names what each status means.
   */
  readonly receipt?: WriteBatchReceipt;
}

/** The request-receipt block a caller-supplied request ID adds to a result. */
export interface WriteBatchReceipt {
  readonly requestId: string;
  readonly status: WriteBatchReceiptStatus;
}

/** A batch result for a call that supplied a request ID: the receipt is always there. */
export type ReceiptedWriteBatchResult = WriteBatchResult & { readonly receipt: WriteBatchReceipt };

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
  /**
   * Client-supplied request ID (t_b34439d9). Supplied, the batch consults
   * the idempotency ledger BEFORE any validation or write: the same ID with
   * the same semantic payload returns the retained original receipt marked
   * `duplicate`; the same ID with a different payload throws the ledger's
   * own {@link IdempotencyPayloadMismatchError}; an unseen ID proceeds and
   * records the receipt after the commit - the sequencing
   * {@link import('./signal.ts').writeSignal} already ships. A concurrent
   * record of the same ID found only after the commit becomes a receipt
   * status on the committed result (see {@link WRITE_BATCH_RECEIPT_STATUS}).
   * Absent, behavior is byte-identical. Validation of the ID itself is the
   * ledger's (non-empty, bounded length), so an invalid ID surfaces the
   * ledger's named {@link import('./idempotency-ledger.ts').IdempotencyKeyError}
   * before any write.
   */
  readonly requestId?: string;
  /**
   * May the caller read the existing note at this vault-relative path?
   * An update or append whose target it may not read is refused as
   * `target_missing`, the refusal a path with no note gets, before the
   * note is read or any other check runs on it. Absent, every existing
   * note is a target (the CLI, which reads the vault directly).
   */
  readonly readable?: (rel: string) => boolean;
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
  opts: ApplyWriteBatchOptions & { readonly requestId: string },
): ReceiptedWriteBatchResult;
export function applyWriteBatch(
  vault: string,
  operations: ReadonlyArray<WriteOperation>,
  opts?: ApplyWriteBatchOptions,
): WriteBatchResult;
export function applyWriteBatch(
  vault: string,
  operations: ReadonlyArray<WriteOperation>,
  opts: ApplyWriteBatchOptions = {},
): WriteBatchResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // The batch's shape is checked first: the request-ID consult hashes the
  // operations, and a non-array must surface as the named batch error, not
  // as whatever the hashing throws.
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
  // The request-ID consult sits before any per-operation validation: a
  // duplicate must never re-validate (the original already passed) and an
  // invalid ID must surface before anything is written.
  const requestId = opts.requestId;
  const idempotency =
    requestId === undefined ? undefined : consultBatchKey(vault, requestId, operations);
  if (idempotency?.retained !== undefined) return idempotency.retained;

  // A note target may appear at most once per batch: projecting each note
  // op against the pre-batch disk state means a second op on the same file
  // would silently clobber the first at commit time. Refuse it loudly.
  const noteTargets = new Set<string>();
  const planned: PlannedOperation[] = operations.map((operation, index) =>
    projectOperation(vault, operation, index, noteTargets, opts),
  );

  const results = planned.map((p) => p.commit());
  const result: WriteBatchResult = { applied: operations.length, results, done: true };
  if (idempotency !== undefined && requestId !== undefined) {
    // Record AFTER the commit so a sequential retry dedupes against a
    // durable receipt. `rememberKey` re-checks under its shard lock; the
    // residual crash window between commit and record is the one the
    // ledger documents for every writer that follows this pattern.
    const stored: Readonly<Record<string, unknown>> = {
      applied: result.applied,
      results: result.results.map((opResult) => storedOpResult(vault, opResult)),
      done: result.done,
    };
    const remembered = rememberKey(vault, {
      key: requestId,
      namespace: WRITE_BATCH_KEY_NAMESPACE,
      contentHash: idempotency.contentHash,
      ref: stored,
    });
    // The unlocked consult above can miss a concurrent call's record; the
    // locked re-check's verdict is acted on, never dropped. Either way this
    // call's writes have landed, so the verdict is a receipt status on the
    // committed result, never an error that would read as "nothing
    // written" and invite a second application under a fresh ID.
    return { ...result, receipt: { requestId, status: RECEIPT_STATUS_FOR[remembered.status] } };
  }
  return result;
}

/** The receipt status of a committed batch, by the locked re-check's verdict. */
const RECEIPT_STATUS_FOR: Readonly<Record<RememberKeyStatus, WriteBatchReceiptStatus>> =
  Object.freeze({
    [REMEMBER_KEY_STATUS.inserted]: WRITE_BATCH_RECEIPT_STATUS.applied,
    [REMEMBER_KEY_STATUS.duplicate_match]: WRITE_BATCH_RECEIPT_STATUS.concurrent_duplicate,
    [REMEMBER_KEY_STATUS.payload_mismatch]: WRITE_BATCH_RECEIPT_STATUS.payload_conflict,
  });

/**
 * One op result as the durable receipt stores it. The ledger is vault
 * content that syncs to every device, so a log path is stored
 * vault-relative - the form apply-evidence keeps for its own receipt -
 * and never as this machine's absolute path. Note results already name
 * vault-relative paths.
 */
function storedOpResult(vault: string, opResult: WriteBatchOpResult): WriteBatchOpResult {
  if (opResult.kind !== "apply_evidence") return opResult;
  return { ...opResult, log_path: relative(vault, opResult.log_path) };
}

/** Inverse of {@link storedOpResult}: the log path rebuilt under the vault serving the retry. */
function retainedOpResult(vault: string, opResult: WriteBatchOpResult): WriteBatchOpResult {
  if (opResult.kind !== "apply_evidence") return opResult;
  return { ...opResult, log_path: join(vault, opResult.log_path) };
}

/**
 * The pre-write consult for a caller-supplied request ID. Returns the hash
 * the batch must record after a successful commit; when the ID is already
 * in the ledger, `retained` carries the outcome instead - the stored
 * receipt marked `duplicate` for a matching payload, or nothing after the
 * mismatch error propagates.
 */
function consultBatchKey(
  vault: string,
  requestId: string,
  operations: ReadonlyArray<WriteOperation>,
): { readonly contentHash: string; readonly retained?: ReceiptedWriteBatchResult } {
  const contentHash = computePayloadHash({ operations: [...operations] });
  const existing = lookupKey(vault, requestId, WRITE_BATCH_KEY_NAMESPACE);
  if (existing === null) return { contentHash };
  if (existing.contentHash !== contentHash) {
    throw new IdempotencyPayloadMismatchError(requestId, existing.contentHash, contentHash);
  }
  const ref = existing.ref as WriteBatchResult | undefined;
  if (
    ref === undefined ||
    typeof ref !== "object" ||
    ref.applied === undefined ||
    !Array.isArray(ref.results) ||
    ref.done !== true
  ) {
    // The ledger cannot answer for a key whose stored receipt is not a
    // batch receipt. Refusing by name beats inventing an empty result that
    // would tell the caller the batch applied when nothing did.
    throw new WriteBatchError(
      "invalid_operation",
      -1,
      `request id '${requestId}' is already recorded without a readable write-batch receipt`,
    );
  }
  return {
    contentHash,
    retained: {
      ...ref,
      results: ref.results.map((opResult) => retainedOpResult(vault, opResult)),
      receipt: { requestId, status: WRITE_BATCH_RECEIPT_STATUS.duplicate },
    },
  };
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
      return projectApplyEvidence(vault, operation as ApplyEvidenceOperation, index, opts.readable);
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
        // its receipt through rather than appending a second one. The
        // advisory was computed in the projection from the authored
        // content; it advises, it never refuses.
        return {
          kind: "create_note",
          path: res.path,
          created: true,
          write_id: res.write_id,
          ...(res.audit_reason !== undefined ? { audit_reason: res.audit_reason } : {}),
          ...writePathAdvisoryField(op.content, res.path),
        };
      } catch (err) {
        throw envelopeError(err, index);
      }
    },
  };
}

/**
 * Frontmatter keys a caller-named UPDATE may not set. Both are read as
 * boundary state, not note content: `visibility` carries the page's
 * read-scope tokens (the reserved `private` among them), and
 * `origin_channel` is the server-derived stamp creation writes once and
 * mutation never rewrites. Creation needs no guard - the server stamp is
 * merged last there and wins - but the update merge inverts the order,
 * so the guard lives at the merge.
 */
const RESERVED_UPDATE_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "visibility",
  ORIGIN_CHANNEL_FIELD,
]);

/** The first reserved key the caller's map names, or `null`. */
function reservedFrontmatterKey(frontmatter: FrontmatterMap | undefined): string | null {
  if (frontmatter === undefined) return null;
  for (const key of Object.keys(frontmatter)) {
    if (RESERVED_UPDATE_FRONTMATTER_KEYS.has(key)) return key;
  }
  return null;
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
  const state = readExistingNote(target.abs, target.relPath, index, opts.readable);
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
  // The reserved-key guard rides the same seam: the merge below lets the
  // caller's map win over the file's, so a boundary key arriving here
  // would silently rewrite it.
  const reservedKey = reservedFrontmatterKey(op.frontmatter);
  if (reservedKey !== null) {
    throw new WriteBatchError(
      "reserved_frontmatter_key",
      index,
      `operation ${index}: frontmatter key "${reservedKey}" is reserved and cannot be set ` +
        `through an update of ${target.relPath}; edit the note directly`,
      { path: target.relPath, key: reservedKey },
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
      // The flag is the write's own verdict, not a hardcoded success: a
      // byte-identical re-apply skipped the write and says so, carrying
      // no audit half because nothing was recorded.
      if (audit.wrote) {
        const { write_id, audit_reason } = audit;
        return {
          kind: "update_note",
          path: target.relPath,
          updated: true,
          write_id,
          ...(audit_reason !== undefined ? { audit_reason } : {}),
          // The caller's authored body, not the note's whole content: a
          // path already on disk was not this call's authorship.
          ...writePathAdvisoryField(op.body, target.relPath),
        };
      }
      return {
        kind: "update_note",
        path: target.relPath,
        updated: false,
        ...writePathAdvisoryField(op.body, target.relPath),
      };
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
  const state = readExistingNote(target.abs, target.relPath, index, opts.readable);
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
      // Honest for the same reason the update's flag is: a rewrite whose
      // bytes already sit on disk (a hand-edited note that already
      // contains the would-be result) wrote nothing and says so, with no
      // audit half because nothing was recorded.
      if (audit.wrote) {
        const { write_id, audit_reason } = audit;
        return {
          kind: "append_note",
          path: target.relPath,
          appended: true,
          write_id,
          ...(audit_reason !== undefined ? { audit_reason } : {}),
          // The appended text is the call's authorship; the body it
          // joined is not.
          ...writePathAdvisoryField(op.content, target.relPath),
        };
      }
      return {
        kind: "append_note",
        path: target.relPath,
        appended: false,
        ...writePathAdvisoryField(op.content, target.relPath),
      };
    },
  };
}

/**
 * What one note rewrite actually did: either it wrote, and carries the
 * audit half (`write_id`, plus `audit_reason` exactly when that id is
 * null), or it skipped a byte-identical target and carries nothing. The
 * split - rather than a boolean beside optional fields - is what keeps a
 * skipped write from ever spelling a null write_id that a caller could
 * mistake for a lost record.
 */
type CommittedNoteRewrite = ({ readonly wrote: true } & NoteWriteAudit) | { readonly wrote: false };

/**
 * Commit one note rewrite and attribute it: for a rewrite that changes
 * the bytes, keep the bytes it replaces, write, and record the event.
 *
 * The write runs with `skipIfUnchanged`, so a byte-identical re-apply
 * leaves the target untouched - no temp file, no rename, no mtime bump
 * for the recency and validity consumers to misread - and the returned
 * verdict is the one source of truth for what happened. A skipped write
 * stores no before-image (the prior bytes are still the bytes on disk;
 * an image would claim a replace that never occurred) and records no
 * note-write event (no audit line exists for a write that did not
 * happen).
 *
 * The order is the design's: image, then write, then record. Whether an
 * image is owed is decided up front (`before !== contents`), so the image
 * lands BEFORE the rename and a crash or a failed store never leaves the
 * prior bytes replaced without their copy - a retry would otherwise see
 * the new bytes, skip as unchanged and never reach the ledger. The store
 * is content-addressed and idempotent, so an image stored for a write
 * that `skipIfUnchanged` then skips (the target changed underneath to
 * the new bytes) is harmless.
 */
function commitNoteRewrite(
  vault: string,
  target: { readonly relPath: string; readonly abs: string },
  before: string,
  contents: string,
  op: NoteWriteOp,
  opts: ApplyWriteBatchOptions,
): CommittedNoteRewrite {
  if (before === contents) return { wrote: false };
  storeBeforeImage(vault, before);
  mkdirSync(dirname(target.abs), { recursive: true });
  const wrote = atomicWriteFileSync(target.abs, contents, { skipIfUnchanged: true });
  if (!wrote) return { wrote: false };
  const audit = recordNoteWrite(vault, {
    op,
    target: target.relPath,
    before: { bytes: before },
    after: { bytes: contents },
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  return { wrote: true, ...audit };
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
  readable: ((rel: string) => boolean) | undefined,
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
  // missing preference aborts the whole batch before any write happens. A
  // preference the caller may not read is answered as a missing one.
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
  if (!isApplyEvidenceTargetPresent(vault, preferencePath(vault, slug), readable)) {
    throw new WriteBatchError(
      "preference_not_found",
      index,
      `operation ${index}: preference not found: pref-${slug}`,
      { pref_id: `pref-${slug}` },
    );
  }
  return {
    commit: () => {
      const res = appendApplyEvidence(vault, input, {
        ...op.options,
        ...(readable !== undefined ? { readable } : {}),
      });
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
 * Windows arm of the permission refusal. Windows has no POSIX mode bits:
 * `chmod` and Explorer's "Read-only" box both set the one read-only
 * attribute, which Node reports as a mode without any write bit. Such a
 * note stays readable, so the unreadable-file notice never fires, but
 * the commit's atomic rename onto it then fails with a raw `EPERM` after
 * the before-image is already stored. Checking here keeps the POSIX
 * contract on both hosts: a note the process cannot rewrite for a
 * permission reason is refused as `target_unreadable` - the code the
 * POSIX `EACCES` read already produces, and an operator fault either way
 * - in the projection, before any commit. POSIX needs no arm: a 0444
 * file in a writable directory is legitimately replaced by the rename.
 */
function refuseReadOnlyAttribute(abs: string, relPath: string, index: number): void {
  if (process.platform !== "win32") return;
  let mode: number;
  try {
    mode = statSync(abs).mode;
  } catch {
    // The parse that follows names a stat/read failure itself.
    return;
  }
  if ((mode & 0o222) !== 0) return;
  const reason = "the file has the Windows read-only attribute";
  throw new WriteBatchError(
    "target_unreadable",
    index,
    `operation ${index}: note ${relPath} cannot be rewritten (${reason}); ` +
      "clear the attribute to let this write replace it",
    { path: relPath, reason },
  );
}

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
function readExistingNote(
  abs: string,
  relPath: string,
  index: number,
  readable: ((rel: string) => boolean) | undefined,
): ExistingNote {
  // A note the caller may not read is answered as a missing one, asked
  // first so no later check (read-only attribute, parse, reserved key)
  // can tell the two apart.
  if (readable?.(relPath) === false || !existsSync(abs)) {
    throw new WriteBatchError(
      "target_missing",
      index,
      `operation ${index}: note does not exist: ${relPath}`,
      { path: relPath },
    );
  }
  refuseReadOnlyAttribute(abs, relPath, index);
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
