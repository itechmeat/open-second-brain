import { defaultConfigPath } from "../../../core/config.ts";
import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import { buildWeeklySynthesis } from "../../../core/brain/temporal/weekly-brief.ts";
import { loadTemporalConfigSafe } from "../../../core/brain/policy.ts";
import { parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain weekly [--vault PATH] [--week-end YYYY-MM-DD] [--json]`
 *
 * 7-day deterministic synthesis over the TimelineIndex. Defaults
 * `--week-end` to today UTC.
 */
export async function cmdBrainWeekly(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "week-end": { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const weekEnd =
    typeof flags["week-end"] === "string" && flags["week-end"].length > 0
      ? flags["week-end"]
      : new Date().toISOString().slice(0, 10);
  const cfg = loadTemporalConfigSafe(vault);
  const index = buildTimelineIndex(vault, {});
  const synth = buildWeeklySynthesis(index, vault, weekEnd, cfg);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(synth, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Weekly synthesis ${synth.windowStart} .. ${synth.windowEnd}\n`);
  process.stdout.write(`  events by kind:\n`);
  for (const [kind, count] of Object.entries(synth.eventsByKind)) {
    process.stdout.write(`    ${kind}: ${count}\n`);
  }
  process.stdout.write(`  status transitions: ${synth.statusTransitions.length}\n`);
  process.stdout.write(`  retired: ${synth.retired.length}\n`);
  for (const r of synth.retired) {
    process.stdout.write(`    ${r.at}  ${r.prefId}\n`);
  }
  process.stdout.write(`  contradictions: ${synth.contradictions.length}\n`);
  for (const c of synth.contradictions) {
    process.stdout.write(
      `    ${c.at}  ${c.kind}${c.prefId ? `  ${c.prefId}` : ""}${c.reason ? `  (${c.reason})` : ""}\n`,
    );
  }
  return 0;
}
