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
 *   4. **What IS reconstructed is named too.** A bundle taken before the
 *      trial window entered the export projection carries none, and a bank
 *      bundle IS the backup - if the source vault is gone there is no
 *      re-export to fall back on. A row whose window is inert (any status
 *      but `unconfirmed`) restores on a window derived from its own
 *      `confirmed_at` / `created_at`, listed in `derived`; a row whose
 *      deadline is still live is refused, because inventing one would
 *      re-date a promotion. See {@link resolveTrialWindow}.
 *   5. **A contention the restore CREATES is reported.** `topic` is written
 *      verbatim, and the dream pass indexes topics through a fold, so an
 *      imported spelling can contend with a local one for a single topic
 *      key - a state in which consolidation for that key plans nothing and
 *      the inbox grows. The restore neither rewrites the topic (the vault
 *      would then record something the bundle did not say) nor refuses the
 *      row (a backup-recovery path is the worst place for a new failure
 *      mode); it names the collision. See {@link RestoredTopicKeyCollision}.
 *   6. **A lost IDENTITY is refused; a redacted payload is not.** A bundle
 *      an earlier build produced can carry {@link REDACTION_PLACEHOLDER} in
 *      a field that names the record - its id, its topic, an alias. The
 *      placeholder is one constant, so those rows do not merely arrive
 *      anonymous: they arrive as the SAME record, and restoring two of them
 *      writes one file twice while reporting two rules. Such a row is
 *      refused with `redacted_identifier`. A placeholder in the principle
 *      is an honest redaction the operator chose and restores untouched.
 *      See {@link refuseRedactedIdentity}.
 *
 * The audit records the transition the txn derived (`create` /
 * `promote` / `update`) with {@link PREFERENCE_RESTORE_AUDIT_REASON} as
 * the reason. The op stays the truthful lifecycle transition - a restore
 * that promotes IS a promotion - and the reason says where the write
 * came from, which is strictly more than a `restore` op could carry.
 */

import { REDACTION_PLACEHOLDER } from "../../redactor.ts";
import { collectExportRows, type ExportedPreferenceRow } from "../export.ts";
import { topicKey } from "../dream-plan.ts";
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
   * The row predates the trial window being exported AND its deadline is
   * still live - an `unconfirmed` rule, whose `unconfirmed_until` decides
   * when it expires. Restoring it would mean inventing a deadline, which
   * re-dates the rule's promotion - so the row is refused and named
   * instead. A row whose window is inert derives one; see
   * {@link resolveTrialWindow}.
   */
  missingTrialWindow: "missing_trial_window",
  /** The vault is ahead of the bundle, or diverges at the same revision. */
  revisionConflict: "revision_conflict",
  /** Another writer holds the preference's sync lock. */
  preferenceLocked: "preference_locked",
  /** The write itself was refused (validation, vault identity, I/O). */
  writeRejected: "write_rejected",
  /**
   * An identity-bearing field carries {@link REDACTION_PLACEHOLDER}: the
   * preference id, its topic, or one of its aliases. The export boundary
   * now refuses to emit such a bundle, but a bundle written by an earlier
   * build - or by any tool that scrubbed the payload before handing it
   * over - can still carry one, and the placeholder is a CONSTANT: two
   * rows redacted in the same field land on the same identity, so the
   * second silently overwrites the first. See {@link refuseRedactedIdentity}.
   */
  redactedIdentifier: "redacted_identifier",
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

/**
 * The row field a derived trial window was read from. Closed vocabulary:
 * these values travel out of TypeScript in the bank-import result and its
 * `--json` rendering, so an operator reads them to decide whether to accept
 * the restored value.
 */
export const TRIAL_WINDOW_DERIVED_FROM = Object.freeze({
  confirmedAt: "confirmed_at",
  createdAt: "created_at",
} as const);

