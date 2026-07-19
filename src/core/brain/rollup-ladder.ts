/**
 * Count-triggered fact rollup ladder (knowledge-intake-and-consolidation,
 * S3, t_c5263e27).
 *
 * A deterministic, count-only ladder wired into the dream synthesize
 * phase. It never reads the CONTENT of a fact - only how many facts
 * exist at each rung since that rung last rolled up. When the count of
 * new facts at a rung reaches its threshold, the ladder emits one
 * needs-llm-step rollup envelope (the LLM writes the summary note; core
 * never does) and records the counter reset. The rungs compose: a fact
 * rollup increments the rollup rung's source count, so enough fact
 * rollups cascade into one identity-tier rollup in the same pass.
 *
 * The top rung is `identity` - literally the highest existing
 * frontmatter tier weight (see FRONTMATTER_TIERS in schema-pack.ts).
 *
 * Byte-identical opt-out: the ladder produces nothing below threshold,
 * and the caller persists the ledger only when a rung fires, so a dream
 * pass with no counter movement writes no ledger and emits no rollup.
 */

import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { BrainConfig } from "./types.ts";
import { rollupLedgerPath } from "./paths.ts";

/** New facts since the last rollup that trigger a fact -> rollup step. */
export const DEFAULT_FACT_ROLLUP_THRESHOLD = 20;
/** New fact-rollups since the last rollup that trigger a rollup -> identity step. */
export const DEFAULT_ROLLUP_IDENTITY_THRESHOLD = 5;

/** Ladder rung names, base to top. `identity` is the highest tier weight. */
export const ROLLUP_TIER = Object.freeze({
  fact: "fact",
  rollup: "rollup",
  identity: "identity",
} as const);

/** On-disk ledger schema version. */
export const ROLLUP_LEDGER_VERSION = 1;

/** Resolved thresholds, one per firing rung. */
export interface RollupThresholds {
  /** fact -> rollup. */
  readonly fact: number;
  /** rollup -> identity. */
  readonly identity: number;
}

/**
 * Persisted counter state. `baselines[tier]` is the rung's source count
 * the last time it fired; `produced[tier]` is the cumulative number of
 * rollups the rung has emitted (the next rung's source count).
 */
export interface RollupLedger {
  readonly version: number;
  readonly baselines: Readonly<Record<string, number>>;
  readonly produced: Readonly<Record<string, number>>;
}

/** The needs-llm-step envelope emitted for one fired rung. */
export interface RollupEnvelope {
  readonly status: "needs-llm-step";
  readonly step: string;
  readonly tier: string;
  readonly produces: string;
  readonly prompt: string;
  readonly schema_hints: ReadonlyArray<string>;
  readonly target_path: string;
}

/** One fired rung: the counter reset plus its emitted envelope. */
export interface RollupLadderEntry {
  readonly tier: string;
  readonly produces: string;
  /** Source count at the rung's previous fire (the baseline consumed). */
  readonly fromCount: number;
  /** Source count now (the new baseline). */
  readonly toCount: number;
  /** New units since the last fire (`toCount - fromCount`). */
  readonly newSinceLast: number;
  readonly envelope: RollupEnvelope;
}

export interface RollupLadderPlan {
  readonly fired: boolean;
  readonly entries: ReadonlyArray<RollupLadderEntry>;
  /** Ledger to persist when `fired`; ignore otherwise. */
  readonly ledger: RollupLedger;
}

export interface RollupLadderInput {
  /** Current count of base-tier facts (e.g. preference artifacts). */
  readonly factCount: number;
  /** Prior ledger, or null when none has been written yet. */
  readonly ledger: RollupLedger | null;
  readonly thresholds: RollupThresholds;
  /** Run id, for a stable, unique rollup target path. */
  readonly runId: string;
}

