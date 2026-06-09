/**
 * `o2b brain benchmark run --dataset <path>` (t_e2215d49): score the
 * vault's live hybrid recall against a fixed query/expected-result
 * dataset - hit@k and MRR per query and aggregate - and record one
 * `recall_benchmark` metric so the dashboard can chart recall quality
 * over time.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { readFileSync } from "node:fs";

import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../../../core/search/benchmark.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { SearchError } from "../../../core/search/types.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain benchmark run --dataset <path> [--k N] [--expand]  [--vault <path>] [--json]";

export async function cmdBrainBenchmark(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    dataset: { type: "string" },
    k: { type: "string" },
    expand: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const datasetPath = flags["dataset"] as string | undefined;
  if (positional[0] !== "run" || positional.length !== 1 || datasetPath === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const k = flags["k"] !== undefined ? Number(flags["k"]) : undefined;
  if (k !== undefined && (!Number.isInteger(k) || k < 1)) {
    process.stderr.write("brain benchmark run: --k must be a positive integer\n");
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);

  try {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(datasetPath, "utf8"));
    } catch (exc) {
      process.stderr.write(
        `brain benchmark run: cannot read dataset ${datasetPath}: ${(exc as Error).message}\n`,
      );
      return 2;
    }
    const dataset = parseRecallBenchmarkDataset(raw);
    const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
    const now = new Date();
    const report = await runRecallBenchmark(searchConfig, dataset, {
      ...(k !== undefined ? { k } : {}),
      expand: flags["expand"] === true,
    });
    try {
      appendMetric(vault, {
        surface: "recall_benchmark",
        runAt: isoSecond(now),
        payload: {
          total: report.total,
          k: report.k,
          expand: report.expand,
          hit_at_k: report.hitAtK,
          mrr: report.mrr,
          misses: report.perQuery.filter((q) => !q.hit).map((q) => q.id),
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    if (asJson) {
      okJson({
        total: report.total,
        k: report.k,
        expand: report.expand,
        hit_at_k: report.hitAtK,
        mrr: report.mrr,
        per_query: report.perQuery,
      });
    } else {
      ok(
        `benchmark: ${report.total} queries, hit@${report.k} ${report.hitAtK.toFixed(3)}, ` +
          `MRR ${report.mrr.toFixed(3)}${report.expand ? " (expanded)" : ""}`,
      );
      for (const q of report.perQuery) {
        ok(`  ${q.hit ? "hit " : "MISS"} ${q.id} rank=${q.rank ?? "-"}`);
      }
    }
    return 0;
  } catch (exc) {
    if (exc instanceof SearchError && exc.code === "INVALID_INPUT") {
      process.stderr.write(`brain benchmark run: ${exc.message}\n`);
      return 2;
    }
    const message = `benchmark failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
