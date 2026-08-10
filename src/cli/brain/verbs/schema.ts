import { defaultConfigPath } from "../../../core/config.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
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
  assessSchemaPackIntegrity,
  SCHEMA_PACK_INTEGRITY,
  type SchemaPackIntegrity,
} from "../../../core/brain/schema-integrity.ts";
import { previewSchemaMutations } from "../../../core/brain/schema-mutate.ts";
import { formatStampMismatch } from "../../../core/integrity/stamp.ts";
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
        // The report used to describe the ontology without saying whether
        // it is still the ontology that was applied. An intact pack, a
        // hand-edited one, and one nothing ever sealed rendered the same.
        const integrity = assessSchemaPackIntegrity(vault);
        if (flags["json"]) return writeJson({ ...report, integrity });
        process.stdout.write(renderSchemaReportText(report, integrity));
        return 0;
      }
      case "stats":
        return writeResult(buildSchemaStats(vault), Boolean(flags["json"]), renderGenericText);
      case "lint":
        return writeResult(
          buildSchemaLint(vault, {
            dbPath: resolveSearchConfig({ vault, configPath: config ?? undefined }).dbPath,
          }),
          Boolean(flags["json"]),
          renderGenericText,
        );
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
        const mutations = parseSchemaMutationPayloads(mutationPayloads);
        // `--dry-run` is parsed for every schema subcommand. Until the
        // preview existed, `apply` accepted the flag and wrote anyway - an
        // operator asking to look first got a mutated vault schema.
        if (flags["dry-run"]) {
          return writeResult(
            previewSchemaMutations(vault, mutations),
            Boolean(flags["json"]),
            renderGenericText,
          );
        }
        const result = await applySchemaAdminMutations(vault, mutations, {
          actor: flags["actor"] as string,
          reason: flags["reason"] as string | undefined,
        });
        return writeResult(result, Boolean(flags["json"]), renderGenericText);
      }
      case "sync": {
        const batchSize = Number.parseInt(flags["batch-size"] as string, 10);
        if (!Number.isInteger(batchSize) || batchSize <= 0) {
          throw new Error("--batch-size must be a positive integer");
        }
        // Refuses and exits non-zero: see `SchemaSyncUnavailableError`. The
        // flags above are still validated so an operator learns about a bad
        // `--batch-size` from the same message they always did.
        return writeResult(buildSchemaSyncResult(vault), Boolean(flags["json"]), renderGenericText);
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

/**
 * One line naming the integrity verdict, plus the evidence behind it.
 *
 * `unverified` carries its reason on the same line: the status alone would
 * tell an operator that something could not be checked without telling
 * them which of the three ways it happened, which is the silence this unit
 * removes rather than relocates. `modified` is followed by the shared
 * mismatch rendering, so it reads the same here as on every other
 * integrity surface.
 */
function renderIntegrityLines(integrity: SchemaPackIntegrity): ReadonlyArray<string> {
  const reason =
    integrity.unverified_reason === undefined ? "" : ` (${integrity.unverified_reason})`;
  const lines = [`integrity: ${integrity.status}${reason}`];
  if (integrity.status === SCHEMA_PACK_INTEGRITY.modified) {
    for (const mismatch of integrity.mismatches) lines.push(`  ${formatStampMismatch(mismatch)}`);
  }
  return lines;
}

function renderSchemaReportText(report: BrainSchemaReport, integrity: SchemaPackIntegrity): string {
  const lines = ["brain schema", "", ...renderIntegrityLines(integrity), "", "vocabulary:"];
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
  if (finding.kind === "link-constraint-violation") {
    return (
      `[link-constraint-violation] ${finding.relation} ` +
      `${finding.source_type ?? "?"}->${finding.target_type ?? "?"} ` +
      `(${finding.source} -> ${finding.target})`
    );
  }
  return `[unused-declaration] ${finding.category} ${finding.token}`;
}
