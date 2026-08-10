/**
 * U3 - who is still standing on ground that moved?
 *
 * Supersession in this store runs one way. `moveToRetired` stamps
 * `retired_at` on a rule, `tombstone` stamps `tombstoned_at` on a memory,
 * `temporalReplace` closes a fact's `valid_until` - and each of them
 * writes the record forward. Nothing walks the other way. A decision
 * receipt written last month naming a rule retired last week reads today
 * exactly like one naming a rule that still holds, and so does a live
 * artifact whose body still cites it. The state changed; every consumer
 * of it kept its original appearance.
 *
 * This check is that reverse walk: given a state that changed at T, name
 * the consumers written strictly before T that still cite it.
 *
 * ## What already exists, at a different granularity
 *
 * `pack-stamp.ts` and the anticipatory cache already perform a BACKWARD
 * invalidation of a sort: a persisted context pack carries a digest over
 * the whole Brain tree plus the corpus generation, and a cached pack
 * whose digest no longer matches is discarded. That is a coarse,
 * whole-tree, binary answer - something under `Brain/` moved, so this
 * cached blob is suspect - and it is the right answer for a cache. It
 * cannot say WHICH state moved, WHICH consumers rest on it, or that a
 * consumer written after the move is fine. This check is the per-edge
 * reading of the same question, and it deliberately reuses none of that
 * machinery: a digest that changes on any byte is the wrong instrument
 * for naming one edge.
 *
 * ## The consumer side reads receipts, not outcomes
 *
 * `brain_context_pack_outcome` is a SELF-REPORTED row - an agent saying
 * how a pack went - and it does not record what the pack contained. The
 * record carrying the consumed item list is the `context_receipt`
 * continuity record, whose `payload.items[].id` is the injected set. The
 * join reads those.
 *
 * ## Never-measured is not clean
 *
 * Receipt emission is opt-in. A vault with the telemetry gate off has
 * zero receipts, and a join over zero consumers finds zero problems -
 * which is byte-identical to a vault whose consumers are all current.
 * `ContextReceiptFoldEmpty` in `context-receipts.ts` exists for exactly
 * this reason, and the report inherits its contract: `recorded: false`
 * says the mechanism did not run, and the check pushes no issue for it
 * rather than reporting a clean bill of health over an unmeasured store.
 *
 * ## The split
 *
 * {@link joinStaleDependencies} is pure - two lists in, rows out, no
 * clock, no filesystem - so every rule below is reachable from a unit
 * test without a vault. The collection lives in
 * `../stale-dependency.ts`, in the pure-kernel / impure-collector shape
 * `maintenance/action-scorer.ts` and `partner/codegraph-health.ts`
 * already use.
 *
 * This module is the LEAF of that pair: the collector imports the kernel,
 * the vocabularies and the constants from here, and nothing here imports
 * the collector. The check still needs one, so it takes it as an argument
 * - {@link makeStaleDependencyCheck} - and `doctor.ts`, which is already
 * the registry and therefore already the place both halves meet, supplies
 * it. Importing the collector directly instead would close a loop between
 * two modules that each define something the other needs, which is the
 * shape `tests/core/architecture/import-cycles.test.ts` refuses.
 */

import type { DoctorCheck } from "./check.ts";
import { reportSweptFailure, SWEEP_ORIGIN } from "./unreadable-path.ts";

// ----- Constants ------------------------------------------------------------

/** Doctor issue code for a consumer resting on a state that has changed. */
export const STALE_DEPENDENCY_CODE = "stale-dependency";

/** Subsystem name the collector's failed reads are reported under. */
const STALE_DEPENDENCY_SITE = "brain.doctor.staleDependency";

/**
 * What an operator reads when states changed and nothing recorded what
 * consumed them. It names the mechanism rather than the absence, because
 * the honest statement is about the measurement and not about the store,
 * and it carries the count so the sentence says how much is unaccounted
 * for rather than merely that something is.
 */
