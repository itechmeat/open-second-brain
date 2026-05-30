import { defaultConfigPath } from "../../../core/config.ts";
import {
  applySchemaAdminMutations,
  buildSchemaGraph,
  buildSchemaLint,
  buildSchemaStats,
  buildSchemaSyncResult,
  explainSchemaToken,
  parseSchemaMutationPayloads,
  reviewSchemaOrphans,
} from "../../../core/brain/schema-admin.ts";
import {
  buildSchemaReport,
  type BrainSchemaReport,
  type SchemaReportFinding,
} from "../../../core/brain/schema-report.ts";
import { SCHEMA_VOCAB_CATEGORIES } from "../../../core/brain/schema-vocab.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSchema(argv: string[]): Promise<number> {
  const subcommands = new Set([
    "report",
    "stats",
    "lint",
    "graph",
    "explain",
    "orphans",
    "apply",
    "sync",
  ]);
  const firstArg = argv[0];
  let subcommand = "report";
  let args = argv;
  if (firstArg !== undefined && !firstArg.startsWith("-")) {
    if (!subcommands.has(firstArg)) return fail(`schema failed: unknown subcommand ${firstArg}`);
    subcommand = firstArg;
    args = argv.slice(1);
  }
  const { flags, positional } = parse(args, {
    vault: { type: "string" },
    json: { type: "boolean" },
    mutation: { type: "string-array" },
    actor: { type: "string", default: "cli" },
    reason: { type: "string" },
    "dry-run": { type: "boolean" },
    "batch-size": { type: "string", default: "100" },
  });
  const config = defaultConfigPath();

  let vault: string;
  try {
    vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  } catch (exc) {
    return fail(`schema failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    switch (subcommand) {
      case "report": {
        const report = buildSchemaReport(vault);
        if (flags["json"]) return writeJson(report);
        process.stdout.write(renderSchemaReportText(report));
        return 0;
      }
      case "stats":
        return writeResult(buildSchemaStats(vault), Boolean(flags["json"]), renderGenericText);
      case "lint":
        return writeResult(buildSchemaLint(vault), Boolean(flags["json"]), renderGenericText);
      case "graph":
        return writeResult(buildSchemaGraph(vault), Boolean(flags["json"]), renderGenericText);
      case "explain": {
        const token = positional[0];
        if (!token) throw new Error("schema explain requires a token");
        return writeResult(
          explainSchemaToken(vault, token),
          Boolean(flags["json"]),
          renderGenericText,
        );
      }
      case "orphans":
        return writeResult(reviewSchemaOrphans(vault), Boolean(flags["json"]), renderGenericText);
      case "apply": {
        const mutationPayloads = (flags["mutation"] as string[] | undefined) ?? [];
        if (mutationPayloads.length === 0) throw new Error("schema apply requires --mutation JSON");
        const result = await applySchemaAdminMutations(
          vault,
          parseSchemaMutationPayloads(mutationPayloads),
          {
            actor: flags["actor"] as string,
            reason: flags["reason"] as string | undefined,
          },
        );
        return writeResult(result, Boolean(flags["json"]), renderGenericText);
      }
      case "sync": {
        const batchSize = Number.parseInt(flags["batch-size"] as string, 10);
        if (!Number.isInteger(batchSize) || batchSize <= 0) {
          throw new Error("--batch-size must be a positive integer");
        }
        return writeResult(
          buildSchemaSyncResult({
            dryRun: Boolean(flags["dry-run"]),
            batchSize,
          }),
          Boolean(flags["json"]),
          renderGenericText,
        );
      }
    }
  } catch (exc) {
    return fail(`schema failed: ${(exc as Error).message ?? exc}`);
  }

  return fail(`schema failed: unknown subcommand ${subcommand}`);
}

function writeResult<T>(value: T, json: boolean, renderText: (value: T) => string): number {
  if (json) return writeJson(value);
  process.stdout.write(renderText(value));
  return 0;
}

function writeJson(value: unknown): number {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  return 0;
}

function renderGenericText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function renderSchemaReportText(report: BrainSchemaReport): string {
  const lines = ["brain schema", "", "vocabulary:"];
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    lines.push(`  ${category}: ${report.vocabulary[category].join(", ") || "(none)"}`);
  }
  lines.push("", "usage:");
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const usage = report.usage[category].map((item) => `${item.token} x${item.count}`).join(", ");
    lines.push(`  ${category} usage: ${usage || "(none)"}`);
  }
  lines.push("", "findings:");
  if (report.findings.length === 0) {
    lines.push("  none");
  } else {
    for (const finding of report.findings) lines.push(`  ${renderFinding(finding)}`);
  }
  return lines.join("\n") + "\n";
}

function renderFinding(finding: SchemaReportFinding): string {
  if (finding.kind === "unknown-token") {
    return `[unknown-token] ${finding.category} ${finding.token} (${finding.path})`;
  }
  return `[unused-declaration] ${finding.category} ${finding.token}`;
}
