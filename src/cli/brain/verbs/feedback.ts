import { readFileSync } from "node:fs";
import { mirrorSignal, resolveSharedNamespace } from "../../../core/brain/shared-namespace.ts";
import { resolveEffectiveScope, writeSignal } from "../../../core/brain/signal.ts";
import { adviseIncomingFeedback } from "../../../core/brain/write-advisory.ts";
import { loadFeedbackDefaultScopeSafe } from "../../../core/brain/policy.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { writePreference } from "../../../core/brain/preference.ts";
import { isoDate, isoSecond } from "../../../core/brain/time.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../../../core/brain/types.ts";
import { renderPrefLink } from "../../../core/brain/wikilink.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

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

  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);

  // Vault-configured fallback scope (`feedback.default_scope`). Applied
  // only when the call passes no explicit --scope. Compute one effective
  // scope so the signal, its mirror, and any force-confirmed preference
  // all land on the same scope.
  const defaultScope = loadFeedbackDefaultScopeSafe(vault);
  const effectiveScope = resolveEffectiveScope(flags["scope"] as string | undefined, defaultScope);
  const writeOpts = defaultScope !== undefined ? { defaultScope } : {};

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

  const signalInput = {
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
  };
  let sigResult;
  try {
    sigResult = writeSignal(vault, signalInput, writeOpts);
  } catch (exc) {
    return fail(`failed to write signal: ${(exc as Error).message ?? exc}`);
  }
  // t_936a1a61: fail-soft mirror into the shared namespace AFTER the
  // primary write; surfaced only when the key is configured.
  const sharedNamespace = resolveSharedNamespace(config);
  const mirror =
    sharedNamespace === null
      ? undefined
      : mirrorSignal(sharedNamespace, vault, signalInput, writeOpts);

  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: {
        signal: `[[${sigResult.id}]]`,
        topic: String(flags["topic"]),
        sign: signalSign,
        agent,
      },
    });
  } catch (err) {
    process.stderr.write(`warning: append feedback log failed: ${(err as Error).message}\n`);
  }

  // Write-time conflict advisory (A4): non-blocking, computed BEFORE any
  // force-confirmed write so it never matches the pref this call creates.
  const advisory = adviseIncomingFeedback(vault, {
    principle: String(flags["principle"]),
    ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
    agent,
    now,
  });

  let prefResult: { path: string; id: string } | null = null;
  if (flags["force-confirmed"]) {
    try {
      prefResult = writePreference(
        vault,
        {
          slug,
          topic: String(flags["topic"]),
          principle: String(flags["principle"]),
          created_at: now.toISOString(),
          unconfirmed_until: now.toISOString(),
          confirmed_at: now.toISOString(),
          status: BRAIN_PREFERENCE_STATUS.confirmed,
          evidenced_by: [`[[${sigResult.id}]]`],
          ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
        },
        { overwrite: false },
      );
    } catch (exc) {
      return fail(`failed to force-confirm preference: ${(exc as Error).message ?? exc}`);
    }
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date(now.getTime() + 1000)),
        eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
        body: {
          preference: renderPrefLink({ id: prefResult.id, principle: String(flags["principle"]) }),
          agent,
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append force-confirmed log failed: ${(err as Error).message}\n`,
      );
    }
  }

  if (flags["json"]) {
    okJson({
      signal_path: sigResult.path,
      signal_id: sigResult.id,
      ...(mirror !== undefined ? { mirror } : {}),
      ...(advisory !== null ? { advisory } : {}),
      ...(prefResult ? { preference_path: prefResult.path, preference_id: prefResult.id } : {}),
    });
    return 0;
  }
  ok(`signal: ${sigResult.path}`);
  ok(`id: ${sigResult.id}`);
  if (mirror !== undefined) {
    ok(`mirror: ${mirror}`);
  }
  if (advisory !== null) {
    const where = advisory.scope ?? "(unscoped)";
    ok(
      `advisory: incoming principle resembles ${advisory.conflicts.length} confirmed ${where} preference(s)`,
    );
    for (const c of advisory.conflicts) {
      ok(`  - ${c.pref_id} (jaccard ${c.jaccard.toFixed(3)})`);
    }
  }
  if (prefResult) {
    ok(`preference: ${prefResult.path}`);
    ok(`status: confirmed`);
  }
  return 0;
}