function STALE_DEPENDENCY_UNMEASURED(statesChanged: number): string {
  const states = statesChanged === 1 ? "1 state" : `${statesChanged} states`;
  return (
    `context and decision consumers were not measured: ${states} stopped being current and ` +
    "no context receipts or decision-change receipts were recorded in the audit window, so " +
    "packs and decisions built on them cannot be checked; live records citing them are " +
    "reported above"
  );
}

/**
 * How far back the consumer scan reaches, in days.
 *
 * A window rather than the whole history, because a receipt from two
 * years ago names a context that no longer exists in any working sense:
 * the row would be true and useless. Ninety days is one quarter - long
 * enough to span a retirement and the work that followed it, short
 * enough that the scan reads a bounded number of month shards.
 */
export const STALE_DEPENDENCY_LOOKBACK_DAYS = 90;

/**
 * Consumers reported per state.
 *
 * A rule cited by four hundred receipts produces one finding, not four
 * hundred lines of it. The cap bounds what is PRINTED; the row still
 * carries the true total, so the operator is never shown a prefix that
 * looks like the whole set.
 */
export const STALE_DEPENDENCY_MAX_CONSUMERS_PER_STATE = 20;

// ----- Vocabularies ---------------------------------------------------------

/**
 * What kind of thing is resting on the changed state.
 *
 * Closed, because the three arms are read from three different stores
 * and an operator acting on a row needs to know which: a context receipt
 * is retrieval history, a decision-change receipt is an accountability
 * record, and a Brain artifact is a live file that can be edited.
 */
export const STALE_DEPENDENCY_CONSUMER = Object.freeze({
  /** A `context_receipt` continuity record that injected the state. */
  contextReceipt: "context_receipt",
  /** A `decision_change.v1` receipt whose evidence cited the state. */
  decisionChange: "decision_change",
  /** A live Brain artifact whose links still reach the state. */
  brainArtifact: "brain_artifact",
} as const);

export type StaleDependencyConsumerKind =
  (typeof STALE_DEPENDENCY_CONSUMER)[keyof typeof STALE_DEPENDENCY_CONSUMER];

/** Every consumer kind, in declaration order. */
export const STALE_DEPENDENCY_CONSUMERS: ReadonlyArray<StaleDependencyConsumerKind> = Object.freeze(
  [
    STALE_DEPENDENCY_CONSUMER.contextReceipt,
    STALE_DEPENDENCY_CONSUMER.decisionChange,
    STALE_DEPENDENCY_CONSUMER.brainArtifact,
  ],
);

