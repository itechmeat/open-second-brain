import {
  aggregateQueryDemand,
  serializeQueryDemandReport,
} from "../../../core/brain/query-demand.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

/**
 * `o2b brain knowledge-gaps` — surface recurring queries the vault
 * answers poorly from the persisted cross-query demand log
 * (t_97091fff). Read-only aggregation; no LLM.
 */
export async function cmdBrainKnowledgeGaps(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    since: { type: "string" },
    until: { type: "string" },
    "min-occurrences": { type: "string" },
    "max-satisfaction": { type: "string" },
    limit: { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  const since = trimOrUndefined(flags["since"]);
  const until = trimOrUndefined(flags["until"]);
  const minOccurrences = parsePositiveInteger(
    trimOrUndefined(flags["min-occurrences"]),
    "--min-occurrences",
  );
  const limit = parsePositiveInteger(trimOrUndefined(flags["limit"]), "--limit");
  const maxSatisfaction = parseUnitInterval(
    trimOrUndefined(flags["max-satisfaction"]),
    "--max-satisfaction",
  );

  const report = aggregateQueryDemand(vault, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(minOccurrences !== undefined ? { minOccurrences } : {}),
    ...(maxSatisfaction !== undefined ? { maxSatisfaction } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(serializeQueryDemandReport(report), null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `${report.totalRecords} demand record(s), ${report.distinctQueries} distinct quer(y/ies), ` +
      `${report.gaps.length} gap(s):\n`,
  );
  for (const gap of report.gaps) {
    const coverage = gap.meanCoverage === null ? "n/a" : gap.meanCoverage.toFixed(2);
    process.stdout.write(
      `  [${gap.demandScore.toFixed(2)}] ${gap.verdict}  x${gap.occurrences}  ` +
        `coverage=${coverage}  empty=${gap.emptyCount}/${gap.occurrences}  ` +
        `${gap.terms.join(" ")}\n`,
    );
  }
  return 0;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`brain knowledge-gaps: ${flag} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`brain knowledge-gaps: ${flag} must be a positive integer`);
  return parsed;
}

function parseUnitInterval(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError(`brain knowledge-gaps: ${flag} must be a number in [0, 1]`);
  }
  return parsed;
}
