import { readFileSync } from "node:fs";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { writeSignal } from "../../../core/brain/signal.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { writePreference } from "../../../core/brain/preference.ts";
import { isoDate, isoSecond } from "../../../core/brain/time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS, BRAIN_SIGNAL_SIGN } from "../../../core/brain/types.ts";
import { renderPrefLink } from "../../../core/brain/wikilink.ts";
import { parse, fail, ok, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainFeedback(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    topic: { type: "string" },
    signal: { type: "string" },
    principle: { type: "string" },
    scope: { type: "string" },
    source: { type: "string-array" },
    agent: { type: "string" },
    raw: { type: "string" },
    "raw-file": { type: "string" },
    "force-confirmed": { type: "boolean" },
    date: { type: "string" },
    slug: { type: "string" },
    json: { type: "boolean" },
  });

  for (const field of ["topic", "signal", "principle"] as const) {
    if (typeof flags[field] !== "string" || (flags[field] as string).trim() === "") {
      return fail(`brain feedback missing required flag: --${field}`);
    }
  }

  const signalSign = String(flags["signal"]);
  if (signalSign !== BRAIN_SIGNAL_SIGN.positive && signalSign !== BRAIN_SIGNAL_SIGN.negative) {
    return fail(`--signal must be 'positive' or 'negative'; got ${JSON.stringify(signalSign)}`);
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  let raw: string | undefined;
  const rawFile = flags["raw-file"] as string | undefined;
  if (rawFile) {
    try {
      raw = readFileSync(rawFile, "utf8");
    } catch (exc) {
      return fail(`cannot read --raw-file: ${(exc as Error).message ?? exc}`);
    }
  } else if (flags["raw"]) {
    raw = String(flags["raw"]);
  }

  const now = new Date();
  const date = (flags["date"] as string | undefined) ?? isoDate(now);
  const slug = (flags["slug"] as string | undefined) ?? String(flags["topic"]);

  let sigResult;
  try {
    sigResult = writeSignal(vault, {
      topic: String(flags["topic"]),
      signal: signalSign as "positive" | "negative",
      agent,
      principle: String(flags["principle"]),
      created_at: now.toISOString(),
      date,
      slug,
      ...(flags["scope"] ? { scope: String(flags["scope"]) } : {}),
      ...(flags["source"] ? { source: flags["source"] as string[] } : {}),
      ...(raw !== undefined ? { raw } : {}),
    });
  } catch (exc) {
    return fail(`failed to write signal: ${(exc as Error).message ?? exc}`);
  }

  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: { signal: `[[${sigResult.id}]]`, topic: String(flags["topic"]), sign: signalSign, agent },
    });
  } catch (err) {
    process.stderr.write(`warning: append feedback log failed: ${(err as Error).message}\n`);
  }

  let prefResult: { path: string; id: string } | null = null;
  if (flags["force-confirmed"]) {
    try {
      prefResult = writePreference(vault, {
        slug,
        topic: String(flags["topic"]),
        principle: String(flags["principle"]),
        created_at: now.toISOString(),
        unconfirmed_until: now.toISOString(),
        confirmed_at: now.toISOString(),
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [`[[${sigResult.id}]]`],
        ...(flags["scope"] ? { scope: String(flags["scope"]) } : {}),
      }, { overwrite: false });
    } catch (exc) {
      return fail(`failed to force-confirm preference: ${(exc as Error).message ?? exc}`);
    }
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date(now.getTime() + 1000)),
        eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
        body: { preference: renderPrefLink({ id: prefResult.id, principle: String(flags["principle"]) }), agent },
      });
    } catch (err) {
      process.stderr.write(`warning: append force-confirmed log failed: ${(err as Error).message}\n`);
    }
  }

  if (flags["json"]) {
    okJson({
      signal_path: sigResult.path,
      signal_id: sigResult.id,
      ...(prefResult ? { preference_path: prefResult.path, preference_id: prefResult.id } : {}),
    });
    return 0;
  }
  ok(`signal: ${sigResult.path}`);
  ok(`id: ${sigResult.id}`);
  if (prefResult) {
    ok(`preference: ${prefResult.path}`);
    ok(`status: confirmed`);
  }
  return 0;
}
