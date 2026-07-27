/**
 * `o2b search rerank-fit` — per-store diagnostic: does the configured
 * cross-encoder actually re-order this vault's results, or is it paying
 * for a permutation the base ranker already had right?
 */

import { rerankFitCheck } from "../../../core/search/rerank-fit-check.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  isIntegerWithin,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

export async function cmdSearchRerankFit(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    "max-queries": { type: "string" },
    "top-k": { type: "string" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const maxQueriesFlag = flagString(flags, "max-queries");
  const topKFlag = flagString(flags, "top-k");
  const maxQueries = maxQueriesFlag !== undefined ? Number(maxQueriesFlag) : undefined;
  const topK = topKFlag !== undefined ? Number(topKFlag) : undefined;
  if (maxQueries !== undefined && !isIntegerWithin(maxQueries, { min: 1 })) {
    throw new CliError(`--max-queries must be a positive integer, got '${maxQueriesFlag}'`);
  }
  if (topK !== undefined && !isIntegerWithin(topK, { min: 2 })) {
    throw new CliError(`--top-k must be an integer >= 2, got '${topKFlag}'`);
  }
  const report = await rerankFitCheck(cfg, {
    ...(maxQueries !== undefined ? { maxQueries } : {}),
    ...(topK !== undefined ? { topK } : {}),
  });
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        applicable: report.applicable,
        verdict: report.verdict,
        correlation: report.correlation,
        sampled_queries: report.sampledQueries,
        recommendation: report.recommendation,
        reason: report.reason,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`rerank fit: ${report.verdict}\n`);
  process.stdout.write(`  ${report.reason}\n`);
  if (report.correlation !== null) {
    process.stdout.write(
      `  correlation: ${report.correlation.toFixed(3)} over ${report.sampledQueries} query(ies)\n`,
    );
  }
  if (report.verdict !== "fits" && report.verdict !== "inapplicable") {
    process.stdout.write(`  recommendation: ${report.recommendation}\n`);
  }
  return 0;
}
