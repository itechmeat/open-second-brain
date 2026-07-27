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
 */

import type { BrainLessonsConfig } from "../../types.ts";
import { readBoundedInt } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "lessons";

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