export function isStaleDependencyConsumerKind(
  value: unknown,
): value is StaleDependencyConsumerKind {
  return (
    typeof value === "string" &&
    (STALE_DEPENDENCY_CONSUMERS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * How the state stopped being current.
 *
 * Three writers, three shapes on disk, one question. Naming the kind on
 * the row is what lets an operator go to the right remedy: a retired
 * rule has an audit trail, a tombstoned memory has a reason field, and a
 * closed validity interval has a successor fact.
 */
export const STALE_DEPENDENCY_STATE = Object.freeze({
  /** A preference `moveToRetired` renamed into `Brain/retired/`. */
  retired: "retired",
  /** An artifact `tombstone` marked, carrying `tombstoned_at`. */
  tombstoned: "tombstoned",
  /** A fact whose `valid_until` has closed, per `temporalReplace`. */
  validityClosed: "validity_closed",
} as const);

export type StaleDependencyStateKind =
  (typeof STALE_DEPENDENCY_STATE)[keyof typeof STALE_DEPENDENCY_STATE];

/** Every state kind, in declaration order. */
export const STALE_DEPENDENCY_STATES: ReadonlyArray<StaleDependencyStateKind> = Object.freeze([
  STALE_DEPENDENCY_STATE.retired,
  STALE_DEPENDENCY_STATE.tombstoned,
  STALE_DEPENDENCY_STATE.validityClosed,
]);

export function isStaleDependencyStateKind(value: unknown): value is StaleDependencyStateKind {
  return (
    typeof value === "string" && (STALE_DEPENDENCY_STATES as ReadonlyArray<string>).includes(value)
  );
}

// ----- Errors ---------------------------------------------------------------

/**
 * A store the audit depends on exists and could not be read.
 *
 * Raised by the collector, consumed here. It lives beside the reporting
 * rather than beside the reading because everything it carries exists
 * for the uncertainty entry: the path and the attempted action are what
 * that entry names, and the original error travels as `cause` so the
 * sweep can still read the `errno` and tell an absent optional directory
 * from one it failed to enter.
 */
export class StaleDependencyReadError extends Error {
  readonly path: string;
  readonly action: string;

  constructor(action: string, path: string, cause: unknown) {
    super(`stale-dependency audit: ${action}: ${path}`, { cause });
    this.name = "StaleDependencyReadError";
    this.path = path;
    this.action = action;
  }
}

// ----- Shapes ---------------------------------------------------------------

/**
 * One state that stopped being current, already placed in time.
 *
 * `changed_at_ms` is supplied rather than parsed here so the kernel has
 * no branch for an instant it cannot read: deciding what an unparseable
 * timestamp means belongs to the collector, which knows which file it
 * came from and which existing lint already reports it.
 */
export interface StaleDependencyState {
  /** Folded identifier, via `brainArtifactSlug` on both sides. */
  readonly key: string;
  readonly kind: StaleDependencyStateKind;
  /** Absolute path of the file carrying the state. */
  readonly path: string;
  readonly changed_at: string;
  readonly changed_at_ms: number;
}

/** One consumer and every state key it cites. */
export interface StaleDependencyCitation {
  readonly kind: StaleDependencyConsumerKind;
  /** Receipt id, decision subject, or artifact basename. */
  readonly id: string;
  /** Absolute path, for the consumers that are files. */
  readonly path?: string;
  readonly written_at: string;
  readonly written_at_ms: number;
  /**
   * Whether the consumer is still part of the live store. A retired
   * artifact citing another retired artifact is history agreeing with
   * itself, not a dependency anybody is standing on.
   */
  readonly live: boolean;
  /** Folded state keys this consumer cites. */
  readonly cites: ReadonlyArray<string>;
}

/** One consumer as it appears on a row. */
export interface StaleDependencyConsumer {
  readonly kind: StaleDependencyConsumerKind;
  readonly id: string;
  readonly path?: string;
  readonly written_at: string;
}

/** One changed state and the consumers that predate the change. */
export interface StaleDependencyRow {
  readonly state: string;
  readonly state_kind: StaleDependencyStateKind;
  readonly state_path: string;
  readonly changed_at: string;
  /** Capped at {@link StaleDependencyJoinInput.maxConsumersPerState}. */
  readonly consumers: ReadonlyArray<StaleDependencyConsumer>;
  /** How many consumers qualified, before the cap. */
  readonly consumer_total: number;
}

export interface StaleDependencyJoinInput {
  readonly states: ReadonlyArray<StaleDependencyState>;
  readonly citations: ReadonlyArray<StaleDependencyCitation>;
  readonly maxConsumersPerState: number;
}

// ----- The join -------------------------------------------------------------

/**
 * Join changed states against the consumers that predate the change.
 *
 * A row is emitted for a (state, consumer) pair when all three hold:
 *
 *   1. the consumer cites the state, on the folded key so the pre- and
 *      post-rename spellings of one rule are one key;
 *   2. the consumer was written STRICTLY before the state changed - a
 *      consumer written at the same instant, or after, has already had
 *      the opportunity to see the change;
 *   3. the consumer is still live.
 *
 * Two states folding to one key - a preference retired and later
 * tombstoned - keep the EARLIEST instant. That is the first moment the
 * state stopped being current, and it is the widest honest reading of
 * "written before the change".
 *
 * Deterministic throughout: consumers sort by instant then kind then id,
 * rows by instant then key, and every comparison is on code points
 * rather than locale collation so two hosts produce one order.
 */
export function joinStaleDependencies(
  input: StaleDependencyJoinInput,
): ReadonlyArray<StaleDependencyRow> {
  const states = foldStates(input.states);
  if (states.size === 0) return Object.freeze([]);
  const cap = Math.max(1, Math.floor(input.maxConsumersPerState));

  const perState = new Map<string, StaleDependencyConsumer[]>();
  for (const citation of input.citations) {
    if (!citation.live) continue;
    if (!Number.isFinite(citation.written_at_ms)) continue;
    for (const key of new Set(citation.cites)) {
      const state = states.get(key);
      if (state === undefined) continue;
      if (citation.written_at_ms >= state.changed_at_ms) continue;
      const bucket = perState.get(key);
      const consumer: StaleDependencyConsumer = Object.freeze({
        kind: citation.kind,
        id: citation.id,
        ...(citation.path !== undefined ? { path: citation.path } : {}),
        written_at: citation.written_at,
      });
      if (bucket) bucket.push(consumer);
      else perState.set(key, [consumer]);
    }
  }

  const rows: StaleDependencyRow[] = [];
  for (const [key, consumers] of perState) {
    const state = states.get(key)!;
    const ordered = consumers.toSorted(compareConsumers);
    rows.push(
      Object.freeze({
        state: key,
        state_kind: state.kind,
        state_path: state.path,
        changed_at: state.changed_at,
        consumers: Object.freeze(ordered.slice(0, cap)),
        consumer_total: ordered.length,
      }),
    );
  }
  return Object.freeze(
    rows.toSorted(
      (a, b) => compareText(a.changed_at, b.changed_at) || compareText(a.state, b.state),
    ),
  );
}

/** Earliest change per folded key; ties broken on path for determinism. */
function foldStates(
  states: ReadonlyArray<StaleDependencyState>,
): ReadonlyMap<string, StaleDependencyState> {
  const out = new Map<string, StaleDependencyState>();
  for (const state of states) {
    if (state.key === "") continue;
    const held = out.get(state.key);
    if (held === undefined) {
      out.set(state.key, state);
      continue;
    }
    if (state.changed_at_ms < held.changed_at_ms) out.set(state.key, state);
    else if (state.changed_at_ms === held.changed_at_ms && compareText(state.path, held.path) < 0) {
      out.set(state.key, state);
    }
  }
  return out;
}

function compareConsumers(a: StaleDependencyConsumer, b: StaleDependencyConsumer): number {
  return (
    compareText(a.written_at, b.written_at) ||
    compareText(a.kind, b.kind) ||
    compareText(a.id, b.id)
  );
}

/** Code-point comparison, so the order does not vary with the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ----- The check ------------------------------------------------------------

/**
 * What the operator cannot conclude when the consumer read fails.
 *
 * Written out here because `[UNSURE]` renders it verbatim, and "a
 * directory could not be read" on its own does not say which question
 * went unanswered.
 */
const STALE_DEPENDENCY_CONSEQUENCE =
  "no consumer of a superseded state was joined, so a receipt or artifact resting on a retired " +
  "rule is missing from this report";

/**
 * The collector, as the check consumes it.
 *
 * Structural rather than imported: the check reads three fields off the
 * report, and declaring them here is what keeps this module a leaf.
 * `StaleDependencyReport` satisfies it by shape.
 */
export type StaleDependencyAudit = (
  vault: string,
  opts: { readonly now: Date },
) => {
  readonly receipts_recorded: boolean;
  readonly rows: ReadonlyArray<StaleDependencyRow>;
  readonly states_changed: number;
};

/**
 * Reverse stale-dependency audit, over the collector it is handed.
 *
 * `failSoft` because this is the first check to read the continuity log,
 * and a continuity store broken in a way nothing here anticipates must
 * not blank the twenty-five findings around it. That is a backstop, not
 * the handling: the read failure this check EXPECTS - a continuity or
 * receipt directory that exists and cannot be entered - is caught below
 * and reported through the uncertainty channel, because a swallowed
 * throw is the same false clean bill of health the wave exists to
 * remove.
 *
 * A vault that recorded no receipts produces no issue, and an
 * uncertainty entry only when states actually changed in the window. The
 * report has always carried `recorded: false`, but a flag nothing
 * renders is not a statement anybody reads: through the doctor an
 * unmeasured store looked exactly like a clean one, because both
 * produced an empty issue list. The uncertainty channel is where this
 * codebase already says "the check did not run", so that is where it
 * says it - and it stays quiet when nothing was retired, tombstoned or
 * superseded, because then there is nothing whose consumers could have
 * gone stale and the unmeasured audit cost the operator nothing.
 */
export function makeStaleDependencyCheck(audit: StaleDependencyAudit): DoctorCheck {
  return {
    failSoft: true,
    run({ vault, now }, { issues, uncertain }) {
      let report;
      try {
        report = audit(vault, { now });
      } catch (err) {
        const failure = asReadFailure(err);
        reportSweptFailure(
          failure.path,
          failure.action,
          failure.cause,
          {
            site: STALE_DEPENDENCY_SITE,
            consequence: STALE_DEPENDENCY_CONSEQUENCE,
            uncertain,
          },
          SWEEP_ORIGIN.root,
        );
        return;
      }
      // The receipt-borne half is what an absent telemetry trail costs;
      // the artifact half was computed either way, so its rows are reported
      // regardless and the notice below scopes itself to what was missed.
      if (!report.receipts_recorded && report.states_changed > 0) {
        uncertain.push({
          code: STALE_DEPENDENCY_CODE,
          message: STALE_DEPENDENCY_UNMEASURED(report.states_changed),
        });
      }
      for (const row of report.rows) {
        issues.push({
          severity: "warning",
          code: STALE_DEPENDENCY_CODE,
          path: row.state_path,
          target: row.state,
          sources: Object.freeze(row.consumers.map((consumer) => consumer.id)),
          message: describeRow(row),
        });
      }
    },
  };
}

/**
 * The sentence an operator reads.
 *
 * It names the true total first and the listed subset second, so a
 * capped row can never be mistaken for the complete set - the failure
 * mode a bare list of twenty entries has.
 */
function describeRow(row: StaleDependencyRow): string {
  const listed = row.consumers.map((c) => `${c.kind} ${c.id} (${c.written_at})`).join(", ");
  const shown =
    row.consumer_total > row.consumers.length
      ? `, showing ${row.consumers.length} of them: ${listed}`
      : `: ${listed}`;
  return (
    `${row.state} became ${row.state_kind} at ${row.changed_at}; ` +
    `${row.consumer_total} consumer(s) written before that still rest on it${shown}`
  );
}

/** What the collector could not read, in the shape the sweep reports. */
interface StaleDependencyReadFailure {
  readonly path: string;
  readonly action: string;
  readonly cause: unknown;
}

/**
 * Unwrap the collector's typed read failure.
 *
 * The original `cause` is handed on rather than the wrapper, because the
 * sweep decides absent-versus-unreadable from the `errno` and a wrapper
 * carries none - an absent optional directory would otherwise be
 * reported as a subtree the doctor failed to enter.
 */
function asReadFailure(err: unknown): StaleDependencyReadFailure {
  if (err instanceof StaleDependencyReadError) {
    return { path: err.path, action: err.action, cause: err.cause };
  }
  return { path: UNKNOWN_FAILURE_PATH, action: "stale-dependency audit failed", cause: err };
}

/** Stands where a path would, for a throw that named none. */
const UNKNOWN_FAILURE_PATH = "";
