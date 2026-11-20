/**
 * The `quote_check:` block - the per-phase modes of the answer-time quote
 * check (`hooks/answer-quote-check.ts`): `recall`, `active` and
 * `subagent`, each `off`, `shadow` or `enforce`.
 *
 * One reason to change: what a phase may be set to. The block is parsed
 * here so it is an ordinary brain setting: written to `_brain.yaml` on a
 * vault that has not switched to the store, and to a shared settings
 * record on one that has (`o2b brain settings set quote_check.active
 * enforce` works on both). An absent phase stays absent: the resolver in
 * `src/core/config.ts` applies its default, so a vault that never names
 * the block reads exactly as before.
 */

import {
  ANSWER_QUOTE_CHECK_MODES,
  ANSWER_QUOTE_CHECK_PHASES,
  isAnswerQuoteCheckMode,
  type AnswerQuoteCheckMode,
} from "../../../config.ts";
import type { BrainQuoteCheckConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "quote_check";

export function parseQuoteCheckBlock(ctx: BlockParseContext): BrainQuoteCheckConfig | undefined {
  const map = openBlock(ctx, BLOCK);
  if (map === undefined) return undefined;
  const out: Partial<Record<(typeof ANSWER_QUOTE_CHECK_PHASES)[number], AnswerQuoteCheckMode>> = {};
  for (const phase of ANSWER_QUOTE_CHECK_PHASES) {
    if (!(phase in map)) continue;
    const raw = map[phase];
    if (!isAnswerQuoteCheckMode(raw)) {
      throw new BrainConfigError(
        `unsupported value ${JSON.stringify(raw)}; expected one of ${ANSWER_QUOTE_CHECK_MODES.join(", ")}`,
        `${BLOCK}.${phase}`,
        ctx.source,
      );
    }
    out[phase] = raw;
  }
  warnUnknownKeys(ctx, map, ANSWER_QUOTE_CHECK_PHASES, BLOCK);
  return Object.freeze(out);
}
