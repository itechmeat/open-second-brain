/**
 * The `rollup:` block (knowledge-intake-and-consolidation, S3) — the
 * fact rollup-ladder thresholds.
 *
 * One reason to change: when the ladder promotes facts to rollups and
 * rollups to identities. Shape problems are hard errors so a mistyped
 * threshold surfaces instead of silently reverting to the named-constant
 * default in `rollup-ladder.ts`.
 */

import type { BrainRollupConfig } from "../../types.ts";
import { requirePositiveInteger } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "rollup";

const KNOWN_KEYS = ["fact_threshold", "identity_threshold"] as const;

export function parseRollupBlock(ctx: BlockParseContext): BrainRollupConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  const partial: { fact_threshold?: number; identity_threshold?: number } = {};
  for (const key of KNOWN_KEYS) {
    if (!(key in rawMap)) continue;
    requirePositiveInteger(`rollup.${key}`, rawMap[key], ctx.source);
    partial[key] = rawMap[key] as number;
  }
  warnUnknownKeys(ctx, rawMap, KNOWN_KEYS, BLOCK);
  return partial;
}
