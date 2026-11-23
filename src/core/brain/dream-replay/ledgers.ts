/**
 * The two ledgers the pass keeps between windows, as records of the
 * brain store (design D4.5): the cross-topic allowance spent per owner
 * token and day, and the rollup rungs' baselines. A device-local file
 * would leave a new owner with empty ledgers, so it would repeat a rollup
 * or spend a day's allowance twice; records in the `shared` partition
 * travel with the coverage.
 *
 * Each record carries the effect id of the window that wrote it, and the
 * fold keeps one record per effect, so a window finished twice (a crash
 * between the effect and the coverage, two devices after a forced
 * takeover) spends nothing twice.
 */

import { existsSync } from "node:fs";

import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import { compareRecords, type StoreRecord } from "../../store/envelope.ts";
import {
  CROSS_TOPIC_LEDGER_VERSION,
  readCrossTopicLedger,
  type CrossTopicLedger,
} from "../dream-plan-cross-topic.ts";
import { crossTopicLedgerPath, rollupLedgerPath } from "../paths.ts";
import {
  readRollupLedger,
  ROLLUP_LEDGER_VERSION,
  type RollupLadderPlan,
  type RollupLedger,
} from "../rollup-ladder.ts";
import { DREAM_CROSS_TOPIC_SPENT_KIND, DREAM_ROLLUP_BASELINE_KIND } from "./records.ts";

/** The effect id of an effect of a window: sha256 of `[window, kind, subject]` (design D4). */
export function effectId(window: string, kind: string, subject: string): string {
  return sha256Hex(canonicalJson([window, kind, subject]));
}

/** The window name the one-time import of a device's ledger files is recorded under. */
export const LEDGER_IMPORT_WINDOW = "import";

export interface CrossTopicSpentBody {
  readonly day: string;
  readonly owner_token: string;
  readonly window: string;
  readonly effect: string;
}

export interface RollupBaselineBody {
  readonly rung: string;
  readonly baseline: number;
  readonly produced: number;
  readonly window: string;
  readonly effect: string;
}

/** The ledgers as the store holds them. */
export interface ReplayLedgers {
  /** Owner token to the days its allowance was spent on. */
  readonly crossTopic: ReadonlyMap<string, ReadonlySet<string>>;
  /** Rung to its newest baseline record. */
  readonly rollup: ReadonlyMap<string, RollupBaselineBody>;
  /** Whether any ledger record exists (the files were imported, or a window wrote one). */
  readonly any: boolean;
  /** The effect ids of every ledger record. */
  readonly effects: ReadonlySet<string>;
}

function isSpent(body: Record<string, unknown>): boolean {
  return (
    typeof body["day"] === "string" &&
    typeof body["owner_token"] === "string" &&
    typeof body["effect"] === "string"
  );
}

function isBaseline(body: Record<string, unknown>): boolean {
  return (
    typeof body["rung"] === "string" &&
    typeof body["baseline"] === "number" &&
    typeof body["produced"] === "number" &&
    typeof body["effect"] === "string"
  );
}

/** Order of the windows that wrote rollup baselines: the import first, then by name. */
function windowRank(window: string): string {
  return window === LEDGER_IMPORT_WINDOW ? "" : window;
}

/** Fold the ledger records of the `dream-replay` stream: one record per effect id. */
export function foldReplayLedgers(records: ReadonlyArray<StoreRecord>): ReplayLedgers {
  const seen = new Set<string>();
  const crossTopic = new Map<string, Set<string>>();
  const rollup = new Map<string, RollupBaselineBody>();
  let any = false;
  for (const record of records.toSorted(compareRecords)) {
    const body = record.body as Record<string, unknown>;
    if (record.kind === DREAM_CROSS_TOPIC_SPENT_KIND && isSpent(body)) {
      any = true;
      const spent = body as unknown as CrossTopicSpentBody;
      if (seen.has(spent.effect)) continue;
      seen.add(spent.effect);
      const days = crossTopic.get(spent.owner_token) ?? new Set<string>();
      days.add(spent.day);
      crossTopic.set(spent.owner_token, days);
    } else if (record.kind === DREAM_ROLLUP_BASELINE_KIND && isBaseline(body)) {
      any = true;
      const baseline = body as unknown as RollupBaselineBody;
      if (seen.has(baseline.effect)) continue;
      seen.add(baseline.effect);
      const before = rollup.get(baseline.rung);
      if (before === undefined || windowRank(baseline.window) >= windowRank(before.window)) {
        rollup.set(baseline.rung, baseline);
      }
    }
  }
  return { crossTopic, rollup, any, effects: seen };
}