export type TrialWindowDerivedFrom =
  (typeof TRIAL_WINDOW_DERIVED_FROM)[keyof typeof TRIAL_WINDOW_DERIVED_FROM];

/**
 * One carried row that landed on a value the bundle did not carry, and
 * where that value came from. Reported so a restore that reconstructed
 * something says so, rather than presenting a derived field as one the
 * backup contained.
 */
export interface PreferenceRestoreDerivation {
  readonly id: string;
  /** Position in the carried section, matching {@link PreferenceRestoreFailureRecord}. */
  readonly index: number;
  readonly field: keyof ExportedPreferenceRow;
  /** The value written. */
  readonly value: string;
  readonly derivedFrom: TrialWindowDerivedFrom;
}

/**
 * Two or more preferences whose topics fold onto one dream-pass topic key
 * after a restore - the destination's own rules and the bundle's rows taken
 * together.
 *
 * The restore writes `topic` VERBATIM (see {@link toRestoreRow}), so an
 * import can create a contention the dream pass then refuses to plan
 * through. Reported here for the same reason the dream pass reports it:
 * the pass plans nothing for a contended key, and an operator who is never
 * told will see consolidation stop and the inbox grow with no cause named.
 */
export interface RestoredTopicKeyCollision {
  /** The folded key the claimants share. */
  readonly key: string;
  /** The distinct raw topics claiming it, in code-unit order. */
  readonly topics: ReadonlyArray<string>;
  /** The ids of every claiming preference, in code-unit order. */
  readonly prefIds: ReadonlyArray<string>;
}

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
  /**
   * Rows that landed on a field the bundle did not carry, and where the
   * value came from. A subset of `restored`, never of `failed`.
   */
  readonly derived: ReadonlyArray<PreferenceRestoreDerivation>;
  /**
   * Folded topic keys that more than one raw topic now claims in the
   * destination vault as a result of this restore. Empty for a restore that
   * created none - the ordinary case.
   */
  readonly topicKeyCollisions: ReadonlyArray<RestoredTopicKeyCollision>;
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

/**
 * Refuse a value that carries the redactor's placeholder in a field that
 * IS an identity.
 *
 * The distinction this draws is the whole point of the guard. A
 * placeholder in PAYLOAD text - a principle, a body - is an honest
 * redaction the operator chose, and the row restores with it: the rule is
 * still the rule, minus a secret nobody wanted in a backup. A placeholder
 * in an IDENTIFIER is a lost identity. `id` names the file the rule is
 * written to, `topic` is the key the dream pass folds and consolidates on,
 * and an alias is an inbound wikilink target. Worse, the placeholder is a
 * single constant, so two rows redacted in the same field are not two
 * anonymous rules - they are one, and restoring both writes one file twice
 * while reporting two.
 *
 * `includes` rather than equality: a partially-redacted identifier lost
 * exactly as much identity as a wholly-redacted one, and two rows redacted
 * at the same position collide the same way.
 */
function refuseRedactedIdentity(value: string, field: string): void {
  if (value.includes(REDACTION_PLACEHOLDER)) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.redactedIdentifier, field);
  }
}

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
  refuseRedactedIdentity(id, "id");
  return id.slice(PREFERENCE_ID_PREFIX.length);
}

/** The trial window a row will be written with, and where it came from. */
interface ResolvedTrialWindow {
  readonly value: string;
  /** Absent when the row carried the field itself - nothing was derived. */
  readonly derivedFrom?: TrialWindowDerivedFrom;
}

