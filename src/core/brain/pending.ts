/**
 * Write-approval pending queue (A3 / t_e540b093; write-side trust Task 9).
 *
 * When the signals lane of the write-approval gate is on, extracted
 * signals are STAGED into `Brain/pending/` instead of `Brain/inbox/` (the
 * frontmatter document is byte-for-byte identical - staging is purely a
 * change of directory). An operator then reviews the queue:
 *
 *   - {@link listPending}    enumerate staged signals;
 *   - {@link applyPending}   move a staged file into `Brain/inbox/` UNCHANGED
 *                            (entity anchors and dedup hash preserved verbatim -
 *                            they were resolved at extraction time), or, with
 *                            `dryRun`, report the move and write nothing;
 *   - {@link rejectPending}  move a staged file into `Brain/retired/` with
 *                            retire-shaped frontmatter (`_status`, `retired_at`,
 *                            `retired_reason`), following the retire conventions.
 *
 * Applying or rejecting a missing / already-processed id raises the typed
 * {@link PendingSignalNotFoundError}; it is never a silent no-op.
 *
 * The document schema is unchanged - staging and applying reuse the exact
 * signal file that `writeSignal` produces.
 *
 * Since the multi-lane queue (Task 9) the LISTING, APPLY and REJECT
 * engines live in `./pending/pending-lanes.ts` and this module is the
 * historical import surface: same exports, same id grammar, same
 * behaviour for `sig-` ids, with the `note-` and `ing-` lanes sharing
 * the engine.
 */

import { brainDirsForWrite } from "./paths.ts";
import { writeSignal, type WriteSignalInput } from "./signal.ts";
import type { BrainSignal } from "./types.ts";
import {
  WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  WRITE_APPROVAL_ENABLED_ENV_KEY,
  REVIEW_LANE,
  resolveWriteApprovalLane,
} from "./write-gate.ts";
import {
  InvalidPendingIdError,
  PendingApplyConflictError,
  PendingSignalNotFoundError,
  applyPendingLane,
  listPendingLane,
  rejectPendingLane,
} from "./pending/pending-lanes.ts";

/**
 * The queue's typed errors and id grammar moved to the lanes engine
 * (Task 9); re-exported here so every existing import path keeps
 * resolving.
 */
export { InvalidPendingIdError, PendingApplyConflictError, PendingSignalNotFoundError };

/**
 * Config key / env twin for the opt-in write-approval queue (default off).
 * Declared in `write-gate.ts` beside the per-lane keys and re-exported here
 * so the historical import path keeps working.
 */
export { WRITE_APPROVAL_ENABLED_CONFIG_KEY, WRITE_APPROVAL_ENABLED_ENV_KEY };

/**
 * Resolve the write-approval toggle (env wins over config file).
 *
 * The signals lane of the write-side-trust gate - the master key IS the
 * signals key, so this is `resolveWriteApprovalLane("signals")` spelled
 * the way every existing caller imports it. Default OFF: absent / any
 * non-`true` value keeps the direct-to-inbox behaviour byte-for-byte.
 */
export function resolveWriteApprovalEnabled(configPath?: string): boolean {
  return resolveWriteApprovalLane("signals", configPath);
}

/** One staged signal: its id, absolute path, and parsed frontmatter. */
export interface PendingEntry {
  readonly id: string;
  readonly path: string;
  readonly signal: BrainSignal;
}

export interface StageResult {
  readonly id: string;
  readonly path: string;
}

/**
 * Stage a signal into `Brain/pending/`. Delegates to {@link writeSignal} with
 * the pending directory as the target so the staged document is byte-for-byte
 * identical to what the inbox would have received.
 */
export function stagePendingSignal(vault: string, input: WriteSignalInput): StageResult {
  const res = writeSignal(vault, input, { targetDir: brainDirsForWrite(vault).pending });
  return { id: res.id, path: res.path };
}

/**
 * List the staged signals in `Brain/pending/`, sorted by id. Delegates to
 * the lanes engine; corrupt files are partitioned as unreadable there, so
 * this historical surface keeps skipping them.
 */
export function listPending(vault: string): PendingEntry[] {
  const out: PendingEntry[] = [];
  for (const entry of listPendingLane(vault, REVIEW_LANE.signals).entries) {
    if (entry.signal !== undefined)
      out.push({ id: entry.id, path: entry.path, signal: entry.signal });
  }
  return out;
}

export interface PendingApplyOptions {
  /** True previews the move and writes nothing; false performs it. */
  readonly dryRun?: boolean;
}

export interface PendingApplyResult extends StageResult {
  /** True when this was a preview and nothing moved. */
  readonly dryRun: boolean;
}

/**
 * Apply a staged signal: move it into `Brain/inbox/` UNCHANGED. The bytes are
 * copied verbatim (anchors + dedup hash preserved) and the pending copy is
 * removed only after the inbox copy lands. A missing id is a typed error.
 *
 * `dryRun` reports the move and writes nothing (no-dead-ends, task 11).
 * The preview runs every check the apply runs - id shape, staged file
 * present, destination free - and stops before the two calls that touch
 * disk, so the report it gives is the move the apply would make rather
 * than a guess at it. Delegates to {@link applyPendingLane}.
 */
export function applyPending(
  vault: string,
  id: string,
  opts: PendingApplyOptions = {},
): PendingApplyResult {
  return applyPendingLane(vault, id, opts);
}

export interface RejectPendingOptions {
  /** Injected clock for a deterministic `retired_at`. Defaults to now. */
  readonly now?: Date;
}

/**
 * Reject a staged signal: move it into `Brain/retired/` with retire-shaped
 * frontmatter (`_status: "retired"`, `retired_at`, `retired_reason`), keeping
 * the original signal fields for the audit trail. A missing id is a typed
 * error. The `brain/signal` tag is swapped for `brain/retired` so the moved
 * file reads as a retired artifact, and the queue stamps `osb_pending_lane`
 * with the lane the entry came from. Delegates to {@link rejectPendingLane}.
 */
export function rejectPending(
  vault: string,
  id: string,
  reason: string,
  opts: RejectPendingOptions = {},
): StageResult {
  return rejectPendingLane(vault, id, reason, opts);
}
