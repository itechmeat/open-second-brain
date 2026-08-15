/**
 * Restore the preference section of a bank bundle (Brain Portability &
 * Interop suite, Unit E2).
 *
 * The bundle carried preferences from the day it shipped and reported
 * them as a count, because "preferences have a delicate confidence /
 * audit lifecycle" that a naive restore would flatten. That reasoning
 * was right about the hazard and wrong about the conclusion: the
 * lifecycle has an owner. {@link writePreferenceTxn} is the documented
 * single chokepoint for every preference write - it takes the lock,
 * re-reads the record inside it, runs the expectations chain, stamps
 * `_content_hash` on promotion, bumps `_revision` only when bytes
 * change, appends edit history and appends the audit line. Restoring
 * THROUGH it maintains the lifecycle instead of overwriting it.
 *
 * Three decisions shape this module:
 *
 *   1. **Conflicts are decided by revision, never by import order.**
 *      Each row is written under {@link noRevisionRewind}, so a bundle
 *      that is behind the vault is refused and a divergence at an equal
 *      revision is refused. Reversing the row order cannot change any
 *      outcome.
 *   2. **A row that does not restore is REPORTED, never dropped.** Every
 *      carried row lands in exactly one of `restored` or `failed`, with a
 *      machine-readable reason; `restored.length + failed.length` always
 *      equals `carried`. A count of carried rows that silently exceeds
 *      what landed on disk is the misleading success this unit exists to
 *      remove.
 *   3. **What cannot be reconstructed is NAMED.** The rendered markdown
 *      body is a projection of the frontmatter plus the vault's own
 *      evidence log; the writer re-renders it from the fields that do
 *      restore, so prose it did not derive from those fields does not
 *      survive. {@link PREFERENCE_FIELDS_NOT_RESTORED} says so in the
 *      result rather than leaving the caller to discover it.
 *
 * The audit records the transition the txn derived (`create` /
 * `promote` / `update`) with {@link PREFERENCE_RESTORE_AUDIT_REASON} as
 * the reason. The op stays the truthful lifecycle transition - a restore
 * that promotes IS a promotion - and the reason says where the write
 * came from, which is strictly more than a `restore` op could carry.
 */

import type { ExportedPreferenceRow } from "../export.ts";
import {
  BrainCollisionError,
  BRAIN_COLLISION_KIND,
  noRevisionRewind,
  writePreferenceTxn,
} from "../preference-txn.ts";
import type { WritePreferenceInput } from "../preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  type BrainConfidence,
  type BrainPreferenceStatus,
} from "../types.ts";

/** Identity prefix every preference id and file basename carries. */
const PREFERENCE_ID_PREFIX = "pref-";

/**
 * Reason recorded on the audit line so the trail says where the write
 * came from. Machine-readable, like every other value on that line.
 */
export const PREFERENCE_RESTORE_AUDIT_REASON = "bundle_restore";

/** Agent recorded when the caller supplies no identity of its own. */
export const DEFAULT_RESTORE_AGENT = "bank-import";

/**
 * Why one carried preference did not land. Closed vocabulary: the values
 * travel out of TypeScript in the bank-import result and its `--json`
 * rendering, so an operator reads them to decide what to do next.
 */
export const PREFERENCE_RESTORE_FAILURE = Object.freeze({
  /** The row is not a preference record: a field is missing or mistyped. */
  malformedRow: "malformed_row",
  /**
   * The row predates the trial window being exported. Restoring it would
   * mean inventing an `unconfirmed_until`, which re-dates the rule's
   * promotion deadline - so the row is refused and named instead.
   */
  missingTrialWindow: "missing_trial_window",
  /** The vault is ahead of the bundle, or diverges at the same revision. */
  revisionConflict: "revision_conflict",
  /** Another writer holds the preference's sync lock. */
  preferenceLocked: "preference_locked",
  /** The write itself was refused (validation, vault identity, I/O). */
  writeRejected: "write_rejected",
} as const);

export type PreferenceRestoreFailure =
  (typeof PREFERENCE_RESTORE_FAILURE)[keyof typeof PREFERENCE_RESTORE_FAILURE];

export const PREFERENCE_RESTORE_FAILURES: ReadonlyArray<PreferenceRestoreFailure> = Object.freeze(
  Object.values(PREFERENCE_RESTORE_FAILURE),
);

