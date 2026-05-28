import { defaultConfigPath } from "../../../core/config.ts";
import { buildRetentionReview } from "../../../core/brain/retention.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain retention [--vault PATH] [--now ISO] [--json]`
 *
 * Recommendation-only lifecycle review over retired preferences and processed signals.
 */
export async function cmdBrainRetention(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    now: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const now = parseNow(flags["now"]);
  const report = buildRetentionReview(vault, now ? { now } : {});

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Retention review generated ${report.generated_at}\n`);
  process.stdout.write(
    `  keep=${report.summary.keep} improve=${report.summary.improve} park=${report.summary.park} prune=${report.summary.prune}\n`,
  );
  for (const recommendation of report.recommendations) {
    process.stdout.write(
      `  ${recommendation.action} ${recommendation.id} (${recommendation.artifact_type}) - ${recommendation.reason}\n`,
    );
  }
  return 0;
}

function parseNow(
  raw: string | boolean | string[] | undefined,
): Date | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CliError("brain retention: --now must be an ISO-8601 timestamp");
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new CliError(`brain retention: invalid --now ${JSON.stringify(raw)}`);
  }
  return date;
}
