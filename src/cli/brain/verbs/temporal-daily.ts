import { defaultConfigPath } from "../../../core/config.ts";
import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import { buildDailyBrief } from "../../../core/brain/temporal/daily-brief.ts";
import { loadTemporalConfigSafe } from "../../../core/brain/policy.ts";
import { CliError, parse, resolveBrainVault, localTimeFields } from "../helpers.ts";

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `o2b brain daily [--vault PATH] [--date YYYY-MM-DD] [--json]`
 *
 * Per-day deterministic brief over the TimelineIndex. Defaults
 * `--date` to today UTC.
 */
export async function cmdBrainDaily(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    date: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const date = resolveDateArg(flags["date"]);
  const cfg = loadTemporalConfigSafe(vault);
  const index = buildTimelineIndex(vault, {});
  let brief;
  try {
    brief = buildDailyBrief(index, vault, date, {
      offsetHours: cfg.daily_window_offset_hours,
    });
  } catch (exc) {
    if (exc instanceof Error) throw new CliError(`brain daily: ${exc.message}`);
    throw exc;
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ ...brief, ...localTimeFields(config) }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Daily brief ${brief.date}\n`);
  process.stdout.write(`  window: ${brief.window.since} .. ${brief.window.until}\n`);
  process.stdout.write(`  events by kind:\n`);
  for (const [kind, count] of Object.entries(brief.eventsByKind)) {
    process.stdout.write(`    ${kind}: ${count}\n`);
  }
  process.stdout.write(`  vault delta:\n`);
  process.stdout.write(`    new promotions: ${brief.vaultDelta.newPromotions}\n`);
  process.stdout.write(`    new retired: ${brief.vaultDelta.newRetired}\n`);
  process.stdout.write(`    new feedback: ${brief.vaultDelta.newFeedback}\n`);
  process.stdout.write(`    evidence applied: ${brief.vaultDelta.evidenceApplied}\n`);
  process.stdout.write(`    evidence violated: ${brief.vaultDelta.evidenceViolated}\n`);
  process.stdout.write(`  status transitions: ${brief.statusTransitions.length}\n`);
  process.stdout.write(`  source pointers: ${brief.sourcePointers.length}\n`);
  return 0;
}

/**
 * Validate / default the `--date` flag. Accepts a bare ISO date
 * (`YYYY-MM-DD`); rejects whitespace-only / malformed input as a
 * CLI error so the underlying helper does not see garbage.
 */
function resolveDateArg(raw: string | boolean | string[] | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return new Date().toISOString().slice(0, 10);
  }
  const v = raw.trim();
  if (!ISO_DATE_ONLY_RE.test(v)) {
    throw new CliError(
      `brain daily: --date must be a YYYY-MM-DD ISO date; got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}
