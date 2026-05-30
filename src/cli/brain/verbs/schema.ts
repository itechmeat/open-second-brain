import { defaultConfigPath } from "../../../core/config.ts";
import {
  buildSchemaReport,
  type BrainSchemaReport,
  type SchemaReportFinding,
} from "../../../core/brain/schema-report.ts";
import { SCHEMA_VOCAB_CATEGORIES } from "../../../core/brain/schema-vocab.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSchema(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();

  let report: BrainSchemaReport;
  try {
    const vault = resolveBrainVault(
      flags["vault"] as string | undefined,
      config,
    );
    report = buildSchemaReport(vault);
  } catch (exc) {
    return fail(`schema failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderSchemaReportText(report));
  return 0;
}

function renderSchemaReportText(report: BrainSchemaReport): string {
  const lines = ["brain schema", "", "vocabulary:"];
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    lines.push(
      `  ${category}: ${report.vocabulary[category].join(", ") || "(none)"}`,
    );
  }
  lines.push("", "usage:");
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const usage = report.usage[category]
      .map((item) => `${item.token} x${item.count}`)
      .join(", ");
    lines.push(`  ${category} usage: ${usage || "(none)"}`);
  }
  lines.push("", "findings:");
  if (report.findings.length === 0) {
    lines.push("  none");
  } else {
    for (const finding of report.findings)
      lines.push(`  ${renderFinding(finding)}`);
  }
  return lines.join("\n") + "\n";
}

function renderFinding(finding: SchemaReportFinding): string {
  if (finding.kind === "unknown-token") {
    return `[unknown-token] ${finding.category} ${finding.token} (${finding.path})`;
  }
  return `[unused-declaration] ${finding.category} ${finding.token}`;
}
