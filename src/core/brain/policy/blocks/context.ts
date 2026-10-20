/**
 * The two blocks of the cycle-20261020 substrate wave: `cross_topic:` -
 * the dream pass's opt-in promotion of recurring cross-topic rules - and
 * `context:` - the operator's declaration of the host model's context
 * window. They ship as one substrate commit and share this module the
 * way the continuity-hygiene trio does: each is consumed by another lane
 * (the dream lane and the context-window lane respectively) and neither
 * consumer exists yet, so the parsers live together until their features
 * arrive.
 *
 * One reason to change: what an operator may declare about a cross-topic
 * promotion or a declared window. Both blocks are pure opt-ins - a whole
 * block absent resolves to the pre-block behaviour byte-identically -
 * and both store what the operator declared rather than second-guessing
 * it: an out-of-range but well-formed number is stored here, and what
 * the consumer does next differs by block. The cross-topic resolver
 * floors its knobs, disclosing every clamp; the context window's
 * operator declarations are first-hand facts that pass through the
 * resolver UNCLAMPED (model-window.ts; design decision 2) - only the
 * resolver's GUESSED answers, the `1m` suffix expansion and the
 * unknown-model default, are clamped to its band. A value of the wrong
 * SHAPE is refused here, because a knob that silently ignored its
 * operator would mislead every run with no sign of why.
 */

import type { BrainContextConfig, BrainCrossTopicConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { requirePositiveInteger, requireUnitInterval } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const CROSS_TOPIC_KEYS = ["enabled", "min_topics", "jaccard"] as const;
const CONTEXT_KEYS = ["window_tokens"] as const;

/**
 * The window an absent `context.window_tokens` resolves to downstream.
 * Named here rather than in the resolver that lands with its consumer
 * because the config template must render a default from a named table,
 * never a literal repeated beside its consumer - and it matches the
 * figure `token-footprint.ts` already treats as the de-facto standard
 * window.
 */
export const CONTEXT_WINDOW_TOKENS_DEFAULT = 200_000;

/** A boolean key; anything else is refused rather than coerced. */
function requireBoolean(field: string, value: unknown, source: string | null): boolean {
  if (typeof value !== "boolean") {
    throw new BrainConfigError(
      `${field} must be true or false; got ${JSON.stringify(value)}`,
      field,
      source,
    );
  }
  return value;
}

export function parseCrossTopicBlock(ctx: BlockParseContext): BrainCrossTopicConfig | undefined {
  const rawMap = openBlock(ctx, "cross_topic");
  if (rawMap === undefined) return undefined;

  const partial: { enabled?: boolean; min_topics?: number; jaccard?: number } = {};
  if ("enabled" in rawMap) {
    partial.enabled = requireBoolean("cross_topic.enabled", rawMap["enabled"], ctx.source);
  }
  if ("min_topics" in rawMap) {
    requirePositiveInteger("cross_topic.min_topics", rawMap["min_topics"], ctx.source);
    partial.min_topics = rawMap["min_topics"] as number;
  }
  if ("jaccard" in rawMap) {
    requireUnitInterval("cross_topic.jaccard", rawMap["jaccard"], ctx.source);
    partial.jaccard = rawMap["jaccard"] as number;
  }
  warnUnknownKeys(ctx, rawMap, CROSS_TOPIC_KEYS, "cross_topic");
  return Object.freeze(partial);
}

export function parseContextBlock(ctx: BlockParseContext): BrainContextConfig | undefined {
  const rawMap = openBlock(ctx, "context");
  if (rawMap === undefined) return undefined;

  const partial: { window_tokens?: number } = {};
  if ("window_tokens" in rawMap) {
    requirePositiveInteger("context.window_tokens", rawMap["window_tokens"], ctx.source);
    partial.window_tokens = rawMap["window_tokens"] as number;
  }
  warnUnknownKeys(ctx, rawMap, CONTEXT_KEYS, "context");
  return Object.freeze(partial);
}
