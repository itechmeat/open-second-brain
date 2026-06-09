/**
 * `o2b brain tune run|status|reset` (t_ae973491): opt-in self-tuning
 * recall. `run` grid-evaluates the bounded parameter space against a
 * benchmark dataset, persists the winner to Brain/search/tuning.json,
 * and records one `self_tuning` metric; `status` renders the persisted
 * choice; `reset` deletes it. Search only honors the tuned state when
 * `search_self_tuning_enabled` is on.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { readFileSync } from "node:fs";

import { parseRecallBenchmarkDataset } from "../../../core/search/benchmark.ts";
import { loadTunedParameters, resetTuning, tuneRecall } from "../../../core/search/tuning.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { SearchError } from "../../../core/search/types.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain tune run --dataset <path> [--k N] | status | reset  [--vault <path>] [--json]";

export async function cmdBrainTune(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    dataset: { type: "string" },
    k: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const action = positional[0];
  if (
    (action !== "run" && action !== "status" && action !== "reset") ||
    positional.length !== 1 ||
    (action === "run" && flags["dataset"] === undefined)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  try {
    if (action === "status") {
      const tuned = loadTunedParameters(vault);
      const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
      if (asJson) {
        okJson({ enabled: searchConfig.recall.selfTuningEnabled, tuned });
      } else if (tuned === null) {
        ok("tune: no valid tuned parameters persisted - run: o2b brain tune run --dataset <path>");
      } else {
        ok(
          `tune: pool x${tuned.poolMultiplier}, depth ${tuned.traversalDepth}, ` +
            `learned-weights ${tuned.learnedWeights ? "on" : "off"}, ` +
            `expansion ${tuned.expansion ? "on" : "off"} ` +
            `(${searchConfig.recall.selfTuningEnabled ? "ACTIVE" : "inactive - enable search_self_tuning_enabled"})`,
        );
      }
      return 0;
    }

    if (action === "reset") {
      const removed = resetTuning(vault);
      if (asJson) okJson({ removed });
      else ok(removed ? "tune: persisted state removed" : "tune: nothing to remove");
      return 0;
    }

    // run
    const k = flags["k"] !== undefined ? Number(flags["k"]) : undefined;
    if (k !== undefined && (!Number.isInteger(k) || k < 1)) {
      process.stderr.write("brain tune run: --k must be a positive integer\n");
      return 2;
    }
    const datasetPath = flags["dataset"] as string;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(datasetPath, "utf8"));
    } catch (exc) {
      process.stderr.write(
        `brain tune run: cannot read dataset ${datasetPath}: ${(exc as Error).message}\n`,
      );
      return 2;
    }
    const dataset = parseRecallBenchmarkDataset(raw);
    const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
    const now = new Date();
    const report = await tuneRecall(searchConfig, dataset, {
      ...(k !== undefined ? { k } : {}),
      now,
    });
    try {
      appendMetric(vault, {
        surface: "self_tuning",
        runAt: isoSecond(now),
        payload: {
          chosen: report.chosen,
          evaluated: report.evaluated.length,
          best_mrr: Math.max(...report.evaluated.map((e) => e.mrr)),
          dataset_hash: report.datasetHash,
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    if (asJson) {
      okJson({
        chosen: report.chosen,
        evaluated: report.evaluated.map((e) => ({
          params: e.params,
          mrr: e.mrr,
          hit_at_k: e.hitAtK,
        })),
      });
    } else {
      ok(
        `tune: chose pool x${report.chosen.poolMultiplier}, depth ${report.chosen.traversalDepth}, ` +
          `learned-weights ${report.chosen.learnedWeights ? "on" : "off"}, ` +
          `expansion ${report.chosen.expansion ? "on" : "off"} ` +
          `over ${report.evaluated.length} grid points`,
      );
      ok(
        "activate with: search_self_tuning_enabled: true (config) or OPEN_SECOND_BRAIN_SEARCH_SELF_TUNING=1",
      );
    }
    return 0;
  } catch (exc) {
    if (exc instanceof SearchError && exc.code === "INVALID_INPUT") {
      process.stderr.write(`brain tune ${action}: ${exc.message}\n`);
      return 2;
    }
    const message = `tune ${action} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
