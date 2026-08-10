/**
 * The `active:` block — what `Brain/active.md` renders and how much of it
 * is injected at SessionStart.
 *
 * One reason to change: the size of the agent's always-on preamble -
 * which is why the cap on the operator's standing-rules block lives here
 * too, even though that block is exempt from the injection budget and
 * charged against its own number.
 * Out-of-range values are hard errors: an operator-tunable knob that
 * silently reverted to its default would be indistinguishable from never
 * having been set.
 */

import type { BrainActiveConfig, BrainConfig, BrainMostAppliedConfig } from "../../types.ts";
import {
  STANDING_RULES_MAX_CHARS_DEFAULT,
  STANDING_RULES_MAX_CHARS_MAX,
  STANDING_RULES_MAX_CHARS_MIN,
} from "../../standing-rules.ts";
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
 * The window every most-applied consumer uses when `_brain.yaml` does not
 * configure one. One struct rather than two loose constants, because both
 * readers of this block (`active.md` and the digest) need the pair
 * together and a half-taken default would report a window the operator
 * never chose.
 */
export const BRAIN_MOST_APPLIED_DEFAULTS: BrainMostAppliedConfig = Object.freeze({
  window_days: MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  limit: MOST_APPLIED_LIMIT_DEFAULT,
});

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
  "standing_rules_max_chars",
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

  const injectBudgetChars = optionalCharCount(
    activeMap,
    "inject_budget_chars",
    INJECT_BUDGET_CHARS_MIN,
    INJECT_BUDGET_CHARS_MAX,
    ctx.source,
  );
  const standingRulesMaxChars = optionalCharCount(
    activeMap,
    "standing_rules_max_chars",
    STANDING_RULES_MAX_CHARS_MIN,
    STANDING_RULES_MAX_CHARS_MAX,
    ctx.source,
  );

  warnUnknownKeys(ctx, activeMap, KNOWN_KEYS, BLOCK);
  return {
    ...(mostApplied !== undefined ? { most_applied: mostApplied } : {}),
    ...(injectBudgetChars !== undefined ? { inject_budget_chars: injectBudgetChars } : {}),
    ...(standingRulesMaxChars !== undefined
      ? { standing_rules_max_chars: standingRulesMaxChars }
      : {}),
  };
}

/**
 * Read one optional character-count knob: absent stays absent so the
 * consumer's own default applies, present is range-checked as a hard
 * error. Both knobs in this block are the same shape, and writing the
 * `in`-check plus the range call twice is how the second one eventually
 * gets a clamped bound the first does not have.
 */
function optionalCharCount(
  activeMap: Readonly<Record<string, unknown>>,
  key: string,
  min: number,
  max: number,
  source: string | null,
): number | undefined {
  if (!(key in activeMap)) return undefined;
  requireIntegerInRange(`${BLOCK}.${key}`, activeMap[key], min, max, source);
  return activeMap[key] as number;
}

/**
 * Read side of `active.most_applied`: the configured window, or
 * {@link BRAIN_MOST_APPLIED_DEFAULTS} when the block (or the whole
 * `active:` section) was omitted. Shared by `active.md` and the digest so
 * the two cannot report different windows for the same vault.
 */
export function resolveMostApplied(cfg: BrainConfig): BrainMostAppliedConfig {
  return cfg.active?.most_applied ?? BRAIN_MOST_APPLIED_DEFAULTS;
}

/**
 * Read side of `active.standing_rules_max_chars`: the configured cap, or
 * the reader's default. Takes a nullable config so the two callers - the
 * SessionStart hook, which absorbs an unreadable `_brain.yaml` into the
 * defaults, and `brain_context`, which does the same - resolve the
 * number through one function instead of each spelling the fallback.
 */
export function resolveStandingRulesMaxChars(cfg: BrainConfig | null): number {
  return cfg?.active?.standing_rules_max_chars ?? STANDING_RULES_MAX_CHARS_DEFAULT;
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
