/**
 * Retire-sibling planner (near-duplicate defense, t_acab97de).
 *
 * When a preference retires because context proved it wrong, an active
 * paraphrase of it usually survives under another topic slug. This pure
 * planner nominates those paraphrases as advisory pairs. It never
 * retires anything: the operator accepts a pair through an existing verb
 * (`brain_apply_evidence result: outdated` or `o2b brain reject`).
 *
 * Only context-driven retires nominate. Decay retires
 * (`stale-no-evidence`, `expired-unconfirmed`) mean nobody used the rule,
 * not that the rule is wrong, and `merged-into` keeps its sibling as the
 * canonical page. Siblings are never cascaded: a sibling of a sibling is
 * not computed.
 */

import { isMergeResolved, mergePointerLookup } from "./page-meta/page-id.ts";
import {
  compareMatches,
  findNearDuplicates,
  NEAR_DUPLICATE_THRESHOLDS,
  type NearDuplicateMethod,
  type NearDuplicatePoolEntry,
  type ReadableRef,
} from "./near-duplicate.ts";
import { tokenise } from "./similarity.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "./types.ts";

export const RETIRE_SIBLING_TRIGGER_REASONS: ReadonlySet<BrainRetiredReason> = new Set([
  BRAIN_RETIRED_REASON.supersededByContext,
  BRAIN_RETIRED_REASON.rebutted,
  BRAIN_RETIRED_REASON.quarantineViolated,
  BRAIN_RETIRED_REASON.userRejected,
]);

export interface RetireSibling {
  /** `pref-*` id being retired. */
  readonly retiring_id: string;
  /** Active `pref-*` id that resembles it. */
  readonly sibling_id: string;
  readonly score: number;
  readonly method: NearDuplicateMethod;
}

export interface RetireSiblingOptions {
  readonly readable: ReadableRef;
  /** Retiring ids the apply step held back; their siblings are dropped. */
  readonly gated: ReadonlySet<string>;
}

/**
 * Project active preferences into the sibling pool, leaving out pages a
 * merge already resolved (the predicate every duplicate detector asks).
 */
export function retireSiblingPool(
  prefs: ReadonlyArray<{
    readonly id: string;
    readonly principle: string;
    readonly merged_into?: string;
  }>,
): ReadonlyArray<{ id: string; principle: string }> {
  const pointerOf = mergePointerLookup(prefs.map((p) => [p.id, p.merged_into ?? null] as const));
  return prefs
    .filter((p) => !isMergeResolved(p.id, pointerOf))
    .map((p) => ({ id: p.id, principle: p.principle }));
}

/**
 * Nominate active siblings of every context-driven, ungated, readable
 * retire. The pool crosses topic and scope buckets and excludes the whole
 * retiring set. Output order is `(retiring_id, -score, sibling_id)`.
 */
export function planRetireSiblings(
  active: ReadonlyArray<{ id: string; principle: string }>,
  retiring: ReadonlyArray<{ id: string; principle: string; reason: BrainRetiredReason }>,
  opts: RetireSiblingOptions,
): ReadonlyArray<RetireSibling> {
  const retiringIds = new Set(retiring.map((r) => r.id));
  // Sorted by id so the output never depends on the order the caller
  // scanned the vault in.
  const pool: NearDuplicatePoolEntry[] = active
    .filter((p) => !retiringIds.has(p.id))
    .map((p) => ({ ref: p.id, tokens: tokenise(p.principle) }))
    .toSorted((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const out: RetireSibling[] = [];
  for (const r of retiring) {
    if (!RETIRE_SIBLING_TRIGGER_REASONS.has(r.reason)) continue;
    if (opts.gated.has(r.id) || !opts.readable(r.id)) continue;
    const { matches } = findNearDuplicates({ ref: r.id, tokens: tokenise(r.principle) }, pool, {
      threshold: NEAR_DUPLICATE_THRESHOLDS.retireSiblingLexical,
      readable: opts.readable,
      // Lexical scoring over active preferences is cheap, and a capped
      // scan would silently never score a sibling sorting past the cap.
      cap: pool.length,
    });
    for (const m of matches) {
      out.push({ retiring_id: r.id, sibling_id: m.ref, score: m.score, method: m.method });
    }
  }
  return out.toSorted(compareRetireSiblings);
}

/** `(retiring_id, -score, sibling_id)`, by code unit so the order never depends on locale. */
export function compareRetireSiblings(a: RetireSibling, b: RetireSibling): number {
  if (a.retiring_id !== b.retiring_id) return a.retiring_id < b.retiring_id ? -1 : 1;
  return compareMatches(
    { ref: a.sibling_id, score: a.score },
    { ref: b.sibling_id, score: b.score },
  );
}
