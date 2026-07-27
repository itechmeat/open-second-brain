/**
 * `o2b search feedback` and `o2b search weights` (recall-trust-suite) —
 * the two ends of the learned-weight loop: recording an up/down verdict on
 * a result, and inspecting or resetting the multipliers those verdicts
 * produced.
 */

import {
  captureRecallFeedback,
  loadFeedbackEvents,
  readLearnedWeights,
  resetLearnedWeights,
  LEARNED_WEIGHT_MIN,
  LEARNED_WEIGHT_MAX,
  type LearnedWeights,
} from "../../../core/search/index.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

export async function cmdSearchFeedback(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    query: { type: "string" },
    result: { type: "string" },
    verdict: { type: "string" },
    json: { type: "boolean" },
  });
  const query = flagString(flags, "query") ?? "";
  const resultPath = flagString(flags, "result") ?? "";
  const verdict = flagString(flags, "verdict") ?? "";
  if (!query || !resultPath) {
    throw new CliError("usage: o2b search feedback --query <q> --result <path> --verdict up|down");
  }
  if (verdict !== "up" && verdict !== "down") {
    throw new CliError("--verdict must be 'up' or 'down'");
  }
  const cfg = resolveConfig(flags);
  const outcome = await captureRecallFeedback(cfg, { query, resultPath, verdict });
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        recorded: true,
        result_found: outcome.resultFound,
        file: outcome.file,
        learned: outcome.learned,
      }) + "\n",
    );
    return 0;
  }
  const found = outcome.resultFound
    ? ""
    : " (result not in current top-50; recorded with zero contributions)";
  process.stdout.write(
    `recorded ${verdict} for ${resultPath}${found}\n` +
      `learned weights now: ${formatLearnedWeights(outcome.learned)}\n`,
  );
  return 0;
}

export async function cmdSearchWeights(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    reset: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const json = flagBoolean(flags, "json");
  if (flagBoolean(flags, "reset")) {
    resetLearnedWeights(cfg.vault);
    if (json) {
      process.stdout.write(JSON.stringify({ reset: true }) + "\n");
    } else {
      process.stdout.write("learned weights reset (feedback events kept)\n");
    }
    return 0;
  }
  const learned = readLearnedWeights(cfg.vault);
  const payload = {
    enabled: cfg.recall.learnedWeightsEnabled,
    base: {
      keywordWeight: cfg.keywordWeight,
      semanticWeight: cfg.semanticWeight,
    },
    learned,
    events: loadFeedbackEvents(cfg.vault).length,
    bounds: { min: LEARNED_WEIGHT_MIN, max: LEARNED_WEIGHT_MAX },
  };
  if (json) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  const lines = [
    `learned weights: ${payload.enabled ? "enabled" : "disabled (search_learned_weights_enabled)"}`,
    `base: kw=${cfg.keywordWeight} sem=${cfg.semanticWeight}`,
    learned === null
      ? "learned: none (no feedback recorded)"
      : `learned: ${formatLearnedWeights(learned)} from ${learned.events} event(s)`,
    `bounds: [${LEARNED_WEIGHT_MIN}, ${LEARNED_WEIGHT_MAX}]`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function formatLearnedWeights(w: LearnedWeights): string {
  return (
    `kw=${w.keywordMul.toFixed(3)} sem=${w.semanticMul.toFixed(3)} ` +
    `ent=${w.entityMul.toFixed(3)} rec=${w.recencyMul.toFixed(3)}`
  );
}
