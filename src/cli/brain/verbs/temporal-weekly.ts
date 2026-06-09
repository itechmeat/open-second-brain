import { captureReportDelta, renderReportDelta } from "../../../core/brain/report-snapshot.ts";
import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import { buildWeeklySynthesis } from "../../../core/brain/temporal/weekly-brief.ts";
import { loadTemporalConfigSafe } from "../../../core/brain/policy.ts";
import { CliError, brainVerbContext, localTimeFields, parse } from "../helpers.ts";

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const { config, vault } = brainVerbContext(flags);
  const weekEnd = resolveWeekEndArg(flags["week-end"]);
  const cfg = loadTemporalConfigSafe(vault);
  const index = buildTimelineIndex(vault, {});
  let synth;
  try {
    synth = buildWeeklySynthesis(index, vault, weekEnd, cfg);
  } catch (exc) {
    if (exc instanceof Error) throw new CliError(`brain weekly: ${exc.message}`);
    throw exc;
  }

  const delta = captureReportDelta(
    vault,
    "weekly",
    weekEnd,
    synth,
    config ? { configPath: config } : {},
  );
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { ...synth, ...(delta !== null ? { delta } : {}), ...localTimeFields(config) },
        null,
        2,
      ) + "\n",
    );
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
  if (delta !== null) process.stdout.write(renderReportDelta(delta) + "\n");
  return 0;
}

/**
 * Validate / default the `--week-end` flag. Accepts a bare ISO date
 * (`YYYY-MM-DD`); rejects whitespace-only / malformed input as a CLI
 * error so the underlying helper does not see garbage.
 */
function resolveWeekEndArg(raw: string | boolean | string[] | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return new Date().toISOString().slice(0, 10);
  }
  const v = raw.trim();
  if (!ISO_DATE_ONLY_RE.test(v)) {
    throw new CliError(
      `brain weekly: --week-end must be a YYYY-MM-DD ISO date; got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}