/**
 * The trial window to write for a row, derived only where the row's own
 * fields determine it.
 *
 * A bundle written before `unconfirmed_until` entered the export projection
 * carries no window at all, and a bank bundle IS the backup: when the source
 * vault is gone there is no re-export and no way to supply the field. So the
 * question is not whether to refuse, but for which rows a refusal is the
 * honest answer.
 *
 * Exactly one consumer reads the field - `planAutoRetires`, and only while a
 * preference is `unconfirmed`, where it is the expiry deadline. For every
 * other status the window is inert: the rule has already left its trial, and
 * `confirmed_at` (not `unconfirmed_until`) records when. For those rows the
 * window is derived CLOSED at the instant the row itself records - the exact
 * convention the force-confirmed writer already uses when it creates a rule
 * that skips the trial - so nothing is re-dated and no deadline is invented.
 *
 * An `unconfirmed` row is refused. Its deadline is live, it is not a function
 * of any field the row carries, and a fabricated one would silently move a
 * promotion - the class of defect this release exists to remove.
 */
function resolveTrialWindow(
  record: Record<string, unknown>,
  status: BrainPreferenceStatus,
  created_at: string,
): ResolvedTrialWindow {
  const carried = record["unconfirmed_until"];
  if (typeof carried === "string" && carried.trim() !== "") return { value: carried };
  if (carried !== undefined && carried !== null && typeof carried !== "string") {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "unconfirmed_until");
  }
  if (status === BRAIN_PREFERENCE_STATUS.unconfirmed) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.missingTrialWindow, "unconfirmed_until");
  }
  const confirmedAt = optionalText(record, "confirmed_at");
  if (confirmedAt !== null) {
    return { value: confirmedAt, derivedFrom: TRIAL_WINDOW_DERIVED_FROM.confirmedAt };
  }
  return { value: created_at, derivedFrom: TRIAL_WINDOW_DERIVED_FROM.createdAt };
}

/** An exported row mapped to a write input, plus what had to be derived. */
export interface RestoreRowMapping {
  readonly input: WritePreferenceInput;
  /** Fields the row did not carry and the restore reconstructed. */
  readonly derived: ReadonlyArray<Omit<PreferenceRestoreDerivation, "id" | "index">>;
}

/**
 * Reverse of `collectExportRows`' projection: an exported row becomes the
 * write input the audited transaction takes. Every field the projection
 * emits is either mapped here or listed in
 * {@link PREFERENCE_FIELDS_NOT_RESTORED} - there is no third option, and
 * the bundle round-trip test asserts exactly that.
 *
 * `topic` is written VERBATIM. The dream pass indexes topics through a fold
 * (`topicKey`), so a bundle spelling a topic differently from a rule the
 * destination already owns can create a contention that stops consolidation
 * for that key. Rewriting the topic to the local spelling would make the
 * vault record something the bundle did not say, and refusing the row would
 * add a failure mode to the one path whose purpose is recovering a backup.
 * So the restore writes what the bundle declared and REPORTS the collision -
 * see {@link RestoredTopicKeyCollision}, which is also the only place the
 * two call sites are reconciled.
 *
 * Throws {@link RowShapeError} for a row the guard refuses, so the caller
 * reports it per-entry instead of aborting the run.
 */