/**
 * The cross-topic ledger a window of `day` plans against: an owner whose
 * allowance was spent that day reads as spent today; the planner compares
 * nothing else.
 */
export function crossTopicLedgerOn(ledgers: ReplayLedgers, day: string): CrossTopicLedger | null {
  if (ledgers.crossTopic.size === 0) return null;
  const last: Record<string, string> = {};
  for (const [owner, days] of ledgers.crossTopic) {
    if (days.has(day)) last[owner] = day;
    else last[owner] = [...days].toSorted().at(-1)!;
  }
  return { version: CROSS_TOPIC_LEDGER_VERSION, last_promoted: last };
}

/** The rollup ledger of the store, or null when no rung ever fired. */
export function rollupLedgerOf(ledgers: ReplayLedgers): RollupLedger | null {
  if (ledgers.rollup.size === 0) return null;
  const baselines: Record<string, number> = {};
  const produced: Record<string, number> = {};
  for (const [rung, body] of ledgers.rollup) {
    baselines[rung] = body.baseline;
    produced[rung] = body.produced;
  }
  return { version: ROLLUP_LEDGER_VERSION, baselines, produced };
}

/** One ledger record to write. */
export interface LedgerRecord {
  readonly kind: string;
  readonly body: CrossTopicSpentBody | RollupBaselineBody;
}

/**
 * The ledger records of a window: the allowance of every owner the
 * window's cross-topic plan spent on its day, and every rung its rollup
 * plan fired (when the fired work was all queued).
 */
export function windowLedgerRecords(input: {
  readonly window: string;
  readonly day: string;
  readonly crossTopicLedger: CrossTopicLedger | null;
  readonly before: ReplayLedgers;
  readonly rollupPlan: RollupLadderPlan;
  readonly rollupProductionComplete: boolean;
}): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const [owner, day] of Object.entries(input.crossTopicLedger?.last_promoted ?? {})) {
    if (day !== input.day || input.before.crossTopic.get(owner)?.has(day) === true) continue;
    out.push({
      kind: DREAM_CROSS_TOPIC_SPENT_KIND,
      body: {
        day,
        owner_token: owner,
        window: input.window,
        effect: effectId(input.window, DREAM_CROSS_TOPIC_SPENT_KIND, owner),
      },
    });
  }
  if (input.rollupPlan.fired && input.rollupProductionComplete) {
    for (const entry of input.rollupPlan.entries) {
      const rung = entry.tier;
      out.push({
        kind: DREAM_ROLLUP_BASELINE_KIND,
        body: {
          rung,
          baseline: input.rollupPlan.ledger.baselines[rung] ?? 0,
          produced: input.rollupPlan.ledger.produced[rung] ?? 0,
          window: input.window,
          effect: effectId(input.window, DREAM_ROLLUP_BASELINE_KIND, rung),
        },
      });
    }
  }
  return out;
}

/**
 * The records that import this device's ledger files, once (design D7.1):
 * only the owner's device ran passes before the replay, so its files are
 * the whole history. Nothing when neither file exists.
 */
export function importedLedgerRecords(vault: string | null): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  const window = LEDGER_IMPORT_WINDOW;
  if (existsSync(crossTopicLedgerPath(vault))) {
    for (const [owner, day] of Object.entries(readCrossTopicLedger(vault)?.last_promoted ?? {})) {
      out.push({
        kind: DREAM_CROSS_TOPIC_SPENT_KIND,
        body: {
          day,
          owner_token: owner,
          window,
          effect: effectId(window, DREAM_CROSS_TOPIC_SPENT_KIND, owner),
        },
      });
    }
  }
  if (existsSync(rollupLedgerPath(vault))) {
    const ledger = readRollupLedger(vault);
    for (const rung of new Set([
      ...Object.keys(ledger?.baselines ?? {}),
      ...Object.keys(ledger?.produced ?? {}),
    ])) {
      out.push({
        kind: DREAM_ROLLUP_BASELINE_KIND,
        body: {
          rung,
          baseline: ledger?.baselines[rung] ?? 0,
          produced: ledger?.produced[rung] ?? 0,
          window,
          effect: effectId(window, DREAM_ROLLUP_BASELINE_KIND, rung),
        },
      });
    }
  }
  return out;
}
