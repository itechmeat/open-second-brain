/**
 * The plan record of a window (design D4, D5): what the window decided,
 * with every payload frozen, so a window interrupted after its plan is
 * finished from the plan and never planned again. The payload is the
 * pass's own plan values (topic plan, refresh, cross-topic ledger,
 * reconcile outcomes, rollup plan) encoded as plain JSON; a body larger
 * than a line is stored as a blob by the appender.
 *
 * Every effect has an effect id, the sha256 of `[window, kind, subject]`,
 * independent of the run and of the owner: a new preference is written
 * with it as its idempotency key, an audit event carries it in its body.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../../integrity/digest.ts";
import type { PlanState } from "../dream-plan.ts";
import type { CrossTopicLedger } from "../dream-plan-cross-topic.ts";
import type { RefreshResult } from "../dream-refresh.ts";
import type { DreamWarning } from "../dream-types.ts";
import type { ReconcileOutcomes } from "../reconcile-outcomes.ts";
import type { RollupLadderPlan } from "../rollup-ladder.ts";
import type { SalienceGateVerdict } from "../salience-gate.ts";
import type { BrainConfig } from "../types.ts";
import { effectId } from "./ledgers.ts";

/** Version of the plan encoding; a plan of another version is planned again. */
export { WINDOW_PLAN_VERSION } from "./records.ts";

/** One late application that came in time for a trial already retired (design D5a). */
export interface Reconciliation {
  /** `pref-<slug>` of the retired rule. */
  readonly rule: string;
  /** Record ids of the applications. */
  readonly evidence: ReadonlyArray<string>;
  /** When each application happened, without repeats. */
  readonly evidence_at: ReadonlyArray<string>;
  /** The trial's deadline. */
  readonly deadline: string;
  /** When the rule was retired. */
  readonly retired_at: string | null;
  readonly effect: string;
}

/** Everything the effects and the audit of a window are built from. */
export interface FrozenWindow {
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly crossTopicLedger: CrossTopicLedger | null;
  readonly reconcile: ReconcileOutcomes;
  readonly rollupPlan: RollupLadderPlan;
  readonly salienceGate: SalienceGateVerdict;
  readonly admittedIds: ReadonlyArray<string>;
  /** Pages the scan could not parse: their audit events. */
  readonly corrupted: ReadonlyArray<{ readonly path: string }>;
  readonly warnings: ReadonlyArray<DreamWarning>;
  readonly reconciliations: ReadonlyArray<Reconciliation>;
  /** Late applications whose rule's deadline could not be found (design D5a). */
  readonly notCheckable: number;
  /** Records a rebase took as seen (design D3), reported by the window's audit. */
  readonly rebasedSeen: number;
  /** The first replay's count of archived signals that may have missed a promotion (design D7). */
  readonly unrecoverable: number;
  readonly runId: string;
}

export interface WindowPlanBody {
  readonly day: string;
  readonly window: string;
  readonly bounds: { readonly from: string; readonly to: string };
  readonly instant: string;
  readonly version: number;
  /** The effects by id, kind and subject; the payloads are in `frozen`. */
  readonly effects: ReadonlyArray<{
    readonly effect: string;
    readonly kind: string;
    readonly subject: string;
  }>;
  readonly frozen: unknown;
  readonly engine_version: string;
  readonly policy_digest: string;
  readonly run: string;
}

const TAG = "$o2b";

/** Plain JSON of `value`, with maps, sets and dates tagged so {@link decodeFrozen} restores them. */
export function encodeFrozen(value: unknown): unknown {
  if (value instanceof Map) {
    return {
      [TAG]: "map",
      entries: [...value].map(([k, v]) => [encodeFrozen(k), encodeFrozen(v)]),
    };
  }
  if (value instanceof Set) return { [TAG]: "set", values: [...value].map(encodeFrozen) };
  if (value instanceof Date) return { [TAG]: "date", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeFrozen);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function") continue;
      out[key] = encodeFrozen(entry);
    }
    return out;
  }
  return value;
}

/** The value {@link encodeFrozen} encoded. */
export function decodeFrozen(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFrozen);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[TAG] === "map") {
      return new Map(
        (record["entries"] as unknown[][]).map(([k, v]) => [decodeFrozen(k), decodeFrozen(v)]),
      );
    }
    if (record[TAG] === "set") return new Set((record["values"] as unknown[]).map(decodeFrozen));
    if (record[TAG] === "date") return new Date(record["iso"] as string);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = decodeFrozen(entry);
    return out;
  }
  return value;
}

/** The hash of the dream settings a plan was made under (design D5). */
export function policyDigest(cfg: BrainConfig): string {
  return createHash("sha256")
    .update(canonicalJson(encodeFrozen(cfg)))
    .digest("hex");
}

/** The effects of a frozen window, by kind and subject. */
export function effectsOf(
  window: string,
  frozen: FrozenWindow,
): Array<{ effect: string; kind: string; subject: string }> {
  const out: Array<{ effect: string; kind: string; subject: string }> = [];
  const add = (kind: string, subject: string): void => {
    out.push({ effect: effectId(window, kind, subject), kind, subject });
  };
  for (const entry of frozen.plan.newUnconfirmed) add("preference-new", `pref-${entry.slug}`);
  for (const entry of frozen.plan.crossTopicRules) add("preference-new", `pref-${entry.slug}`);
  for (const slug of frozen.refresh.updated.keys()) add("preference-refresh", `pref-${slug}`);
  for (const entry of frozen.plan.retires) add("retire", `pref-${entry.slug}`);
  for (const id of frozen.plan.signalsToMove.keys()) add("signal-consumed", id);
  for (const id of frozen.plan.signalsToArchive.keys()) add("signal-archived", id);
  for (const entry of frozen.reconciliations) add("reconciliation", entry.rule);
  return out;
}

/** The idempotency key of a new preference a window writes. */
export function preferenceEffectKey(window: string, slug: string): string {
  return `dream-window:${effectId(window, "preference-new", `pref-${slug}`)}`;
}
