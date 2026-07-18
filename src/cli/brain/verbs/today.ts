/**
 * `o2b brain today` - today operator surface (today-operator-surface,
 * t_5f65c992).
 *
 * Thin CLI wrapper over `buildTodayDashboard`: it resolves the wall clock
 * at the CLI boundary (`now = new Date()`) so the core builder stays
 * clock-injected and deterministic, then prints the rendered Markdown or,
 * with `--json`, the structured envelope. Read-only; never writes.
 *
 * A malformed `--lookback-days` / `--limit` value is a usage error: it is
 * rejected fail-closed with exit code 2 before the dashboard is built,
 * matching the sibling verbs' exit-2 usage-error contract.
 */

import { buildTodayDashboard } from "../../../core/brain/today-dashboard.ts";
import { parseOptionalNumberFlag } from "../../coerce.ts";
import { brainVerbContext, localTimeFields, parse, usageError } from "../helpers.ts";

export async function cmdBrainToday(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "lookback-days": { type: "string" },
    limit: { type: "string" },
  });
  const { config, vault } = brainVerbContext(flags);

  // Non-negative-integer validation: the core builder accepts >= 0 for
  // both window knobs, so mirror that here. A malformed value fails closed
  // as a usage error (exit 2) before any work happens.
  const nonNegativeInt = (name: string): { value: number | null; error: string | null } => {
    const parsed = parseOptionalNumberFlag(flags, name);
    if (parsed.error) return parsed;
    if (parsed.value !== null && (!Number.isInteger(parsed.value) || parsed.value < 0)) {
      return { value: null, error: `--${name} must be a non-negative integer` };
    }
    return parsed;
  };

  const lookbackFlag = nonNegativeInt("lookback-days");
  if (lookbackFlag.error) return usageError(lookbackFlag.error);
  const limitFlag = nonNegativeInt("limit");
  if (limitFlag.error) return usageError(limitFlag.error);

  const dashboard = buildTodayDashboard(vault, {
    now: new Date(),
    ...(lookbackFlag.value !== null ? { activityLookbackDays: lookbackFlag.value } : {}),
    ...(limitFlag.value !== null ? { activityLimit: limitFlag.value } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          obligations: dashboard.obligations,
          open_loops: dashboard.openLoops,
          recent_activity: dashboard.recentActivity,
          totals: dashboard.totals,
          errors: dashboard.errors,
          text: dashboard.text,
          ...localTimeFields(config),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(dashboard.text + "\n");
  }
  return 0;
}
