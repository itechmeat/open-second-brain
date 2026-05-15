/**
 * `o2b brain` subcommand dispatcher.
 *
 * Routes the eleven Brain verbs (design doc §9.2) to thin wrappers over
 * `src/core/brain/*`. The core modules own all I/O and business logic;
 * this file only parses flags, resolves the vault, and shapes the
 * exit-code matrix (0 success / 1 error / 2 informational not-found).
 *
 * Layout mirrors `src/cli/main.ts` — one `cmdBrain<Verb>` function per
 * verb, each returning a number that {@link handleBrainSubcommand} hands
 * back to the outer dispatcher.
 *
 * State-changing verbs print a single human-readable line on stdout.
 * Read-only verbs (digest, query, doctor) honour `--json`. The `--json`
 * flag on state-changing verbs (init/feedback/apply-evidence/...) emits a
 * minimal `{ok: true, ...}` summary so scripted callers can still pin on
 * structured output.
 *
 * Pinning / unpinning / reject / pin / rollback / init are intentionally
 * CLI-only — the MCP surface in Task 7 does not expose them so an
 * autonomous agent cannot mutate the protected set, retire rules
 * unilaterally, or overwrite the vault from a snapshot.
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

import {
  defaultConfigPath,
  resolveAgentName,
  resolveVault,
} from "../core/config.ts";
import { bootstrapBrain } from "../core/brain/init.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
} from "../core/brain/apply-evidence.ts";
import { dream } from "../core/brain/dream.ts";
import { moveToRetired, parsePreference, writePreference } from "../core/brain/preference.ts";
import { preferencePath } from "../core/brain/paths.ts";
import { isoDate, isoSecond } from "../core/brain/time.ts";
import {
  queryByLogSince,
  queryByPreference,
  queryByTopic,
  BrainNotFoundError,
} from "../core/brain/query.ts";
import { renderDigest, type RenderDigestOptions } from "../core/brain/digest.ts";
import { runDoctor } from "../core/brain/doctor.ts";
import { setPinned } from "../core/brain/pin.ts";
import { writeSignal } from "../core/brain/signal.ts";
import { listSnapshots, restoreSnapshot } from "../core/brain/snapshot.ts";
import { appendLogEvent, type BrainLogEntry } from "../core/brain/log.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../core/brain/types.ts";
import { CliError, parseFlags, type FlagsSchema } from "./argparse.ts";

const NO_VAULT_ERROR =
  "error: no vault configured. Pass --vault <path> explicitly, " +
  "set VAULT_DIR in the environment, or run " +
  "`o2b init --vault <path> ...` first to persist a default.";

/**
 * Resolve a vault path from CLI flags or machine-local config. Throws a
 * {@link CliError} with the standard help message when neither source
 * supplies a value — the dispatcher converts this into exit code 1.
 */
function resolveBrainVault(
  flagVal: string | undefined,
  configPath: string | null,
): string {
  const vault = flagVal ?? resolveVault(configPath ?? undefined);
  if (vault === null || vault === undefined) {
    throw new CliError(NO_VAULT_ERROR);
  }
  return vault;
}

/** Emit a state-changing command's status line on stdout. */
function ok(line: string): void {
  process.stdout.write(line + (line.endsWith("\n") ? "" : "\n"));
}

/** Emit minimal JSON for `--json` on state-changing commands. */
function okJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
}

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

function info(message: string): void {
  process.stdout.write(message + (message.endsWith("\n") ? "" : "\n"));
}

/**
 * Strict ISO-8601 timestamp matcher used by `--now / --since / --until`.
 * The plain `new Date(s)` constructor is far too permissive (it happily
 * parses `"2026"`, `"hello world"` via some locales, year-only strings,
 * etc.). We require a full date-time including offset (`Z` or `±HH:MM`),
 * which is the shape `isoSecond()` emits and what scripted callers send.
 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// ── Common parse helpers ────────────────────────────────────────────────────

/**
 * Wrap `parseFlags` with a uniform failure path: bad flags surface as
 * `CliError` and the dispatcher converts those to exit code 1.
 */