/** Resolve the rollup thresholds from config, else the named defaults. */
export function resolveRollupThresholds(cfg: BrainConfig): RollupThresholds {
  const block = cfg.rollup;
  return Object.freeze({
    fact: block?.fact_threshold ?? DEFAULT_FACT_ROLLUP_THRESHOLD,
    identity: block?.identity_threshold ?? DEFAULT_ROLLUP_IDENTITY_THRESHOLD,
  });
}

/** Read the ledger, or null when absent or unparseable (treated as fresh). */
export function readRollupLedger(vault: string): RollupLedger | null {
  const path = rollupLedgerPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RollupLedger>;
    return Object.freeze({
      version: typeof parsed.version === "number" ? parsed.version : ROLLUP_LEDGER_VERSION,
      baselines: Object.freeze({ ...parsed.baselines }),
      produced: Object.freeze({ ...parsed.produced }),
    });
  } catch {
    return null;
  }
}

/** Persist the ledger. Called only when a rung fired. */
export function writeRollupLedger(vault: string, ledger: RollupLedger): void {
  atomicWriteFileSync(rollupLedgerPath(vault), `${JSON.stringify(ledger, null, 2)}\n`);
}

interface Rung {
  readonly tier: string;
  readonly produces: string;
  readonly threshold: number;
}

/**
 * Plan the rollup ladder. Pure: no I/O, deterministic in its inputs. The
 * rungs are processed base-to-top so a fact rollup fired this pass counts
 * toward the identity rung in the same pass.
 */
export function planRollupLadder(input: RollupLadderInput): RollupLadderPlan {
  const { factCount, ledger, thresholds, runId } = input;
  const baselines: Record<string, number> = { ...ledger?.baselines };
  const produced: Record<string, number> = { ...ledger?.produced };

  const rungs: ReadonlyArray<Rung> = Object.freeze([
    { tier: ROLLUP_TIER.fact, produces: ROLLUP_TIER.rollup, threshold: thresholds.fact },
    { tier: ROLLUP_TIER.rollup, produces: ROLLUP_TIER.identity, threshold: thresholds.identity },
  ]);

  const entries: RollupLadderEntry[] = [];
  for (const rung of rungs) {
    // Base rung counts facts; every higher rung counts the rollups its
    // lower neighbour has produced (recomputed AFTER lower rungs update
    // `produced`, so composition happens within this pass).
    const source = rung.tier === ROLLUP_TIER.fact ? factCount : (produced[ROLLUP_TIER.fact] ?? 0);
    const baseline = baselines[rung.tier] ?? 0;
    const newSinceLast = source - baseline;
    if (newSinceLast < rung.threshold) continue;
    baselines[rung.tier] = source;
    produced[rung.tier] = (produced[rung.tier] ?? 0) + 1;
    entries.push(
      Object.freeze({
        tier: rung.tier,
        produces: rung.produces,
        fromCount: baseline,
        toCount: source,
        newSinceLast,
        envelope: buildEnvelope(rung, newSinceLast, runId),
      }),
    );
  }

  return Object.freeze({
    fired: entries.length > 0,
    entries: Object.freeze(entries),
    ledger: Object.freeze({
      version: ROLLUP_LEDGER_VERSION,
      baselines: Object.freeze(baselines),
      produced: Object.freeze(produced),
    }),
  });
}

function buildEnvelope(rung: Rung, newSinceLast: number, runId: string): RollupEnvelope {
  const targetPath = `Brain/rollups/rollup-${rung.produces}-${runId}.md`;
  return Object.freeze({
    status: "needs-llm-step" as const,
    step: `rollup:${rung.tier}`,
    tier: rung.tier,
    produces: rung.produces,
    prompt:
      `Consolidate the ${newSinceLast} new ${rung.tier} items since the last rollup into one ` +
      `${rung.produces}-tier summary note. Cite the items you fold in; submit the full note.`,
    schema_hints: Object.freeze([
      "frontmatter: required YAML block with at least a `kind` key",
      `tier: ${rung.produces} (the rollup's tier weight)`,
    ]),
    target_path: targetPath,
  });
}
