/**
 * The per-phase modes of the answer-time quote check for one vault,
 * wherever its brain settings live.
 *
 * A vault that has not switched to the store keeps them in the
 * `quote_check` block of `Brain/_brain.yaml`, read by the resolvers in
 * `src/core/config.ts` (an absent file or block reads as the defaults, a
 * block that cannot be honoured raises). A switched vault, whose
 * `Brain/` tree may be gone, keeps them as shared settings records
 * (`brain.quote_check.<phase>`), written by `o2b brain settings set
 * quote_check.<phase> <mode>` and read here through the one store-backed
 * settings reader. There the settings are never absent: an unset phase is
 * the default, and settings that cannot be read raise as the file does.
 */

import {
  ANSWER_QUOTE_CHECK_DEFAULT,
  ANSWER_QUOTE_CHECK_PHASES,
  resolveAnswerQuoteCheckActive,
  resolveAnswerQuoteCheckRecall,
  resolveAnswerQuoteCheckSubagent,
  type AnswerQuoteCheckMode,
  type AnswerQuoteCheckPhase,
} from "../config.ts";
import { brainConfigPath } from "./paths.ts";
import { brainSettingsFromStore } from "./policy/load.ts";
import { readBrainSettingsFromStore } from "./policy/settings-source.ts";

export type AnswerQuoteCheckModes = Readonly<Record<AnswerQuoteCheckPhase, AnswerQuoteCheckMode>>;

/** Every phase's mode for `vault`; throws when the settings in force cannot be read. */
export function resolveAnswerQuoteCheckModes(vault: string): AnswerQuoteCheckModes {
  if (brainSettingsFromStore(vault)) {
    const block = readBrainSettingsFromStore().config.quote_check ?? {};
    const out = {} as Record<AnswerQuoteCheckPhase, AnswerQuoteCheckMode>;
    for (const phase of ANSWER_QUOTE_CHECK_PHASES) {
      out[phase] = block[phase] ?? ANSWER_QUOTE_CHECK_DEFAULT;
    }
    return Object.freeze(out);
  }
  const path = brainConfigPath(vault);
  return Object.freeze({
    recall: resolveAnswerQuoteCheckRecall(path),
    active: resolveAnswerQuoteCheckActive(path),
    subagent: resolveAnswerQuoteCheckSubagent(path),
  });
}
