import { defaultConfigPath } from "../../../core/config.ts";
import {
  buildMonthlyReview,
  normalizeMonthlyReviewMonth,
} from "../../../core/brain/monthly-review.ts";
import { CliError, parse, resolveBrainVault, localTimeFields } from "../helpers.ts";

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * `o2b brain monthly [--vault PATH] [--month YYYY-MM] [--json]`
 *
 * Read-only monthly synthesis over the Brain timeline.
 */
export async function cmdBrainMonthly(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    month: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const month = parseMonth(flags["month"]);
  const report = buildMonthlyReview(vault, month ? { month } : {});

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ ...report, ...localTimeFields(config) }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Monthly review ${report.month}\n`);
  process.stdout.write(`  window: ${report.window.since} .. ${report.window.until}\n`);
  process.stdout.write(`  events: ${report.summary.events}\n`);
  process.stdout.write(`  status transitions: ${report.summary.status_transitions}\n`);
  process.stdout.write(`  retired: ${report.summary.retired}\n`);
  process.stdout.write(`  contradictions: ${report.summary.contradictions}\n`);
  if (report.summary.neglected_areas.length > 0) {
    process.stdout.write(`  neglected areas: ${report.summary.neglected_areas.join(", ")}\n`);
  }
  return 0;
}

function parseMonth(raw: string | boolean | string[] | undefined): string | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (typeof raw !== "string") {
    throw new CliError("brain monthly: --month must be YYYY-MM");
  }
  try {
    return normalizeMonthlyReviewMonth(raw);
  } catch {
    throw new CliError("brain monthly: --month must be YYYY-MM");
  }
}
