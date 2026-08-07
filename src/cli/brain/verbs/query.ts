/**
 * `o2b brain query` - read-only lookup by preference, topic, or log
 * timestamp.
 *
 * Topic mode is the one surface in this system that ENFORCES per-memory
 * expiry (`filterExpired`, reached only through `queryByTopic`), so it is
 * also the only one where a point-in-time question is meaningful. Both
 * knobs the filter has always taken are exposed here:
 *
 *   --at <ISO|YYYY-MM-DD>  the instant `expiration_date` is compared
 *                          against, so a memory that lapsed after it is
 *                          recalled as it stood then;
 *   --show-expired         keep lapsed memories regardless of the clock.
 *
 * Neither reaches the preference or log-since modes, which run no expiry
 * filter, so supplying one there is refused rather than accepted and
 * ignored.
 */

import {
  queryByLogSince,
  queryByPreference,
  queryByTopic,
  BrainNotFoundError,
  type QueryByTopicOptions,
} from "../../../core/brain/query.ts";
import { parseIsoUtc } from "../../../core/brain/health/iso-time.ts";
import {
  brainVerbContext,
  fail,
  parse,
  parseOptionalIsoDate,
  renderQueryLogText,
  renderQueryPreferenceText,
  renderQueryTopicText,
  usageError,
} from "../helpers.ts";

/** The two point-in-time flags, which only the expiry filter reads. */
const AS_OF_FLAG = "--at";
const SHOW_EXPIRED_FLAG = "--show-expired";

/** Accepted `--at` forms, named in every refusal so the exit is actionable. */
const AS_OF_FORMS = "an ISO-8601 instant or YYYY-MM-DD date";

export async function cmdBrainQuery(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    preference: { type: "string" },
    topic: { type: "string" },
    since: { type: "string" },
    at: { type: "string" },
    "show-expired": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const modes = ["preference", "topic", "since"].filter(
    (k) => typeof flags[k] === "string" && (flags[k] as string).trim() !== "",
  );
  if (modes.length === 0)
    return fail("brain query requires exactly one of --preference, --topic, --since");
  if (modes.length > 1)
    return fail(
      `brain query: pick only one of --preference / --topic / --since (got ${modes.join(", ")})`,
    );

  // `--at` moves the clock the expiration filter compares against and
  // `--show-expired` turns that filter off; `queryByTopic` is the only
  // reader of either. Naming that here beats accepting a flag on
  // `--preference` / `--since` that would quietly change nothing.
  const atRaw = typeof flags["at"] === "string" ? flags["at"].trim() : null;
  const showExpired = flags["show-expired"] === true;
  if (flags["topic"] === undefined) {
    const misplaced = [
      ...(atRaw !== null ? [AS_OF_FLAG] : []),
      ...(showExpired ? [SHOW_EXPIRED_FLAG] : []),
    ];
    if (misplaced.length > 0) {
      return usageError(
        `brain query: ${misplaced.join(" / ")} only applies to --topic (the expiration filter runs there)`,
      );
    }
  }
  let asOf: Date | null = null;
  if (atRaw !== null) {
    // An unparseable instant is refused, never coerced to the wall
    // clock: answering "as of now" for a caller who asked "as of then"
    // answers a different question without saying so.
    const atMs = parseIsoUtc(atRaw);
    if (!Number.isFinite(atMs)) {
      return usageError(`brain query ${AS_OF_FLAG} must be ${AS_OF_FORMS}; got ${atRaw}`);
    }
    asOf = new Date(atMs);
  }

  try {
    if (flags["preference"]) {
      const out = queryByPreference(vault, String(flags["preference"]));
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        renderQueryPreferenceText(out);
      }
      return 0;
    }
    if (flags["topic"]) {
      const topicOptions: QueryByTopicOptions = {
        showExpired,
        ...(asOf !== null ? { now: asOf } : {}),
      };
      const out = queryByTopic(vault, String(flags["topic"]), topicOptions);
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        renderQueryTopicText(out, String(flags["topic"]));
      }
      return 0;
    }
    if (flags["since"]) {
      const { value: sinceDate, error: sinceErr } = parseOptionalIsoDate(flags, "since");
      if (sinceErr) return fail(sinceErr);
      const entries = queryByLogSince(vault, sinceDate!);
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      } else {
        renderQueryLogText(entries);
      }
      return 0;
    }
  } catch (exc) {
    if (exc instanceof BrainNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`query failed: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
