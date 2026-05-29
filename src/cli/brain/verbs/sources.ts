import { defaultConfigPath } from "../../../core/config.ts";
import { aggregateSources } from "../../../core/brain/portability/sources.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain sources [--json]` - read-only dashboard of the brain's
 * signals grouped by (agent, source_type) with active/processed and
 * distinct-topic counts.
 */
export async function cmdBrainSources(argv: string[]): Promise<number> {
  const { flags } = parse(argv, { vault: { type: "string" }, json: { type: "boolean" } });
  const config = defaultConfigPath();

  let report;
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    report = aggregateSources(vault);
  } catch (exc) {
    return fail(`sources failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  if (report.sources.length === 0) {
    process.stdout.write("no signals\n");
    return 0;
  }
  const lines = [
    `sources (${report.total_active} active, ${report.total_processed} processed)`,
  ];
  for (const s of report.sources) {
    lines.push(
      `  ${s.agent} [${s.source_type}]  active=${s.active} processed=${s.processed} topics=${s.distinct_topics}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