export function isPreferenceRestoreFailure(value: unknown): value is PreferenceRestoreFailure {
  return (
    typeof value === "string" &&
    (PREFERENCE_RESTORE_FAILURES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Exported fields the restore deliberately does not reconstruct, typed
 * against the projection so a name here can never drift from a real
 * field. `body` is the only member: it is rendered from `evidenced_by`,
 * the evidence slices the vault's own log supplies, and any `How to
 * apply` prose the caller passed at write time - so a write reproduces
 * the parts derived from restored fields and nothing else.
 */
export const PREFERENCE_FIELDS_NOT_RESTORED: ReadonlyArray<keyof ExportedPreferenceRow> =
  Object.freeze(["body"]);

/** One carried row that did not land, and why. */
export interface PreferenceRestoreFailureRecord {
  /** The row's preference id, or `null` when it carried no usable one. */
  readonly id: string | null;
  /** Position in the carried section, so a null id is still locatable. */
  readonly index: number;
  readonly reason: PreferenceRestoreFailure;
  /** `field=<name>` for a structural refusal, else the writer's message. */
  readonly detail: string;
}

export interface PreferenceRestoreResult {
  /** Rows the bundle carried. Always `restored.length + failed.length`. */
  readonly carried: number;
  /** Preference ids written through the audited transaction. */
  readonly restored: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<PreferenceRestoreFailureRecord>;
  /** Exported fields a restore cannot reconstruct; see the constant. */
  readonly fieldsNotRestored: ReadonlyArray<keyof ExportedPreferenceRow>;
}

export interface RestorePreferencesOptions {
  /** Identity recorded on the audit line and the edit-history entries. */
  readonly agent?: string;
  /** Clock for the audit timestamp; defaults to wall-clock. */
  readonly now?: () => Date;
}

/** Structural refusal carrying the field that failed the guard. */
class RowShapeError extends Error {
  readonly reason: PreferenceRestoreFailure;
  readonly field: string;

  constructor(reason: PreferenceRestoreFailure, field: string) {
    super(`field=${field}`);
    this.name = "RowShapeError";
    this.reason = reason;
    this.field = field;
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function requireText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (!isNonEmptyString(value))
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, field);
  return value;
}

function optionalText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, field);
  return value.trim() === "" ? null : value;
}

function optionalCount(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, field);
  }
  return value;
}

function optionalStrings(row: Record<string, unknown>, field: string): ReadonlyArray<string> {
  const value = row[field];
  if (value === undefined || value === null) return [];
  if (!isStringArray(value))
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, field);
  return value;
}

function readStatus(row: Record<string, unknown>): BrainPreferenceStatus {
  const value = row["status"];
  const members = Object.values(BRAIN_PREFERENCE_STATUS) as ReadonlyArray<string>;
  if (typeof value !== "string" || !members.includes(value)) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "status");
  }
  return value as BrainPreferenceStatus;
}

function readConfidence(row: Record<string, unknown>): BrainConfidence {
  const value = row["confidence"];
  if (value === undefined || value === null) return BRAIN_CONFIDENCE.low;
  const members = Object.values(BRAIN_CONFIDENCE) as ReadonlyArray<string>;
  if (typeof value !== "string" || !members.includes(value)) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "confidence");
  }
  return value as BrainConfidence;
}

function readConfidenceValue(row: Record<string, unknown>): number | null {
  const value = row["confidence_value"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "confidence_value");
  }
  return value;
}

function readSlug(row: Record<string, unknown>): string {
  const id = requireText(row, "id");
  if (!id.startsWith(PREFERENCE_ID_PREFIX) || id.length <= PREFERENCE_ID_PREFIX.length) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "id");
  }
  return id.slice(PREFERENCE_ID_PREFIX.length);
}

/**
 * Reverse of `collectExportRows`' projection: an exported row becomes the
 * write input the audited transaction takes. Every field the projection
 * emits is either mapped here or listed in
 * {@link PREFERENCE_FIELDS_NOT_RESTORED} - there is no third option, and
 * the bundle round-trip test asserts exactly that.
 *
 * Throws {@link RowShapeError} for a row the guard refuses, so the caller
 * reports it per-entry instead of aborting the run.
 */
export function toWritePreferenceInput(row: unknown): WritePreferenceInput {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "row");
  }
  const record = row as Record<string, unknown>;
  const slug = readSlug(record);
  const topic = requireText(record, "topic");
  const principle = requireText(record, "principle");
  const created_at = requireText(record, "created_at");
  const status = readStatus(record);
  // Checked AFTER the structural fields so `missing_trial_window` means
  // what it says - an otherwise-complete row from a bundle written
  // before the window was exported - rather than doubling as the first
  // complaint about a row that is malformed in several ways at once.
  const trialWindow = record["unconfirmed_until"];
  if (trialWindow === undefined || trialWindow === null || trialWindow === "") {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.missingTrialWindow, "unconfirmed_until");
  }
  const scope = optionalText(record, "scope");
  const aliases = record["aliases"] === null ? [] : optionalStrings(record, "aliases");
  return {
    slug,
    topic,
    principle,
    created_at,
    unconfirmed_until: requireText(record, "unconfirmed_until"),
    status,
    evidenced_by: optionalStrings(record, "evidenced_by"),
    confirmed_at: optionalText(record, "confirmed_at"),
    applied_count: optionalCount(record, "applied_count"),
    violated_count: optionalCount(record, "violated_count"),
    last_evidence_at: optionalText(record, "last_evidence_at"),
    confidence: readConfidence(record),
    confidence_value: readConfidenceValue(record),
    pinned: record["pinned"] === true,
    revision: optionalCount(record, "revision"),
    // The writer composes the canonical tags (`brain`, `brain/preference`,
    // `brain/topic/…`, `brain/scope/…`) itself and de-duplicates, so
    // handing it the exported set restores any extra tag the source
    // carried without duplicating the canonical four.
    extraTags: optionalStrings(record, "tags"),
    ...(scope !== null ? { scope } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

/** Map a typed collision to the reason an operator reads in the result. */
function reasonForCollision(kind: BrainCollisionError["kind"]): PreferenceRestoreFailure {
  if (kind === BRAIN_COLLISION_KIND.sourceLock) return PREFERENCE_RESTORE_FAILURE.preferenceLocked;
  if (kind === BRAIN_COLLISION_KIND.staleUpdate) return PREFERENCE_RESTORE_FAILURE.revisionConflict;
  return PREFERENCE_RESTORE_FAILURE.writeRejected;
}

/**
 * Restore every carried preference row through the audited transaction.
 * Never throws for a bad row: the run continues and the row is reported,
 * mirroring the per-entry tolerance of the graph importer.
 */
export function restorePreferences(
  vault: string,
  rows: ReadonlyArray<unknown>,
  opts: RestorePreferencesOptions = {},
): PreferenceRestoreResult {
  const agent = opts.agent?.trim() ? opts.agent.trim() : DEFAULT_RESTORE_AGENT;
  // One clock for both opt-in sinks: the edit-history entry and the audit
  // line for a single row must carry the same instant.
  const clock = opts.now !== undefined ? { now: opts.now } : {};
  const restored: string[] = [];
  const failed: PreferenceRestoreFailureRecord[] = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const id = rowId(row);
    let input: WritePreferenceInput;
    try {
      input = toWritePreferenceInput(row);
    } catch (exc) {
      failed.push(failure(id, index, exc));
      continue;
    }
    try {
      const result = writePreferenceTxn(
        vault,
        input,
        [noRevisionRewind(input.revision ?? 0)],
        { overwrite: true },
        { agent, ...clock },
        { agent, reason: PREFERENCE_RESTORE_AUDIT_REASON, ...clock },
      );
      restored.push(result.id);
    } catch (exc) {
      failed.push(failure(id, index, exc));
    }
  }

  return Object.freeze({
    carried: rows.length,
    restored: Object.freeze(restored),
    failed: Object.freeze(failed),
    fieldsNotRestored: PREFERENCE_FIELDS_NOT_RESTORED,
  });
}

/** The row's declared id when it has a usable one, `null` otherwise. */
function rowId(row: unknown): string | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const id = (row as Record<string, unknown>)["id"];
  return isNonEmptyString(id) ? id : null;
}

function failure(id: string | null, index: number, exc: unknown): PreferenceRestoreFailureRecord {
  if (exc instanceof RowShapeError) {
    return { id, index, reason: exc.reason, detail: exc.message };
  }
  if (exc instanceof BrainCollisionError) {
    return { id, index, reason: reasonForCollision(exc.kind), detail: exc.message };
  }
  return {
    id,
    index,
    reason: PREFERENCE_RESTORE_FAILURE.writeRejected,
    detail: exc instanceof Error ? exc.message : String(exc),
  };
}
