/**
 * The `active:` block — what `Brain/active.md` renders and how much of it
 * is injected at SessionStart.
 *
 * One reason to change: the size of the agent's always-on preamble.
 * Out-of-range values are hard errors: an operator-tunable knob that
 * silently reverted to its default would be indistinguishable from never
 * having been set.
 */

import type { BrainActiveConfig, BrainMostAppliedConfig } from "../../types.ts";
import { requireIntegerInRange } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "active";

/**
 * Bounds applied to `active.most_applied.{window_days, limit}` at load
 * time. Values outside these ranges are hard errors — clamping silently
 * would mask the operator's intent.
 */
export const MOST_APPLIED_WINDOW_DAYS_MIN = 1;
export const MOST_APPLIED_WINDOW_DAYS_MAX = 365;
export const MOST_APPLIED_LIMIT_MIN = 1;
export const MOST_APPLIED_LIMIT_MAX = 50;
/** Default window when `_brain.yaml` lacks `active.most_applied.window_days`. */
export const MOST_APPLIED_WINDOW_DAYS_DEFAULT = 30;
/** Default top-N limit when `_brain.yaml` lacks `active.most_applied.limit`. */
export const MOST_APPLIED_LIMIT_DEFAULT = 10;

/**
 * Character budget for the active.md body injected at SessionStart
 * (token-diet, t_40eb1de7). ~2K tokens - enough for every confirmed
 * rule on a typical vault, small enough that a runaway preference set
 * cannot flood the session preamble. Override via
 * `active.inject_budget_chars`.
 */
export const INJECT_BUDGET_CHARS_DEFAULT = 8000;
export const INJECT_BUDGET_CHARS_MIN = 500;
export const INJECT_BUDGET_CHARS_MAX = 200_000;

const KNOWN_KEYS = [
  "most_applied_window_days",
  "most_applied_limit",
  "inject_budget_chars",
] as const;

/**
 * The YAML keys are flat at level 2 to fit the existing two-level
 * parser; the in-memory shape `BrainActiveConfig.most_applied` still
 * groups them so downstream consumers (`active.md`, `brain_digest`)
 * can pass one struct around.
 */
export function parseActiveBlock(ctx: BlockParseContext): BrainActiveConfig | undefined {
  const activeMap = openBlock(ctx, BLOCK);
  if (activeMap === undefined) return undefined;

  const mostApplied = parseMostApplied(activeMap, ctx.source);

  let injectBudgetChars: number | undefined;
  if ("inject_budget_chars" in activeMap) {
    requireIntegerInRange(
      "active.inject_budget_chars",
      activeMap["inject_budget_chars"],
      INJECT_BUDGET_CHARS_MIN,
      INJECT_BUDGET_CHARS_MAX,
      ctx.source,
    );
    injectBudgetChars = activeMap["inject_budget_chars"] as number;
  }

  warnUnknownKeys(ctx, activeMap, KNOWN_KEYS, BLOCK);
  return {
    ...(mostApplied !== undefined ? { most_applied: mostApplied } : {}),
    ...(injectBudgetChars !== undefined ? { inject_budget_chars: injectBudgetChars } : {}),
  };
}

/**
 * Either key alone opts the block in; the other one falls back to its
 * default, so `most_applied` is always a complete struct or absent
 * entirely and consumers never see a half-configured window.
 */
function parseMostApplied(
  activeMap: Readonly<Record<string, unknown>>,
  source: string | null,
): BrainMostAppliedConfig | undefined {
  const hasWindow = "most_applied_window_days" in activeMap;
  const hasLimit = "most_applied_limit" in activeMap;
  if (!hasWindow && !hasLimit) return undefined;

  const windowDays = hasWindow
    ? activeMap["most_applied_window_days"]
    : MOST_APPLIED_WINDOW_DAYS_DEFAULT;
  const limit = hasLimit ? activeMap["most_applied_limit"] : MOST_APPLIED_LIMIT_DEFAULT;
  requireIntegerInRange(
    "active.most_applied_window_days",
    windowDays,
    MOST_APPLIED_WINDOW_DAYS_MIN,
    MOST_APPLIED_WINDOW_DAYS_MAX,
    source,
  );
  requireIntegerInRange(
    "active.most_applied_limit",
    limit,
    MOST_APPLIED_LIMIT_MIN,
    MOST_APPLIED_LIMIT_MAX,
    source,
  );
  return { window_days: windowDays as number, limit: limit as number };
}
