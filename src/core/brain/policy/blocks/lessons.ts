/**
 * The `lessons:` block (t_62363378) — tuning for the signed,
 * recency-scored lessons digest (`Brain/lessons.md`).
 *
 * One reason to change: how a lesson's score decays and when it earns
 * `preferred`. Out-of-range values are hard errors — an operator-tunable
 * knob must never silently clamp. The half-life default matches the
 * working-memory continuity decay (30 days); the corroboration floor
 * (2 distinct results) keeps a one-off application from promoting
 * straight to `preferred`.
 *
 * Also home of the promotion scope resolution (t_1e952e43): which scopes
 * a lesson may promote from, read from the machine config and its
 * environment twin rather than from `_brain.yaml`, because promotion is a
 * consent-bearing operator decision, not a digest tuning knob.
 */

import { discoverConfig, LESSONS_PROMOTION_SCOPES_ENV_KEY } from "../../../config.ts";
import type { BrainLessonsConfig } from "../../types.ts";
import { readBoundedInt } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "lessons";

// ----- Promotion scopes (t_1e952e43) -----------------------------------------

/**
 * The flat machine-config key holding the scope names a lesson may promote
 * from (operator-approved lesson promotion, t_1e952e43). Comma-separated;
 * the environment twin lives beside the other config keys in
 * `src/core/config.ts` (`LESSONS_PROMOTION_SCOPES_ENV_KEY`). Absent or
 * empty DISABLES promotion entirely - the safe direction, since promotion
 * copies brain text into files agents read.
 */
export const LESSONS_PROMOTION_SCOPES_CONFIG_KEY = "lessons.promotion.scopes";

/** Where a resolved scope list came from, named for honest reporting. */
export const LESSONS_PROMOTION_SCOPES_ORIGIN = Object.freeze({
  env: "env",
  config: "config",
  absent: "absent",
} as const);
export type LessonsPromotionScopesOrigin =
  (typeof LESSONS_PROMOTION_SCOPES_ORIGIN)[keyof typeof LESSONS_PROMOTION_SCOPES_ORIGIN];

export interface LessonsPromotionScopesResolution {
  /** The enabled scope names, NFC-normalized and trimmed, in given order. */
  readonly scopes: ReadonlyArray<string>;
  /**
   * The named count of enabled scopes. Zero means promotion is DISABLED
   * (the key and its environment twin are absent or empty, or the value
   * was malformed) - callers branch on this count rather than guessing
   * from array emptiness.
   */
  readonly count: number;
  /** Which layer supplied the value, or `absent` when none did. */
  readonly origin: LessonsPromotionScopesOrigin;
}

/**
 * Resolve the promotion scope list: the environment twin wins, then the
 * flat machine-config key, then absent. Parsing follows the
 * `resolveCounterpartyBriefTriggers` rules: entries are NFC-normalized and
 * trimmed, empty entries dropped, and a bracket-shaped value (real YAML
 * list syntax the flat config parser cannot represent) is malformed - it
 * resolves `absent` rather than shipping scope names no preference ever
 * carries. An empty result disables promotion, never widens it.
 */
/** Split a comma-separated raw value into normalized, trimmed scope names. */
function parsePromotionScopes(raw: string): string[] {
  const scopes: string[] = [];
  for (const part of raw.split(",")) {
    const scope = part.normalize("NFC").trim();
    if (scope.length > 0) scopes.push(scope);
  }
  return scopes;
}

/** True when a value is bracket-shaped list syntax the flat parser cannot represent. */
function isBracketShapedList(raw: string): boolean {
  return raw.startsWith("[") && raw.endsWith("]");
}

export function resolveLessonsPromotionScopes(
  configPath?: string,
): LessonsPromotionScopesResolution {
  const env = process.env[LESSONS_PROMOTION_SCOPES_ENV_KEY]?.trim();
  if (env !== undefined && env !== "" && !isBracketShapedList(env)) {
    const scopes = parsePromotionScopes(env);
    return { scopes, count: scopes.length, origin: LESSONS_PROMOTION_SCOPES_ORIGIN.env };
  }
  const raw = discoverConfig(configPath).data[LESSONS_PROMOTION_SCOPES_CONFIG_KEY]?.trim();
  if (raw !== undefined && raw !== "" && !isBracketShapedList(raw)) {
    const scopes = parsePromotionScopes(raw);
    return { scopes, count: scopes.length, origin: LESSONS_PROMOTION_SCOPES_ORIGIN.config };
  }
  return { scopes: [], count: 0, origin: LESSONS_PROMOTION_SCOPES_ORIGIN.absent };
}

export const LESSONS_HALF_LIFE_DAYS_DEFAULT = 30;
export const LESSONS_HALF_LIFE_DAYS_MIN = 1;
export const LESSONS_HALF_LIFE_DAYS_MAX = 365;
export const LESSONS_CORROBORATION_MIN_DEFAULT = 2;
export const LESSONS_CORROBORATION_MIN_MIN = 1;
export const LESSONS_CORROBORATION_MIN_MAX = 100;
export const LESSONS_LIMIT_DEFAULT = 20;
export const LESSONS_LIMIT_MIN = 1;
export const LESSONS_LIMIT_MAX = 200;

const KNOWN_KEYS = ["half_life_days", "corroboration_min", "limit"] as const;

export function parseLessonsBlock(ctx: BlockParseContext): BrainLessonsConfig | undefined {
  const lessonsMap = openBlock(ctx, BLOCK);
  if (lessonsMap === undefined) return undefined;

  const halfLife = readBoundedInt(
    lessonsMap,
    "half_life_days",
    LESSONS_HALF_LIFE_DAYS_MIN,
    LESSONS_HALF_LIFE_DAYS_MAX,
    "lessons.half_life_days",
    ctx.source,
  );
  const corroborationMin = readBoundedInt(
    lessonsMap,
    "corroboration_min",
    LESSONS_CORROBORATION_MIN_MIN,
    LESSONS_CORROBORATION_MIN_MAX,
    "lessons.corroboration_min",
    ctx.source,
  );
  const limit = readBoundedInt(
    lessonsMap,
    "limit",
    LESSONS_LIMIT_MIN,
    LESSONS_LIMIT_MAX,
    "lessons.limit",
    ctx.source,
  );
  warnUnknownKeys(ctx, lessonsMap, KNOWN_KEYS, BLOCK);
  return {
    ...(halfLife !== undefined ? { half_life_days: halfLife } : {}),
    ...(corroborationMin !== undefined ? { corroboration_min: corroborationMin } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}