function parse(
  argv: ReadonlyArray<string>,
  schema: FlagsSchema,
): {
  flags: Record<string, string | boolean | string[] | undefined>;
  positional: string[];
} {
  return parseFlags(argv, schema);
}

// ── Verb handlers ───────────────────────────────────────────────────────────

async function cmdBrainInit(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  // `bootstrapBrain` itself refuses without a registered machine config;
  // resolve the vault from flag-or-config so a freshly registered machine
  // can run `o2b brain init` without restating `--vault`.
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = bootstrapBrain(vault, {
      force: Boolean(flags["force"]),
      configPath: config,
    });
  } catch (exc) {
    return fail(`failed to initialize Brain: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({
      vault,
      created: result.created,
      overwritten: result.overwritten,
      skipped: result.skipped,
    });
    return 0;
  }
  ok(`brain initialized: ${vault}`);
  for (const p of result.created) info(`  created: ${p}`);
  for (const p of result.overwritten) info(`  overwritten: ${p}`);
  for (const p of result.skipped) info(`  exists: ${p}`);
  return 0;
}

async function cmdBrainFeedback(argv: string[]): Promise<number> {
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

  // Required-flag enforcement is custom here so the error message names
  // the field — design doc §13.7 demands "missing required argument
  // exits 1 naming the field".
  for (const field of ["topic", "signal", "principle"] as const) {
    if (typeof flags[field] !== "string" || (flags[field] as string).trim() === "") {
      return fail(`brain feedback missing required flag: --${field}`);
    }
  }

  const signalSign = String(flags["signal"]);
  if (
    signalSign !== BRAIN_SIGNAL_SIGN.positive &&
    signalSign !== BRAIN_SIGNAL_SIGN.negative
  ) {
    return fail(
      `--signal must be 'positive' or 'negative'; got ${JSON.stringify(signalSign)}`,
    );
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

  // 1. Always write the signal to inbox/. (§9.2: feedback always creates
  // `sig-*`; `--force-confirmed` ADDITIONALLY creates a confirmed pref.)
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
      ...(flags["source"]
        ? { source: flags["source"] as string[] }
        : {}),
      ...(raw !== undefined ? { raw } : {}),
    });
  } catch (exc) {
    return fail(`failed to write signal: ${(exc as Error).message ?? exc}`);
  }

  // Emit a feedback log event so the dream loop can later attribute the
  // signal (and pin / unpin parity stays neat: every state-changing CLI
  // verb leaves a breadcrumb).
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
    // Log-event failure is non-fatal: the signal is already on disk and
    // the next dream pass will pick it up via filesystem scan. Surface
    // a warning so the audit trail gap is at least visible to the
    // operator.
    process.stderr.write(
      `warning: append feedback log failed: ${(err as Error).message}\n`,
    );
  }

  // 2. Optional escape hatch — `--force-confirmed` jumps the loop and
  // creates a `pref-*` directly in `status: confirmed`.
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
          ...(flags["scope"] ? { scope: String(flags["scope"]) } : {}),
        },
        { overwrite: false },
      );
    } catch (exc) {
      return fail(
        `failed to force-confirm preference: ${(exc as Error).message ?? exc}`,
      );
    }
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date(now.getTime() + 1000)),
        eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
        body: {
          preference: `[[${prefResult.id}]]`,
          agent,
        },
      });
    } catch (err) {
      // Non-fatal: the preference is already on disk; surface so the
      // gap in the audit trail is at least visible.
      process.stderr.write(
        `warning: append force-confirmed log failed: ${(err as Error).message}\n`,
      );
    }
  }

  if (flags["json"]) {
    okJson({
      signal_path: sigResult.path,
      signal_id: sigResult.id,
      ...(prefResult
        ? { preference_path: prefResult.path, preference_id: prefResult.id }
        : {}),
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

async function cmdBrainDream(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    now: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let now: Date | undefined;
  const nowStr = flags["now"] as string | undefined;
  if (nowStr) {
    if (!ISO_8601_RE.test(nowStr)) {
      return fail(`--now must be a valid ISO-8601 timestamp; got ${nowStr}`);
    }
    const parsed = new Date(nowStr);
    if (!Number.isFinite(parsed.getTime())) {
      return fail(`--now must be a valid ISO-8601 timestamp; got ${nowStr}`);
    }
    now = parsed;
  }

  let summary;
  try {
    summary = dream(vault, {
      ...(now !== undefined ? { now } : {}),
      dryRun: Boolean(flags["dry-run"]),
    });
  } catch (exc) {
    return fail(`dream failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  ok(`run_id: ${summary.run_id}`);
  ok(`changed: ${summary.changed}`);
  if (summary.new_unconfirmed.length > 0) {
    ok(`new_unconfirmed: ${summary.new_unconfirmed.join(", ")}`);
  }
  if (summary.confirmed.length > 0) {
    ok(`confirmed: ${summary.confirmed.join(", ")}`);
  }
  if (summary.retired.length > 0) {
    ok(
      `retired: ${summary.retired.map((r) => `${r.id} (${r.reason})`).join(", ")}`,
    );
  }
  if (summary.contradictions.length > 0) {
    ok(`contradictions: ${summary.contradictions.join(", ")}`);
  }
  if (summary.moved_to_processed.length > 0) {
    ok(`moved_to_processed: ${summary.moved_to_processed.length}`);
  }
  return 0;
}

async function cmdBrainApplyEvidence(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    pref: { type: "string" },
    artifact: { type: "string" },
    result: { type: "string" },
    agent: { type: "string" },
    note: { type: "string" },
    json: { type: "boolean" },
  });
  for (const field of ["pref", "artifact", "result"] as const) {
    if (typeof flags[field] !== "string" || (flags[field] as string).trim() === "") {
      return fail(`brain apply-evidence missing required flag: --${field}`);
    }
  }
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  const resultStr = String(flags["result"]);
  if (resultStr !== "applied" && resultStr !== "violated") {
    return fail(`--result must be 'applied' or 'violated'; got ${resultStr}`);
  }

  try {
    const out = appendApplyEvidence(vault, {
      pref_id: String(flags["pref"]),
      artifact: String(flags["artifact"]),
      result: resultStr,
      agent,
      ...(flags["note"] ? { note: String(flags["note"]) } : {}),
    });
    if (flags["json"]) {
      okJson({ logged_at: out.logged_at, log_path: out.log_path });
    } else {
      ok(`logged: ${out.log_path}`);
      ok(`at: ${out.logged_at}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      // Informative not-found per §9.2 — exit 2, not 1.
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`apply-evidence failed: ${(exc as Error).message ?? exc}`);
  }
}

async function cmdBrainDigest(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    json: { type: "boolean" },
    "silent-if-empty": { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  // Validate inputs before building the options literal so we never
  // materialise an `opts` object with NaN-time `Date`s. Strict ISO-8601
  // pattern check first so `--since 2026` / `--since "hello"` are rejected
  // before `new Date()` happily silently coerces them.
  let sinceDate: Date | undefined;
  if (flags["since"]) {
    const raw = String(flags["since"]);
    if (!ISO_8601_RE.test(raw)) {
      return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) {
      return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    sinceDate = d;
  }
  let untilDate: Date | undefined;
  if (flags["until"]) {
    const raw = String(flags["until"]);
    if (!ISO_8601_RE.test(raw)) {
      return fail(`--until must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) {
      return fail(`--until must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    untilDate = d;
  }
  const opts: RenderDigestOptions = {
    ...(sinceDate ? { since: sinceDate } : {}),
    ...(untilDate ? { until: untilDate } : {}),
    format: flags["json"] ? "json" : "markdown",
  };

  let result;
  try {
    result = renderDigest(vault, opts);
  } catch (exc) {
    return fail(`digest failed: ${(exc as Error).message ?? exc}`);
  }

  if (result.empty && flags["silent-if-empty"]) {
    // §8: exit 2 with no output. The CLI is the one place this matters
    // — scripts can branch on the exit code rather than parsing stdout.
    return 2;
  }
  process.stdout.write(result.content);
  if (!result.content.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

async function cmdBrainQuery(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    preference: { type: "string" },
    topic: { type: "string" },
    since: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  // Mutually exclusive choice — pick one of the three query shapes.
  const modes = ["preference", "topic", "since"].filter(
    (k) => typeof flags[k] === "string" && (flags[k] as string).trim() !== "",
  );
  if (modes.length === 0) {
    return fail(
      "brain query requires exactly one of --preference, --topic, --since",
    );
  }
  if (modes.length > 1) {
    return fail(
      `brain query: pick only one of --preference / --topic / --since (got ${modes.join(", ")})`,
    );
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
      const out = queryByTopic(vault, String(flags["topic"]));
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        renderQueryTopicText(out, String(flags["topic"]));
      }
      return 0;
    }
    if (flags["since"]) {
      const raw = String(flags["since"]);
      if (!ISO_8601_RE.test(raw)) {
        return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
      }
      const d = new Date(raw);
      if (!Number.isFinite(d.getTime())) {
        return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
      }
      const entries = queryByLogSince(vault, d);
      if (flags["json"]) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      } else {
        renderQueryLogText(entries);
      }
      return 0;
    }
  } catch (exc) {
    if (exc instanceof BrainNotFoundError) {
      // Per §9.2 informational not-found: exit 2.
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`query failed: ${(exc as Error).message ?? exc}`);
  }
  return 0; // unreachable but keeps TypeScript happy
}

async function cmdBrainReject(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    id: { type: "string" },
    reason: { type: "string" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (typeof flags["id"] !== "string" || (flags["id"] as string).trim() === "") {
    return fail("brain reject missing required flag: --id");
  }
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = resolveAgentName(config);

  // Resolve the preference file. If absent → exit 2 (informational
  // not-found per §9.2 pattern, consistent with apply-evidence).
  const rawId = String(flags["id"]).trim();
  const slug = rawId.startsWith("pref-") ? rawId.slice("pref-".length) : rawId;
  const path = preferencePath(vault, slug);
  if (!existsSync(path)) {
    process.stderr.write(
      `preference not found: pref-${slug}; expected ${path}\n`,
    );
    return 2;
  }
  let pref;
  try {
    pref = parsePreference(path);
  } catch (exc) {
    return fail(`failed to parse preference: ${(exc as Error).message ?? exc}`);
  }

  // Pin protection — refuse without --yes per §15 Step 23b.
  if (pref.pinned && !flags["yes"]) {
    process.stderr.write(
      `warning: preference '${pref.id}' is pinned; pass --yes to override\n`,
    );
    return 1;
  }

  const now = new Date();
  const todayDate = isoDate(now);
  const retiredBy = `[[Brain/log/${todayDate}]]`;

  try {
    moveToRetired(vault, path, "user-rejected", {
      now,
      retired_by: retiredBy,
    });
  } catch (exc) {
    return fail(`failed to retire preference: ${(exc as Error).message ?? exc}`);
  }

  // Log a `reject` event so the audit trail stays complete.
  try {
    const body: Record<string, string> = {
      preference: `[[ret-${slug}]]`,
      agent,
    };
    if (flags["reason"]) body["reason"] = String(flags["reason"]);
    if (pref.pinned) body["was_pinned"] = "true";
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.reject,
      body,
    });
  } catch (err) {
    // Non-fatal: the retire move is already persisted; surface so the
    // gap in the audit trail is at least visible.
    process.stderr.write(
      `warning: append reject log failed: ${(err as Error).message}\n`,
    );
  }

  if (flags["json"]) {
    okJson({ id: `ret-${slug}`, reason: "user-rejected" });
  } else {
    ok(`retired: ret-${slug} (user-rejected)`);
  }
  return 0;
}

async function cmdBrainPin(argv: string[]): Promise<number> {
  return await pinOrUnpin(argv, true);
}

async function cmdBrainUnpin(argv: string[]): Promise<number> {
  return await pinOrUnpin(argv, false);
}

async function pinOrUnpin(argv: string[], value: boolean): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    id: { type: "string" },
    json: { type: "boolean" },
  });
  if (typeof flags["id"] !== "string" || (flags["id"] as string).trim() === "") {
    return fail(
      `brain ${value ? "pin" : "unpin"} missing required flag: --id`,
    );
  }
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = resolveAgentName(config);

  try {
    const out = setPinned(vault, String(flags["id"]), value, { agent });
    const slug = String(flags["id"]).trim().replace(/^pref-/, "");
    const label = value ? "pinned" : "unpinned";
    const idemLabel = value ? "already pinned" : "already unpinned";
    if (flags["json"]) {
      okJson({ id: `pref-${slug}`, changed: out.changed, pinned: value });
    } else if (out.changed) {
      ok(`${label}: pref-${slug}`);
    } else {
      ok(`${idemLabel}: pref-${slug}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(
      `${value ? "pin" : "unpin"} failed: ${(exc as Error).message ?? exc}`,
    );
  }
}

async function cmdBrainRollback(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    list: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  // `--list` shows available snapshots in newest-first order, with size
  // for the operator's mental model. Idempotent and read-only.
  if (flags["list"]) {
    const snaps = listSnapshots(vault);
    if (flags["json"]) {
      process.stdout.write(JSON.stringify(snaps, null, 2) + "\n");
      return 0;
    }
    if (snaps.length === 0) {
      ok("no snapshots available");
      return 0;
    }
    ok("run_id\tcreated_at\tsize_bytes");
    for (const s of snaps) {
      ok(`${s.run_id}\t${s.created_at}\t${s.size_bytes}`);
    }
    return 0;
  }

  if (positional.length < 1) {
    return fail(
      "brain rollback requires a <run_id> argument (or --list to enumerate snapshots)",
    );
  }
  const runId = positional[0]!;

  // Quick existence probe so the user gets a useful exit-2 not-found
  // message instead of a deep error inside `restoreSnapshot`.
  const allSnaps = listSnapshots(vault);
  if (!allSnaps.some((s) => s.run_id === runId)) {
    process.stderr.write(
      `snapshot not found: ${runId}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }

  // Interactive confirm. We compute a minimal diff summary by counting
  // entries in the current state (the snapshot's content would require
  // extracting first; the headline is intentionally lightweight — "you
  // are about to overwrite N files").
  if (!flags["yes"]) {
    // Non-interactive guard: --json output or non-TTY stdin (CI, pipes)
    // would silently hang waiting for input. Fail fast and demand --yes
    // so automation never blocks on a dropped prompt.
    if (flags["json"] || !process.stdin.isTTY) {
      return fail(
        "rollback requires --yes in non-interactive mode (--json or non-TTY stdin)",
      );
    }
    const summary = diffSummary(vault);
    process.stderr.write(
      `About to restore snapshot '${runId}' over Brain/.\n` +
        `Current state: ${summary.preferences} preferences, ${summary.retired} retired, ${summary.signals} signals.\n` +
        `This will OVERWRITE the live Brain/ tree (.snapshots/ is preserved).\n` +
        `Proceed? [y/N] `,
    );
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      ok("rollback cancelled");
      return 0;
    }
  }

  let result;
  try {
    result = restoreSnapshot(vault, runId);
  } catch (exc) {
    return fail(`rollback failed: ${(exc as Error).message ?? exc}`);
  }

  // Log the rollback event so the audit trail shows the time-shift.
  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.rollback,
      body: {
        run_id: runId,
        restored_files: String(result.restored_files),
      },
    });
  } catch (err) {
    // Non-fatal: the snapshot was already restored on disk; surface so
    // the gap in the audit trail is at least visible.
    process.stderr.write(
      `warning: append rollback log failed: ${(err as Error).message}\n`,
    );
  }

  if (flags["json"]) {
    okJson({ run_id: runId, restored_files: result.restored_files });
  } else {
    ok(`restored: ${runId} (${result.restored_files} files)`);
  }
  return 0;
}

async function cmdBrainDoctor(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = runDoctor(vault, { strict: Boolean(flags["strict"]) });
  } catch (exc) {
    return fail(`doctor failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { warnings: result.warnings, errors: result.errors },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const e of result.errors) {
      process.stdout.write(
        `[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`,
      );
    }
    for (const w of result.warnings) {
      process.stdout.write(
        `[WARN]  ${w.code}: ${w.message}${w.path ? ` (${w.path})` : ""}\n`,
      );
    }
    if (result.errors.length === 0 && result.warnings.length === 0) {
      ok("brain doctor: clean");
    }
  }

  // Exit-code matrix per §9.2: errors → 1; warnings → 0 unless --strict
  // (then 2); clean → 0.
  if (result.errors.length > 0) return 1;
  if (result.warnings.length > 0 && flags["strict"]) return 2;
  return 0;
}

// ── Help text ───────────────────────────────────────────────────────────────

const BRAIN_HELP = `usage: o2b brain <verb> [args...]

Brain verbs (observing memory):
  init             Bootstrap <vault>/Brain/ (idempotent; --force overwrites)
  feedback         Record a taste signal (--topic, --signal, --principle)
  dream            Run the deterministic dreaming pass (idempotent)
  apply-evidence   Log a real-work application of a preference
  digest           Render the recent-changes digest (markdown or --json)
  query            Read by --preference, --topic, or --since
  reject           Move a preference to retired (user-rejected); --yes if pinned
  pin              Mark a preference exempt from automatic retire (idempotent)
  unpin            Clear the pinned flag (idempotent)
  rollback         Restore Brain/ from a snapshot (--list or <run_id>; --yes)
  doctor           Validate Brain invariants (--strict promotes warnings to exit 2)

Common flags:
  --vault <path>   Override the configured vault
  --json           Structured output where applicable
  --help           Per-verb help (run \`o2b brain <verb> --help\`)
`;

const VERB_HELP: Record<string, string> = {
  init:
    "usage: o2b brain init [--vault <path>] [--force] [--json]\n" +
    "Bootstrap <vault>/Brain/. Requires `o2b init` to have run first.\n",
  feedback:
    "usage: o2b brain feedback --topic <slug> --signal positive|negative --principle <text>\n" +
    "  [--scope <slug>] [--source <wikilink>...] [--agent <name>] [--raw <text>|--raw-file <path>]\n" +
    "  [--force-confirmed] [--vault <path>] [--json]\n" +
    "Creates a `sig-*.md` in Brain/inbox/. With --force-confirmed also creates a `pref-*.md`.\n",
  dream:
    "usage: o2b brain dream [--vault <path>] [--dry-run] [--now <ISO-8601>] [--json]\n" +
    "Runs the deterministic dreaming algorithm. Idempotent on rerun.\n",
  "apply-evidence":
    "usage: o2b brain apply-evidence --pref <id> --artifact <wikilink> --result applied|violated\n" +
    "  [--agent <name>] [--note <text>] [--vault <path>] [--json]\n" +
    "Appends a single event to today's log. Missing preference exits 2.\n",
  digest:
    "usage: o2b brain digest [--vault <path>] [--since <ISO>] [--until <ISO>] [--json] [--silent-if-empty]\n" +
    "Renders the 24-hour change digest. Empty + --silent-if-empty exits 2.\n",
  query:
    "usage: o2b brain query --preference <id> | --topic <slug> | --since <ISO> [--vault <path>] [--json]\n" +
    "Read-only lookup. One of --preference / --topic / --since is required.\n",
  reject:
    "usage: o2b brain reject --id <pref-id> [--reason <text>] [--yes] [--vault <path>] [--json]\n" +
    "Move a preference to retired/ with reason 'user-rejected'. --yes required when pinned.\n",
  pin:
    "usage: o2b brain pin --id <pref-id> [--vault <path>] [--json]\n" +
    "Set pinned: true. Idempotent. Exempts the preference from automatic retire.\n",
  unpin:
    "usage: o2b brain unpin --id <pref-id> [--vault <path>] [--json]\n" +
    "Clear pinned: true. Idempotent.\n",
  rollback:
    "usage: o2b brain rollback <run_id> [--vault <path>] [--yes] [--json]\n" +
    "       o2b brain rollback --list [--vault <path>] [--json]\n" +
    "Restore Brain/ from a snapshot. Interactive prompt unless --yes.\n",
  doctor:
    "usage: o2b brain doctor [--vault <path>] [--json] [--strict]\n" +
    "Validate invariants. Warnings exit 0 (or 2 with --strict). Errors always exit 1.\n",
};

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Dispatch `o2b brain <verb> [...args]`. Returns the exit code; the caller
 * (`main.ts`) forwards it to `process.exit`. Unknown verbs print the
 * brain help text and return 2.
 */
export async function handleBrainSubcommand(
  argv: ReadonlyArray<string>,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(BRAIN_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  // Per-verb help.
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
    const text = VERB_HELP[verb];
    if (text) {
      process.stdout.write(text);
      return 0;
    }
    // Unknown verb requesting --help: fall back to generic brain help
    // and return 2 (same exit code as the unknown-verb branch in the
    // dispatcher below).
    process.stdout.write(BRAIN_HELP);
    return 2;
  }

  try {
    switch (verb) {
      case "init":
        return await cmdBrainInit(rest);
      case "feedback":
        return await cmdBrainFeedback(rest);
      case "dream":
        return await cmdBrainDream(rest);
      case "apply-evidence":
        return await cmdBrainApplyEvidence(rest);
      case "digest":
        return await cmdBrainDigest(rest);
      case "query":
        return await cmdBrainQuery(rest);
      case "reject":
        return await cmdBrainReject(rest);
      case "pin":
        return await cmdBrainPin(rest);
      case "unpin":
        return await cmdBrainUnpin(rest);
      case "rollback":
        return await cmdBrainRollback(rest);
      case "doctor":
        return await cmdBrainDoctor(rest);
      default:
        process.stderr.write(`error: unknown brain verb: ${verb}\n`);
        process.stdout.write(BRAIN_HELP);
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DiffSummary {
  readonly preferences: number;
  readonly retired: number;
  readonly signals: number;
}

/**
 * Count the entries currently under `Brain/{preferences,retired,inbox}/`.
 * Used for the interactive rollback confirmation so the operator sees
 * the scale of the overwrite before pressing `y`.
 */
function diffSummary(vault: string): DiffSummary {
  const root = resolve(vault, "Brain");
  const safeCount = (p: string): number => {
    if (!existsSync(p)) return 0;
    try {
      const st = statSync(p);
      if (!st.isDirectory()) return 0;
    } catch {
      return 0;
    }
    try {
      const entries: Dirent[] = readdirSync(p, { withFileTypes: true });
      return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  return {
    preferences: safeCount(resolve(root, "preferences")),
    retired: safeCount(resolve(root, "retired")),
    signals: safeCount(resolve(root, "inbox")),
  };
}

/**
 * Read a single trimmed line from stdin. Returns `""` on EOF so the
 * default-N branch fires when the prompt receives no input (pipe closed,
 * non-interactive shell).
 */
function readSingleLine(): Promise<string> {
  return new Promise((res) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.pause();
        res(buf.slice(0, nl).trim());
      }
    };
    const onEnd = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      res(buf.trim());
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

// ── Renderers (text mode) ───────────────────────────────────────────────────

function renderQueryPreferenceText(
  out: ReturnType<typeof queryByPreference>,
): void {
  const p = out.preference;
  ok(`id: ${p.id}`);
  ok(`topic: ${p.topic}`);
  if (p.scope) ok(`scope: ${p.scope}`);
  ok(`status: ${"status" in p ? p.status : "(unknown)"}`);
  ok(`principle: ${p.principle}`);
  if (out.evidence.length === 0) {
    ok("evidence: (none)");
    return;
  }
  ok("evidence:");
  for (const e of out.evidence) {
    const artifact = e.body["artifact"] ?? "(unknown)";
    const result = e.body["result"] ?? "(unknown)";
    info(`  - ${e.timestamp} ${result}: ${artifact}`);
  }
}

function renderQueryTopicText(
  out: ReturnType<typeof queryByTopic>,
  topic: string,
): void {
  ok(`topic: ${topic}`);
  if (out.preference) {
    ok(`preference: ${out.preference.id}`);
  } else {
    ok("preference: (none)");
  }
  ok(`signals: ${out.signals.length}`);
  for (const s of out.signals) {
    info(`  - ${s.id} (${s.signal}, ${s.created_at})`);
  }
  ok(`log_events: ${out.all_log_events.length}`);
}

function renderQueryLogText(entries: ReadonlyArray<BrainLogEntry>): void {
  ok(`entries: ${entries.length}`);
  for (const e of entries) {
    info(`  - ${e.timestamp} ${e.eventType}`);
  }
}
