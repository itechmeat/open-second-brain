/**
 * The three blocks of the continuity-hygiene-freshness suite:
 * `hygiene:`, `anticipatory:` and `recall:`.
 *
 * One reason to change: how the suite trades freshness against cost —
 * what resolves a conflict, how long an anticipatory answer stays warm,
 * and how a budget overrun is trimmed. They ship and change as one
 * feature, which is why they share a module.
 */

import type {
  BrainAnticipatoryConfig,
  BrainHygieneConfig,
  BrainRecallConfig,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requirePositiveInteger } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const HYGIENE_KEYS = ["resolver_cmd", "dedup_threshold"] as const;
const ANTICIPATORY_KEYS = ["ttl_seconds", "max_tokens"] as const;
const RECALL_KEYS = ["degradation"] as const;

/** The two per-entry budget trim strategies `recall.degradation` selects. */
const RECALL_DEGRADATION_MODES = ["hard-cut", "staged"] as const;

/**
 * `resolver_cmd` is operator-configured only - it is never accepted from
 * a tool argument, so this is the single place it can enter the process.
 */
export function parseHygieneBlock(ctx: BlockParseContext): BrainHygieneConfig | undefined {
  const rawMap = openBlock(ctx, "hygiene");
  if (rawMap === undefined) return undefined;

  const partial: { resolver_cmd?: string; dedup_threshold?: number } = {};
  if ("resolver_cmd" in rawMap) {
    const cmd = rawMap["resolver_cmd"];
    if (typeof cmd !== "string" || cmd.trim() === "") {
      throw new BrainConfigError(
        `must be a non-empty string; got ${describe(cmd)}`,
        "hygiene.resolver_cmd",
        ctx.source,
      );
    }
    partial.resolver_cmd = cmd;
  }
  if ("dedup_threshold" in rawMap) {
    const threshold = rawMap["dedup_threshold"];
    if (typeof threshold !== "number" || !(threshold > 0) || threshold > 1) {
      throw new BrainConfigError(
        `must be a number in (0, 1]; got ${describe(threshold)}`,
        "hygiene.dedup_threshold",
        ctx.source,
      );
    }
    partial.dedup_threshold = threshold;
  }
  warnUnknownKeys(ctx, rawMap, HYGIENE_KEYS, "hygiene");
  return Object.freeze(partial);
}

export function parseAnticipatoryBlock(
  ctx: BlockParseContext,
): BrainAnticipatoryConfig | undefined {
  const rawMap = openBlock(ctx, "anticipatory");
  if (rawMap === undefined) return undefined;

  const partial: { ttl_seconds?: number; max_tokens?: number } = {};
  for (const key of ANTICIPATORY_KEYS) {
    if (!(key in rawMap)) continue;
    requirePositiveInteger(`anticipatory.${key}`, rawMap[key], ctx.source);
    partial[key] = rawMap[key] as number;
  }
  warnUnknownKeys(ctx, rawMap, ANTICIPATORY_KEYS, "anticipatory");
  return Object.freeze(partial);
}

export function parseRecallBlock(ctx: BlockParseContext): BrainRecallConfig | undefined {
  const rawMap = openBlock(ctx, "recall");
  if (rawMap === undefined) return undefined;

  const partial: { degradation?: (typeof RECALL_DEGRADATION_MODES)[number] } = {};
  if ("degradation" in rawMap) {
    const mode = rawMap["degradation"];
    if (mode !== "hard-cut" && mode !== "staged") {
      throw new BrainConfigError(
        `must be 'hard-cut' or 'staged'; got ${describe(mode)}`,
        "recall.degradation",
        ctx.source,
      );
    }
    partial.degradation = mode;
  }
  warnUnknownKeys(ctx, rawMap, RECALL_KEYS, "recall");
  return Object.freeze(partial);
}
