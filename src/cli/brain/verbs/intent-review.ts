import { buildIntentReview } from "../../../core/brain/intent-review.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

/**
 * `o2b brain intent-review [--vault PATH] [--now ISO] [--json]`
 *
 * Read-only pre-dream intent review over active signal clusters.
 */
export async function cmdBrainIntentReview(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    now: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const now = parseNow(flags["now"]);
  const report = buildIntentReview(vault, now ? { now } : {});

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`Intent review generated ${report.generated_at}\n`);
  for (const review of report.reviews) {
    process.stdout.write(
      `  ${review.topic}: ${review.decision} (${review.signal_count} signals, ${review.risk_band} risk)\n`,
    );
  }
  if (report.reviews.length === 0) {
    process.stdout.write("  no active signal clusters\n");
    // no-dead-ends, task 5: clusters are built from the signals in
    // `Brain/inbox/`, so an empty review means there is nothing to
    // review yet - the exit is recording one. The flag is read here
    // rather than assumed false, so the rail, not this branch, stays
    // the thing that decides what stdout can carry.
    const stream: AdvisoryStream = {
      command: "brain",
      argv,
      jsonRequested: Boolean(flags["json"]),
    };
    emitNextStep("signal-clusters-absent", stream);
  }
  return 0;
}

function parseNow(raw: string | boolean | string[] | undefined): Date | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CliError("brain intent-review: --now must be an ISO-8601 timestamp");
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new CliError(`brain intent-review: invalid --now ${JSON.stringify(raw)}`);
  }
  return date;
}
