/**
 * Pure decision core for the additive nav tier (retrieval-quality-and-context-
 * delivery, D1).
 *
 * The always-on injection kernel (active-inject / recall-inject) is untouched.
 * This tier is additive and cadence-controlled: given the already-rendered
 * structural navmap block and whether a fresh cadence stamp is still live, it
 * decides to inject the map or to suppress. Every outcome is an explicit,
 * audit-worthy decision (never a silent fallback), mirroring the recall-inject
 * precedent. The core is I/O-free so the cadence-window arithmetic and the
 * audit shaping are unit-testable without a vault.
 */

/** Default cadence window, in minutes, between nav-tier injections. */
export const NAV_TIER_CADENCE_MINUTES_DEFAULT = 30;

export type NavSuppressReason = "cadence" | "empty";

export type NavInjectDecision =
  | { readonly kind: "inject"; readonly block: string; readonly chars: number }
  | { readonly kind: "suppress"; readonly reason: NavSuppressReason };

/**
 * Decide whether to inject the nav tier this turn.
 *
 * - `cadenceActive` true -> suppress: a prior injection's cadence window is
 *   still live, so the map is not re-injected (this is the "only on cadence"
 *   guarantee, and it lets the caller skip building the navmap entirely).
 * - empty block -> suppress: there is no structural map to show (no index yet
 *   or an all-orphan graph).
 * - otherwise -> inject, reporting the exact added char count for the audit.
 */
export function decideNavInject(navmapBlock: string, cadenceActive: boolean): NavInjectDecision {
  if (cadenceActive) return Object.freeze({ kind: "suppress", reason: "cadence" });
  if (navmapBlock.length === 0) return Object.freeze({ kind: "suppress", reason: "empty" });
  return Object.freeze({ kind: "inject", block: navmapBlock, chars: navmapBlock.length });
}

/**
 * Shape one payload-safe audit record for a nav-tier decision: the decision
 * kind, the suppress reason (when suppressed), and the added char count (when
 * injected) - never the navmap content itself.
 */
export function navInjectAuditDetails(decision: NavInjectDecision): Record<string, unknown> {
  if (decision.kind === "inject") {
    return { decision: "inject", added_chars: decision.chars };
  }
  return { decision: "suppress", reason: decision.reason };
}