export function toRestoreRow(row: unknown): RestoreRowMapping {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new RowShapeError(PREFERENCE_RESTORE_FAILURE.malformedRow, "row");
  }
  const record = row as Record<string, unknown>;
  const slug = readSlug(record);
  const topic = requireText(record, "topic");
  refuseRedactedIdentity(topic, "topic");
  // `principle` is PAYLOAD, not identity: a redaction inside it is one the
  // operator chose, and the rule it states survives it. It is deliberately
  // not passed through the identity guard.
  const principle = requireText(record, "principle");
  const created_at = requireText(record, "created_at");
  const status = readStatus(record);
  // Read here, ahead of the trial window, for the same reason the window
  // is resolved after the structural fields: a row that lost an alias has
  // lost an identity whatever else is true of it, and `redacted_identifier`
  // should not lose the race to a window this restore could have derived.
  const aliases = record["aliases"] === null ? [] : optionalStrings(record, "aliases");
  for (const alias of aliases) refuseRedactedIdentity(alias, "aliases");
  // Resolved AFTER the structural fields so `missing_trial_window` means
  // what it says - an otherwise-complete row from a bundle written
  // before the window was exported - rather than doubling as the first
  // complaint about a row that is malformed in several ways at once.
  const trialWindow = resolveTrialWindow(record, status, created_at);
  const scope = optionalText(record, "scope");
  const input: WritePreferenceInput = {
    slug,
    topic,
    principle,
    created_at,
    unconfirmed_until: trialWindow.value,
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
  return {
    input,
    derived:
      trialWindow.derivedFrom === undefined
        ? []
        : [
            {
              field: "unconfirmed_until",
              value: trialWindow.value,
              derivedFrom: trialWindow.derivedFrom,
            },
          ],
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
  const derived: PreferenceRestoreDerivation[] = [];
  // The destination's topics BEFORE this run, so a row that overwrites a
  // rule of the same id replaces its claim rather than contending with it.
  const priorTopics = new Map<string, string>();
  for (const existing of collectExportRows(vault)) priorTopics.set(existing.id, existing.topic);
  const restoredTopics = new Map<string, string>();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const id = rowId(row);
    let mapping: RestoreRowMapping;
    try {
      mapping = toRestoreRow(row);
    } catch (exc) {
      failed.push(failure(id, index, exc));
      continue;
    }
    const { input } = mapping;
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
      restoredTopics.set(result.id, input.topic);
      // Only a row that LANDED can have been restored on a derived value.
      for (const d of mapping.derived) derived.push({ id: result.id, index, ...d });
    } catch (exc) {
      failed.push(failure(id, index, exc));
    }
  }

  return Object.freeze({
    carried: rows.length,
    restored: Object.freeze(restored),
    failed: Object.freeze(failed),
    fieldsNotRestored: PREFERENCE_FIELDS_NOT_RESTORED,
    derived: Object.freeze(derived),
    topicKeyCollisions: collisionsAfterRestore(priorTopics, restoredTopics),
  });
}

/**
 * Folded topic keys claimed by more than one raw spelling once this restore
 * has landed. Byte-identical spellings are NOT a collision: that is the
 * ordinary "one topic, two rules" case the dream pass has always handled,
 * and reporting it here would be this unit inventing a finding it did not
 * cause - the same line `TopicKeyContention` draws.
 */
function collisionsAfterRestore(
  priorTopics: ReadonlyMap<string, string>,
  restoredTopics: ReadonlyMap<string, string>,
): ReadonlyArray<RestoredTopicKeyCollision> {
  if (restoredTopics.size === 0) return Object.freeze([]);
  const claimants = new Map<string, Map<string, Set<string>>>();
  const add = (id: string, topic: string): void => {
    const key = topicKey(topic);
    if (key === "") return;
    const byTopic = claimants.get(key) ?? new Map<string, Set<string>>();
    const ids = byTopic.get(topic) ?? new Set<string>();
    ids.add(id);
    byTopic.set(topic, ids);
    claimants.set(key, byTopic);
  };
  for (const [id, topic] of priorTopics) {
    // A restored row REPLACED the rule of the same id: its old topic is no
    // longer on disk and cannot be a claimant.
    if (restoredTopics.has(id)) continue;
    add(id, topic);
  }
  for (const [id, topic] of restoredTopics) add(id, topic);

  const out: RestoredTopicKeyCollision[] = [];
  for (const [key, byTopic] of [...claimants.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (byTopic.size < 2) continue;
    // At least one claimant must come from THIS restore - a contention the
    // destination already had is not something the import created.
    const ids = [...byTopic.values()].flatMap((set) => [...set]);
    if (!ids.some((id) => restoredTopics.has(id))) continue;
    out.push(
      Object.freeze({
        key,
        topics: Object.freeze([...byTopic.keys()].toSorted()),
        prefIds: Object.freeze(ids.toSorted()),
      }),
    );
  }
  return Object.freeze(out);
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
