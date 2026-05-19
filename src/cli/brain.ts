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

import { atomicWriteFileSync } from "../core/fs-atomic.ts";

import {
  defaultConfigPath,
  resolveAgentName,
  resolveVault,
} from "../core/config.ts";
import { buildBacklinkIndex } from "../core/brain/backlinks.ts";
import { normaliseWikilinkTarget, renderPrefLink } from "../core/brain/wikilink.ts";
import { bootstrapBrain } from "../core/brain/init.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
} from "../core/brain/apply-evidence.ts";
import { dream } from "../core/brain/dream.ts";
import {
  applyMigration,
  MigrationError,
  planMigration,
} from "../core/brain/migrate-frontmatter.ts";
import { scanInline } from "../core/brain/inline-scan.ts";
import {
  importSession,
  importSessionPath,
} from "../core/brain/sessions/import.ts";
import { SessionImportError } from "../core/brain/sessions/types.ts";
import {
  buildLiveServer,
  collectExplorerData,
  renderExportedHtml,
  type LiveServerHandle,
} from "../core/brain/explorer.ts";
import {
  BrainMergeError,
  mergePreferences,
  type MergePlan,
} from "../core/brain/merge.ts";
import { moveToRetired, parsePreference, writePreference } from "../core/brain/preference.ts";
import { brainDirs, preferencePath } from "../core/brain/paths.ts";
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
import {
  applyProtect,
  BrainProtectError,
  isProtectTarget,
  printSnippet,
  PROTECT_TARGETS,
  unprotect,
} from "../core/brain/protect.ts";
import { setPrimaryAgent } from "../core/brain/set-primary.ts";
import { writeSignal } from "../core/brain/signal.ts";
import {
  extractSnapshotToTemp,
  listSnapshots,
  restoreSnapshot,
  type ExtractSnapshotResult,
} from "../core/brain/snapshot.ts";
import {
  buildManifest,
  diffManifests,
  manifestDiffHasDrift,
  readManifestSidecar,
  renderManifestDriftJson,
  renderManifestDriftMarkdown,
} from "../core/brain/manifest.ts";
import { diffBrainTrees } from "../core/brain/snapshot-diff.ts";
import {
  renderDiffJson,
  renderDiffMarkdown,
} from "../core/brain/snapshot-diff-render.ts";
import { appendLogEvent, type BrainLogEntry } from "../core/brain/log.ts";
import {
  BrainUpgradeError,
  applyUpgrade,
  planUpgrade,
  type UpgradeFilePlan,
  type UpgradePlan,
} from "../core/brain/upgrade.ts";
import {
  exportPreferencesJson,
  exportPreferencesLlmsTxt,
} from "../core/brain/export.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../core/brain/types.ts";
import { CliError, parseFlags, type FlagsSchema } from "./argparse.ts";
import {
  importClaudeMemory,
  ConflictsError,
} from "../core/brain/import-claude-memory.ts";
import { defaultMemoryDir } from "../core/brain/claude-memory-paths.ts";

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
    "primary-agent": { type: "string" },
    starter: { type: "boolean" },
    "starter-path": { type: "string" },
    json: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  // `bootstrapBrain` itself refuses without a registered machine config;
  // resolve the vault from flag-or-config so a freshly registered machine
  // can run `o2b brain init` without restating `--vault`.
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const primaryAgentFlag = flags["primary-agent"];
  let primaryAgent: string | undefined;
  if (typeof primaryAgentFlag === "string") {
    const trimmed = primaryAgentFlag.trim();
    if (trimmed.length === 0) {
      return fail(
        "brain init: --primary-agent must be a non-empty string when provided",
      );
    }
    primaryAgent = trimmed;
  }

  const starterPathFlag = flags["starter-path"];
  let starterPath: string | undefined;
  if (typeof starterPathFlag === "string") {
    starterPath = starterPathFlag.trim();
    if (starterPath.length === 0) {
      return fail(
        "brain init: --starter-path must be a non-empty path when provided",
      );
    }
  }

  let result;
  try {
    result = bootstrapBrain(vault, {
      force: Boolean(flags["force"]),
      configPath: config,
      starter: Boolean(flags["starter"]),
      ...(primaryAgent !== undefined ? { primaryAgent } : {}),
      ...(starterPath !== undefined ? { starterPath } : {}),
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
          preference: renderPrefLink({
            id: prefResult.id,
            principle: String(flags["principle"]),
          }),
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
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  // Match `cmdBrainInit`'s --primary-agent contract: when the flag is
  // supplied, reject blank input rather than silently fall through to
  // the resolved default. A whitespace-only --agent would otherwise
  // bypass the non-primary check entirely.
  const agentFlag = flags["agent"];
  let agent: string;
  if (typeof agentFlag === "string") {
    const trimmed = agentFlag.trim();
    if (trimmed.length === 0) {
      return fail(
        "brain dream: --agent must be a non-empty string when provided",
      );
    }
    agent = trimmed;
  } else {
    agent = resolveAgentName(config);
  }

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
      ...(agent ? { agentName: agent } : {}),
    });
  } catch (exc) {
    return fail(`dream failed: ${(exc as Error).message ?? exc}`);
  }

  // Surface non-fatal warnings (§21 non-primary check, future advisory
  // codes) on stderr regardless of output mode. The run already
  // completed successfully; stdout stays reserved for the structured
  // summary / human-readable status lines.
  for (const w of summary.warnings ?? []) {
    process.stderr.write(`warning: ${w.code}: ${w.message}\n`);
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
  if (
    resultStr !== "applied" &&
    resultStr !== "violated" &&
    resultStr !== "outdated"
  ) {
    return fail(
      `--result must be 'applied', 'violated', or 'outdated'; got ${resultStr}`,
    );
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
  // v0.10.1: `--reason` is now mandatory. The text is persisted on the
  // retired file (`user_rejected_reason`) and used by dream to mark
  // future signals on the same topic as `signal-suppressed`. Without
  // it the suppression chain breaks and the reject is just a quiet
  // delete — exactly the failure mode §6 of _summary calls out.
  if (typeof flags["reason"] !== "string" || (flags["reason"] as string).trim() === "") {
    return fail(
      "brain reject missing required flag: --reason (free-form text; persisted on the retired file)",
    );
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

  const reasonText = String(flags["reason"]).trim();
  try {
    moveToRetired(vault, path, "user-rejected", {
      now,
      retired_by: retiredBy,
      user_rejected_reason: reasonText,
    });
  } catch (exc) {
    return fail(`failed to retire preference: ${(exc as Error).message ?? exc}`);
  }

  // Log a `reject` event so the audit trail stays complete.
  try {
    const body: Record<string, string> = {
      preference: renderPrefLink({
        id: `ret-${slug}`,
        principle: pref.principle,
      }),
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

async function cmdBrainMerge(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length !== 2) {
    return fail(
      "brain merge requires exactly two positional ids: <keep-pref-id> <drop-pref-id>",
    );
  }
  const [keepId, dropId] = positional as [string, string];
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const dryRun = flags["dry-run"] === true;
  const force = flags["force"] === true;
  const wantJson = flags["json"] === true;

  // Plan first via dryRun so the prompt shows real numbers without
  // touching disk. A second call commits when the operator agrees.
  // Each `mergePreferences` invocation takes its own fresh timestamp
  // so the commit reflects when it ran (the operator may take a
  // long time to confirm at the prompt below).
  let plan: MergePlan;
  try {
    plan = mergePreferences(vault, keepId, dropId, {
      now: new Date(),
      agentName: agent,
      dryRun: true,
    });
  } catch (exc) {
    if (exc instanceof BrainMergeError) {
      return fail(`brain merge: ${exc.message}`);
    }
    return fail(
      `brain merge: failed to plan merge: ${(exc as Error).message ?? exc}`,
    );
  }

  const planLines = [
    `merge plan:`,
    `  keep: ${plan.keep_id}`,
    `  drop: ${plan.drop_id} → ${plan.retired_path}`,
    `  topic: ${plan.topic}${plan.scope ? `, scope: ${plan.scope}` : ""}`,
    `  evidenced_by union: ${plan.merged_evidenced_by.length}`,
    `  applied_sum: ${plan.applied_sum}`,
    `  violated_sum: ${plan.violated_sum}`,
    `  last_evidence_at: ${plan.last_evidence_at ?? "—"}`,
  ];

  if (dryRun) {
    if (wantJson) {
      okJson({ dry_run: true, plan });
    } else {
      for (const line of planLines) ok(line);
      ok("dry-run; no changes written");
    }
    return 0;
  }

  if (!force) {
    if (wantJson) {
      return fail(
        "brain merge: --json without --force is not supported (interactive prompt cannot render)",
      );
    }
    // Non-TTY stdin can only "answer" the prompt with EOF, which we
    // would interpret as N → exit 0 "merge cancelled". For
    // automation that path is misleading (looks like an intentional
    // no-op). Require `--force` instead, same shape as rollback /
    // migrate-frontmatter guards.
    if (!process.stdin.isTTY) {
      return fail(
        "brain merge: --force required when stdin is not a TTY (cannot prompt for confirmation)",
      );
    }
    for (const line of planLines) process.stderr.write(line + "\n");
    process.stderr.write("Proceed? [y/N] ");
    const ans = (await readSingleLine()).toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      ok("merge cancelled");
      return 0;
    }
  }

  try {
    mergePreferences(vault, keepId, dropId, {
      now: new Date(),
      agentName: agent,
    });
  } catch (exc) {
    if (exc instanceof BrainMergeError) {
      return fail(`brain merge: ${exc.message}`);
    }
    return fail(
      `brain merge: failed to commit merge: ${(exc as Error).message ?? exc}`,
    );
  }

  if (wantJson) {
    okJson({ merged: true, plan });
  } else {
    ok(`merged: ${plan.drop_id} → ${plan.keep_id} (retired as merged-into)`);
  }
  return 0;
}

async function cmdBrainExplorer(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    port: { type: "string" },
    export: { type: "string" },
    force: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const exportPath = flags["export"] as string | undefined;
  const force = flags["force"] === true;

  if (exportPath !== undefined) {
    if (existsSync(exportPath) && !force) {
      return fail(
        `${exportPath} exists; pass --force to overwrite`,
      );
    }
    const graph = collectExplorerData(vault);
    const html = renderExportedHtml(graph);
    try {
      atomicWriteFileSync(exportPath, html);
    } catch (err) {
      return fail(
        `failed to write ${exportPath}: ${(err as Error).message ?? err}`,
      );
    }
    ok(`exported ${graph.nodes.length} nodes to ${exportPath}`);
    return 0;
  }

  const portRaw = (flags["port"] as string | undefined) ?? "7777";
  const port = Number.parseInt(portRaw, 10);
  if (!/^\d+$/.test(portRaw) || !Number.isFinite(port) || port < 1 || port > 65535) {
    return fail(`invalid --port value: ${portRaw}`);
  }

  let server: LiveServerHandle;
  try {
    server = buildLiveServer(vault, port);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/EADDRINUSE|address already in use/i.test(msg)) {
      return fail(`port ${port} already in use; try --port <other>`);
    }
    return fail(`failed to start explorer: ${msg}`);
  }

  ok(`Live explorer at ${server.url}`);
  info("Press Ctrl+C to stop.");

  await new Promise<void>((resolveStop) => {
    const stop = (): void => {
      void server.close().then(() => resolveStop());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function cmdBrainSnapshotDiff(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  if (positional.length < 1 || positional.length > 2) {
    return fail(
      "brain snapshot diff requires <run_id_a> [<run_id_b>] (with one arg, the live tree is compared as B)",
    );
  }
  const [a, b] = positional;
  const snaps = listSnapshots(vault);
  if (!snaps.some((s) => s.run_id === a)) {
    process.stderr.write(
      `snapshot not found: ${a}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }
  if (b !== undefined && !snaps.some((s) => s.run_id === b)) {
    process.stderr.write(
      `snapshot not found: ${b}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }

  let extA: ExtractSnapshotResult | null = null;
  let extB: ExtractSnapshotResult | null = null;
  try {
    extA = extractSnapshotToTemp(vault, a!);
    const bRoot = b !== undefined
      ? (extB = extractSnapshotToTemp(vault, b)).brainRoot
      : brainDirs(vault).brain;
    const diff = diffBrainTrees(extA.brainRoot, bRoot);
    const out = flags["json"]
      ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
      : renderDiffMarkdown(diff, { aLabel: a!, bLabel: b ?? "live" });
    process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
    return 0;
  } catch (exc) {
    return fail(`snapshot diff failed: ${(exc as Error).message ?? exc}`);
  } finally {
    extA?.cleanup();
    extB?.cleanup();
  }
}

async function handleBrainSnapshotSubcommand(
  argv: ReadonlyArray<string>,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      "usage: o2b brain snapshot <verb> [args...]\n" +
        "Verbs:\n" +
        "  diff <run_id_a> [<run_id_b>]   Read-only diff between two snapshots,\n" +
        "                                  or between a snapshot and live Brain/.\n",
    );
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0]!;
  const rest = argv.slice(1);
  switch (sub) {
    case "diff":
      return await cmdBrainSnapshotDiff([...rest]);
    default:
      process.stderr.write(
        `unknown brain snapshot verb: ${sub}; supported: diff\n`,
      );
      return 2;
  }
}

async function cmdBrainSetPrimary(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    clear: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let name: string | null;
  if (flags["clear"]) {
    if (positional.length > 0) {
      return fail("brain set-primary --clear takes no positional argument");
    }
    name = null;
  } else {
    if (positional.length < 1) {
      return fail(
        "brain set-primary requires <name> or --clear; see `o2b brain help set-primary`",
      );
    }
    if (positional.length > 1) {
      return fail("brain set-primary accepts a single <name> argument");
    }
    const supplied = positional[0]!.trim();
    if (supplied.length === 0) {
      return fail("brain set-primary <name> must be non-empty");
    }
    name = supplied;
  }

  let result;
  try {
    result = setPrimaryAgent(vault, name);
  } catch (exc) {
    return fail(`set-primary failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({
      previous: result.previous,
      next: result.next,
      changed: result.changed,
    });
    return 0;
  }

  const fmt = (v: string | null): string => v ?? "null";
  if (!result.changed) {
    ok(`primary_agent already set to ${fmt(result.next)}`);
  } else {
    ok(`primary_agent: ${fmt(result.previous)} → ${fmt(result.next)}`);
  }
  return 0;
}

async function cmdBrainProtect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain protect --target='${flags["target"]}' is unknown; `
        + `supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );

  try {
    if (flags["apply"]) {
      const result = applyProtect({ target, vault });
      if (flags["json"]) {
        okJson({
          target: result.target,
          destination: result.destination,
          changed: result.changed,
          backup: result.backupPath || null,
        });
        return 0;
      }
      const head = result.changed
        ? `brain protect: applied to ${result.destination}`
        : `brain protect: no changes (${result.destination} already current)`;
      ok(head);
      if (result.backupPath) ok(`  backup: ${result.backupPath}`);
      return 0;
    }
    // --print (default): emit the snippet body, no writes.
    const snippet = printSnippet({ target, vault });
    if (flags["json"]) {
      okJson({
        target: snippet.target,
        destination: snippet.destination,
        body: snippet.body,
      });
      return 0;
    }
    info(`# o2b brain protect --target ${target}`);
    info(`# destination: ${snippet.destination}`);
    info(`# preview only; re-run with --apply to write the file`);
    process.stdout.write(snippet.body);
    return 0;
  } catch (exc) {
    if (exc instanceof BrainProtectError) {
      return fail(`brain protect failed: ${exc.message}`);
    }
    throw exc;
  }
}

async function cmdBrainUnprotect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain unprotect --target='${flags["target"]}' is unknown; `
        + `supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );

  try {
    unprotect({ target, vault });
  } catch (exc) {
    if (exc instanceof BrainProtectError) {
      return fail(`brain unprotect failed: ${exc.message}`);
    }
    throw exc;
  }
  if (flags["json"]) {
    okJson({ target, vault });
  } else {
    ok(`brain unprotect: removed OSB-managed rules for target=${target}`);
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
    "dry-run": { type: "boolean" },
    "force-rollback": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const forceRollback = Boolean(flags["force-rollback"]);

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

  // Drift detection (§5-tail). When a sidecar manifest accompanies
  // the snapshot we compare it against a freshly-built manifest of
  // the live Brain/ tree. If they differ and the operator did not
  // pass --force-rollback, we abort with exit 2 so a Syncthing-
  // delivered edit on another device is not silently clobbered. For
  // legacy snapshots (no sidecar — produced before v0.10.6) we emit
  // a stderr warning and fall through to the pre-v0.10.6 path.
  // Skip the full sha-256 walk for `--dry-run` — that path already
  // shows the operator everything via `diffBrainTrees` and never
  // writes, so drift detection adds no signal.
  const driftDiff = flags["dry-run"]
    ? null
    : (() => {
        const stored = readManifestSidecar(vault, runId);
        if (stored === null) {
          process.stderr.write(
            `warning: no manifest sidecar for snapshot '${runId}'; ` +
              `drift detection skipped (snapshot predates v0.10.6).\n`,
          );
          return null;
        }
        const live = buildManifest(brainDirs(vault).brain);
        return diffManifests(stored, live);
      })();
  const drift = driftDiff !== null && manifestDiffHasDrift(driftDiff);
  if (drift && !forceRollback) {
    // Abort path. --json emits the structured drift payload; the
    // human path emits the markdown rendering. Either way the exit
    // code is 2 and Brain/ stays untouched.
    if (flags["json"]) {
      process.stdout.write(
        JSON.stringify(renderManifestDriftJson(driftDiff!, runId), null, 2) +
          "\n",
      );
      return 2;
    }
    process.stderr.write(renderManifestDriftMarkdown(driftDiff!, runId) + "\n");
    return 2;
  }

  // --dry-run prints the would-be restore plan without modifying
  // Brain/. Mutually exclusive with --yes — combining "preview" and
  // "execute non-interactively" is contradictory and would silently
  // hide one of the two intents.
  if (flags["dry-run"]) {
    if (flags["yes"]) {
      return fail("rollback: --dry-run and --yes are mutually exclusive");
    }
    let ext;
    try {
      ext = extractSnapshotToTemp(vault, runId);
    } catch (exc) {
      return fail(`rollback dry-run failed: ${(exc as Error).message ?? exc}`);
    }
    try {
      const liveBrain = brainDirs(vault).brain;
      const diff = diffBrainTrees(liveBrain, ext.brainRoot);
      const out = flags["json"]
        ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
        : renderDiffMarkdown(diff, { aLabel: "live", bLabel: runId });
      process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
      return 0;
    } finally {
      ext.cleanup();
    }
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
    const body: Record<string, string> = {
      run_id: runId,
      restored_files: String(result.restored_files),
    };
    // Record `drift_overridden` only when --force-rollback actually
    // bypassed a real drift — the absence of the key keeps the
    // common-case shape minimal.
    if (drift && forceRollback) {
      body["drift_overridden"] = "true";
    }
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.rollback,
      body,
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

async function cmdBrainBacklinks(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const id = positional[0];
  if (!id) {
    return fail("brain backlinks requires a target id (e.g. pref-foo, ret-bar, sig-...)");
  }
  // Run the input through the same normaliser the index uses so a
  // wikilink-shaped argument (`[[pref-foo]]`, `pref-foo.md`) resolves.
  const target = normaliseWikilinkTarget(id);
  const index = buildBacklinkIndex(vault);
  const refs = index.get(target) ?? [];

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ id: target, count: refs.length, refs }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(`Backlinks to ${target}: ${refs.length}\n`);
  if (refs.length === 0) return 0;
  for (const r of refs) {
    const ts = r.timestamp ? ` @ ${r.timestamp}` : "";
    process.stdout.write(
      `  ${r.source} (${r.sourceKind}, field: ${r.field})${ts}\n`,
    );
  }
  return 0;
}

async function cmdBrainImportSession(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    since: { type: "string" },
    "dry-run": { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) {
    return fail("brain import-session requires a <path> argument");
  }
  const sessionPath = positional[0]!;
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  // --format validation: only adapter ids registered in the registry.
  const formatRaw = flags["format"] as string | undefined;
  let format: "claude" | "codex" | "hermes" | undefined;
  if (formatRaw !== undefined && formatRaw !== "auto") {
    if (formatRaw !== "claude" && formatRaw !== "codex" && formatRaw !== "hermes") {
      return fail(
        `--format must be one of auto|claude|codex|hermes; got ${formatRaw}`,
      );
    }
    format = formatRaw;
  }

  // Parse --since. Strict ISO-8601 first — `new Date(raw)` alone is
  // too permissive (year-only strings, locale-specific shapes). Same
  // contract as cmdBrainDigest / cmdBrainQuery / cmdBrainDream.
  let since: Date | undefined;
  if (flags["since"]) {
    const raw = String(flags["since"]);
    if (!ISO_8601_RE.test(raw)) {
      return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) {
      return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    }
    since = d;
  }

  // Decide single-file vs directory based on stat.
  let stat;
  try {
    stat = statSync(sessionPath);
  } catch (err) {
    return fail(`cannot stat ${sessionPath}: ${(err as Error).message ?? err}`);
  }

  try {
    const result = stat.isDirectory()
      ? await importSessionPath(vault, sessionPath, {
          agent,
          ...(format ? { format } : {}),
          ...(since ? { since } : {}),
          dryRun: Boolean(flags["dry-run"]),
        })
      : {
          files: [
            await importSession(vault, sessionPath, {
              agent,
              ...(format ? { format } : {}),
              ...(since ? { since } : {}),
              dryRun: Boolean(flags["dry-run"]),
            }),
          ],
          warnings: [],
        };

    // Log one event per file processed (skip dry-run).
    if (!flags["dry-run"]) {
      for (const f of result.files) {
        try {
          appendLogEvent(vault, {
            timestamp: isoSecond(new Date()),
            eventType: BRAIN_LOG_EVENT_KIND.importSession,
            body: {
              agent,
              file: `[[${f.file}]]`,
              format: f.format,
              turns_scanned: String(f.turns_scanned),
              signals_created: String(f.signals_created),
              signals_deduped: String(f.signals_deduped),
              tool_replays: String(f.tool_replays),
              malformed: String(f.malformed),
            },
          });
        } catch (err) {
          process.stderr.write(
            `warning: append import-session log failed: ${(err as Error).message}\n`,
          );
        }
      }
    }

    if (flags["json"]) {
      okJson({
        files: result.files.map((f) => ({
          file: f.file,
          format: f.format,
          turns_scanned: f.turns_scanned,
          signals_created: f.signals_created,
          signals_deduped: f.signals_deduped,
          tool_replays: f.tool_replays,
          malformed: f.malformed,
          errors: f.errors,
        })),
        warnings: result.warnings,
      });
    } else {
      for (const f of result.files) {
        ok(`file: ${f.file}`);
        ok(`  format: ${f.format}`);
        ok(`  turns_scanned: ${f.turns_scanned}`);
        ok(`  signals_created: ${f.signals_created}`);
        ok(`  signals_deduped: ${f.signals_deduped}`);
        ok(`  tool_replays: ${f.tool_replays}`);
        if (f.malformed > 0) ok(`  malformed: ${f.malformed}`);
        for (const e of f.errors) {
          info(`  error: ${e.path}: ${e.message}`);
        }
      }
      for (const w of result.warnings) {
        info(`  warning: ${w.path}: ${w.message}`);
      }
    }
    return 0;
  } catch (exc) {
    if (exc instanceof SessionImportError) {
      process.stderr.write(`error: ${exc.message}\n`);
      // DETECT_FAIL / UNKNOWN_FORMAT → exit 2 (operator picks --format).
      if (exc.code === "DETECT_FAIL" || exc.code === "UNKNOWN_FORMAT") return 2;
      return 1;
    }
    return fail(`import-session failed: ${(exc as Error).message ?? exc}`);
  }
}

async function cmdBrainImportClaudeMemory(argv: string[]): Promise<number> {
  const config = defaultConfigPath();

  let memory: string | null = null;
  let mode: "dry-run" | "apply" = "dry-run";
  let modeSet = false;
  let allowArbitrary = false;
  let yes = false;
  let asJson = false;
  let vaultFlag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") { vaultFlag = argv[++i]; continue; }
    if (a === "--memory") { memory = argv[++i] ?? null; continue; }
    if (a === "--dry-run") {
      if (modeSet && mode !== "dry-run") {
        process.stderr.write(
          "o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n",
        );
        return 2;
      }
      mode = "dry-run"; modeSet = true; continue;
    }
    if (a === "--apply") {
      if (modeSet && mode !== "apply") {
        process.stderr.write(
          "o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n",
        );
        return 2;
      }
      mode = "apply"; modeSet = true; continue;
    }
    if (a === "--yes") { yes = true; continue; }
    if (a === "--json") { asJson = true; continue; }
    if (a === "--allow-arbitrary-memory-path") { allowArbitrary = true; continue; }
  }

  if (mode === "apply" && !yes && !process.stdin.isTTY) {
    process.stderr.write(
      "o2b brain import-claude-memory: --apply requires --yes in non-interactive mode\n",
    );
    return 2;
  }

  const vault = resolveBrainVault(vaultFlag, config);
  const memDir = memory ?? defaultMemoryDir(vault);

  try {
    const res = importClaudeMemory({
      vault,
      memoryDir: memDir,
      mode,
      allowArbitraryMemoryPath: allowArbitrary,
    });
    if (asJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return 0;
    }
    if (mode === "dry-run") {
      process.stdout.write(
        `plan: ${res.plans.length} actionable, ${res.skipped.length} skipped\n`,
      );
      for (const p of res.plans) {
        process.stdout.write(`  ${p.action} ${p.prefId} (${p.basename})\n`);
      }
      for (const s of res.skipped) {
        process.stdout.write(`  SKIP  ${s.basename}: ${s.reason}\n`);
      }
      if (res.conflicts.length > 0) {
        process.stdout.write(`conflicts: ${res.conflicts.length}\n`);
      }
    } else {
      process.stdout.write(
        `applied: ${res.applied.length}; unchanged: ${res.skippedUnchanged.length}; skipped: ${res.skipped.length}\n`,
      );
      if (res.snapshotRunId) {
        process.stdout.write(`snapshot: ${res.snapshotRunId}\n`);
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof ConflictsError) {
      process.stderr.write("conflicts:\n");
      for (const c of err.conflicts) {
        process.stderr.write(
          `  ${c.prefId} already exists in Brain but is not in Brain/.imports/claude-memory.json\n`,
        );
      }
      return 2;
    }
    process.stderr.write(
      `o2b brain import-claude-memory: ${(err as Error).message}\n`,
    );
    return 1;
  }
}

async function cmdBrainScanInline(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    strict: { type: "boolean" },
    path: { type: "string-array" },
    exclude: { type: "string-array" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  let result;
  try {
    result = await scanInline(vault, {
      agent,
      dryRun: Boolean(flags["dry-run"]),
      paths: (flags["path"] as string[] | undefined) ?? [],
      exclude: (flags["exclude"] as string[] | undefined) ?? [],
    });
  } catch (exc) {
    return fail(`scan-inline failed: ${(exc as Error).message ?? exc}`);
  }

  // Log event (skip on --dry-run so audit trail only reflects actual writes).
  if (!flags["dry-run"]) {
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.scanInline,
        body: {
          agent,
          scanned: String(result.scanned),
          found: String(result.found),
          created: String(result.created),
          deduped: String(result.deduped),
          malformed: String(result.malformed),
          errors: String(result.errors.length),
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append scan-inline log failed: ${(err as Error).message}\n`,
      );
    }
  }

  if (flags["json"]) {
    okJson({
      scanned: result.scanned,
      found: result.found,
      created: result.created,
      deduped: result.deduped,
      malformed: result.malformed,
      errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
      files_with_markers: result.filesWithMarkers.map((f) => ({
        path: f.path,
        markers: f.markers,
      })),
    });
  } else {
    ok(`scanned: ${result.scanned}`);
    ok(`found: ${result.found}`);
    ok(`created: ${result.created}`);
    ok(`deduped: ${result.deduped}`);
    if (result.malformed > 0) ok(`malformed: ${result.malformed}`);
    for (const e of result.errors) {
      info(`  error: ${e.path}: ${e.message}`);
    }
  }
  if (flags["strict"] && result.malformed > 0) return 2;
  return 0;
}

async function cmdBrainMigrateFrontmatter(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = resolveAgentName(config);

  // Mutually exclusive: --dry-run and --apply both set is operator
  // confusion; default is dry-run.
  if (flags["dry-run"] && flags["apply"]) {
    return fail(
      "brain migrate-frontmatter: --dry-run and --apply are mutually exclusive",
    );
  }
  const apply = Boolean(flags["apply"]);

  // Non-interactive guard mirrors `o2b brain rollback`: --json output
  // or non-TTY stdin must pass --yes, otherwise a missed prompt would
  // hang or silently misbehave.
  if (apply && !flags["yes"]) {
    if (flags["json"] || !process.stdin.isTTY) {
      return fail(
        "brain migrate-frontmatter --apply requires --yes in non-interactive mode (--json or non-TTY stdin)",
      );
    }
  }

  if (!apply) {
    // Dry-run path.
    let plan;
    try {
      plan = planMigration(vault);
    } catch (exc) {
      return fail(
        `migrate-frontmatter plan failed: ${(exc as Error).message ?? exc}`,
      );
    }
    if (flags["json"]) {
      okJson({
        files_scanned: plan.files_scanned,
        files_to_migrate: plan.files_to_migrate.length,
        files_already_new: plan.files_already_new.length,
        collisions: plan.collisions.length,
        collision_files: plan.collisions.map((c) => ({
          path: c.path,
          field: c.field,
        })),
      });
      return 0;
    }
    ok(`files_scanned: ${plan.files_scanned}`);
    ok(`files_to_migrate: ${plan.files_to_migrate.length}`);
    ok(`files_already_new: ${plan.files_already_new.length}`);
    ok(`collisions: ${plan.collisions.length}`);
    if (plan.collisions.length > 0) {
      info("Collisions (both legacy and '_'-prefixed shape present):");
      for (const c of plan.collisions) {
        info(`  - ${c.path} (field: ${c.field})`);
      }
    }
    if (plan.files_to_migrate.length === 0) {
      ok("nothing to migrate; re-run with --apply --yes when there is.");
    } else {
      ok("re-run with --apply --yes to rewrite these files.");
    }
    return 0;
  }

  // Apply path.
  let result;
  try {
    result = await applyMigration(vault, { snapshot: true, now: new Date() });
  } catch (exc) {
    if (exc instanceof MigrationError) {
      // Surface the collision / parse / io error with the structured
      // message exactly as the core returns it.
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    return fail(`migrate-frontmatter failed: ${(exc as Error).message ?? exc}`);
  }

  // Emit a log event so the audit trail records the rewrite.
  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.migrateFrontmatter,
      body: {
        run_id: result.run_id,
        agent,
        snapshot: result.snapshot_path ?? "(none)",
        files_scanned: String(result.plan.files_scanned),
        files_migrated: String(result.files_migrated.length),
        files_already_new: String(result.plan.files_already_new.length),
        collisions: String(result.plan.collisions.length),
      },
    });
  } catch (err) {
    process.stderr.write(
      `warning: append migrate-frontmatter log failed: ${(err as Error).message}\n`,
    );
  }

  if (flags["json"]) {
    okJson({
      run_id: result.run_id,
      snapshot_path: result.snapshot_path,
      files_scanned: result.plan.files_scanned,
      files_migrated: result.files_migrated.length,
      files_already_new: result.plan.files_already_new.length,
      collisions: result.plan.collisions.length,
    });
    return 0;
  }
  ok(`run_id: ${result.run_id}`);
  ok(`snapshot: ${result.snapshot_path ?? "(none)"}`);
  ok(`files_migrated: ${result.files_migrated.length}`);
  ok(`files_already_new: ${result.plan.files_already_new.length}`);
  return 0;
}

/**
 * `o2b brain upgrade` — migrate release-owned files (`_brain.yaml`,
 * `_BRAIN.md`, `_OPEN_SECOND_BRAIN.md`) forward when a new
 * open-second-brain version ships. Default is `--dry-run`; `--apply`
 * (with `--yes` in non-interactive mode) rewrites the files after a
 * pre-apply snapshot.
 */
async function cmdBrainUpgrade(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  // Flag matrix. `--dry-run` + `--apply` is contradictory. `--check`
  // is a CI shorthand for "dry-run with non-zero exit on pending";
  // combining it with `--apply` is also contradictory.
  if (flags["dry-run"] && flags["apply"]) {
    return fail("brain upgrade: --dry-run and --apply are mutually exclusive");
  }
  if (flags["check"] && flags["apply"]) {
    return fail("brain upgrade: --check and --apply are mutually exclusive");
  }

  let plan: UpgradePlan;
  try {
    plan = planUpgrade(vault);
  } catch (exc) {
    return fail(`upgrade plan failed: ${(exc as Error).message ?? exc}`);
  }

  // `--check` is the CI gate: print a one-line summary and exit 2
  // when there is anything to do. Stays read-only.
  if (flags["check"]) {
    if (flags["json"]) {
      okJson(renderUpgradePlanJson(plan));
    } else {
      printUpgradePlanText(plan);
    }
    return plan.pending > 0 || plan.errors > 0 ? 2 : 0;
  }

  // Default and `--dry-run` share the same output. Exit 0 either
  // way — `--check` is the gate variant.
  if (!flags["apply"]) {
    if (flags["json"]) {
      okJson(renderUpgradePlanJson(plan));
    } else {
      printUpgradePlanText(plan);
    }
    return 0;
  }

  // Apply path.
  if (plan.errors > 0) {
    return fail(
      `upgrade aborted: ${plan.errors} file(s) failed to plan; ` +
        `run with --dry-run to inspect the error.`,
    );
  }
  if (plan.pending === 0) {
    if (flags["json"]) {
      okJson({ run_id: "", snapshot_path: "", files_updated: [] });
    } else {
      ok("upgrade: nothing to do; all managed files match the current release.");
    }
    return 0;
  }
  if (!flags["yes"]) {
    if (flags["json"] || !process.stdin.isTTY) {
      return fail(
        "brain upgrade --apply requires --yes in non-interactive mode " +
          "(--json or non-TTY stdin)",
      );
    }
    process.stderr.write(
      `About to rewrite ${plan.pending} managed file(s):\n` +
        plan.files
          .filter((f) => f.status === "update")
          .map((f) => `  - ${f.path}\n`)
          .join("") +
        `A pre-apply snapshot will be taken (rollback via run id).\n` +
        `Proceed? [y/N] `,
    );
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      ok("upgrade cancelled");
      return 0;
    }
  }

  let result;
  try {
    result = applyUpgrade(vault, { now: new Date() });
  } catch (exc) {
    if (exc instanceof BrainUpgradeError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    return fail(`upgrade failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({
      run_id: result.run_id,
      snapshot_path: result.snapshot_path,
      files_updated: result.files_updated,
    });
  } else {
    ok(`run_id: ${result.run_id}`);
    ok(`snapshot: ${result.snapshot_path}`);
    for (const p of result.files_updated) ok(`  updated: ${p}`);
  }
  return 0;
}

function renderUpgradePlanJson(plan: UpgradePlan): {
  pending: number;
  errors: number;
  files: ReadonlyArray<{
    path: string;
    status: UpgradeFilePlan["status"];
    before_size: number;
    after_size: number;
    error?: string;
  }>;
} {
  return {
    pending: plan.pending,
    errors: plan.errors,
    files: plan.files.map((f) => ({
      path: f.path,
      status: f.status,
      before_size: f.before.length,
      after_size: f.after.length,
      ...(f.error ? { error: f.error } : {}),
    })),
  };
}

function printUpgradePlanText(plan: UpgradePlan): void {
  for (const f of plan.files) {
    if (f.status === "noop") {
      ok(`  ${f.path}: up to date`);
      continue;
    }
    if (f.status === "error") {
      info(`  ${f.path}: ERROR ${f.error}`);
      continue;
    }
    info(`  ${f.path}: update (${f.before.length} → ${f.after.length} bytes)`);
    info(renderUnifiedDiff(f.before, f.after, f.path));
  }
  if (plan.pending === 0 && plan.errors === 0) {
    ok("upgrade: all managed files match the current release.");
  } else if (plan.pending > 0) {
    ok(
      `upgrade: ${plan.pending} pending update(s); ` +
        `re-run with --apply --yes when ready.`,
    );
  }
}

/**
 * Bare-bones unified diff renderer. Good enough for human-eye review
 * inside the CLI. We intentionally avoid pulling a dependency for a
 * cosmetic feature; the algorithm is line-by-line with a small
 * sliding window so identical leading / trailing lines collapse
 * naturally.
 */
function renderUnifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- ${label} (live)`, `+++ ${label} (release)`];
  // Skip the matching prefix to keep the diff tight.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (
    tailA > head &&
    tailB > head &&
    a[tailA - 1] === b[tailB - 1]
  ) {
    tailA--;
    tailB--;
  }
  if (head > 0) {
    lines.push(`@@ context: ${head} matching line(s) above @@`);
  }
  for (let i = head; i < tailA; i++) lines.push(`- ${a[i]}`);
  for (let i = head; i < tailB; i++) lines.push(`+ ${b[i]}`);
  if (tailA < a.length || tailB < b.length) {
    const tailCount = Math.max(a.length - tailA, b.length - tailB);
    lines.push(`@@ context: ${tailCount} matching line(s) below @@`);
  }
  return lines.join("\n");
}

/**
 * `o2b brain export` (§28) — read-only dump of active preferences in
 * either JSON or llms-txt format. Default sink is stdout; `--out`
 * writes to a file (refusing to overwrite without `--force`).
 */
async function cmdBrainExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const format = flags["format"] as string | undefined;
  if (format !== "json" && format !== "llms-txt") {
    process.stderr.write(
      "error: --format is required and must be one of json|llms-txt\n",
    );
    return 2;
  }

  let body: string;
  try {
    if (format === "json") {
      body = JSON.stringify(exportPreferencesJson(vault)) + "\n";
    } else {
      body = exportPreferencesLlmsTxt(vault);
    }
  } catch (exc) {
    return fail(`export failed: ${(exc as Error).message ?? exc}`);
  }

  const outPath = flags["out"] as string | undefined;
  if (outPath === undefined) {
    process.stdout.write(body);
    return 0;
  }
  if (existsSync(outPath) && !flags["force"]) {
    return fail(`${outPath} exists; pass --force to overwrite`);
  }
  try {
    atomicWriteFileSync(outPath, body);
  } catch (exc) {
    return fail(
      `failed to write ${outPath}: ${(exc as Error).message ?? exc}`,
    );
  }
  ok(`wrote ${outPath}`);
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
  set-primary      Declare or clear primary_agent in _brain.yaml (--clear)
  protect          Emit / apply native deny rules for Brain/ (--target {claudecode|codex} [--apply])
  unprotect        Remove OSB-managed deny rules for the chosen target (--target)
  merge            Merge two near-duplicate preferences (<keep> <drop>; --dry-run, --force)
  upgrade          Migrate release-owned files forward (--dry-run by default; --apply --yes)
  export           Dump active preferences (--format json|llms-txt [--out <path>])
  explorer         Launch the loopback HTML explorer; --export <path> writes a single offline file
  snapshot diff    Read-only diff between two snapshots, or snapshot vs live
  rollback         Restore Brain/ from a snapshot (--list or <run_id>; --yes;
                   --dry-run previews via the same diff renderer)
  doctor              Validate Brain invariants (--strict promotes warnings to exit 2)
  backlinks           List inbound references to a Brain artifact id
  migrate-frontmatter Rewrite legacy 'status:' / 'applied_count:' keys to '_status:' / '_applied_count:'
  scan-inline         Capture @osb markers from vault markdown files (Daily/, project notes, etc.)
  import-session      Replay signals from a Claude/Codex/Hermes session .jsonl (or directory)
  import-claude-memory  Import metadata.type:feedback MEMORY entries as confirmed preferences

Common flags:
  --vault <path>   Override the configured vault
  --json           Structured output where applicable
  --help           Per-verb help (run \`o2b brain <verb> --help\`)
`;

const VERB_HELP: Record<string, string> = {
  init:
    "usage: o2b brain init [--vault <path>] [--force] [--primary-agent <name>] [--json]\n" +
    "Bootstrap <vault>/Brain/. Requires `o2b init` to have run first.\n" +
    "--primary-agent <name> writes the value into _brain.yaml on first init;\n" +
    "on re-run against an existing _brain.yaml use `o2b brain set-primary` instead.\n",
  feedback:
    "usage: o2b brain feedback --topic <slug> --signal positive|negative --principle <text>\n" +
    "  [--scope <slug>] [--source <wikilink>...] [--agent <name>] [--raw <text>|--raw-file <path>]\n" +
    "  [--force-confirmed] [--vault <path>] [--json]\n" +
    "Creates a `sig-*.md` in Brain/inbox/. With --force-confirmed also creates a `pref-*.md`.\n",
  dream:
    "usage: o2b brain dream [--vault <path>] [--dry-run] [--now <ISO-8601>] [--json]\n" +
    "Runs the deterministic dreaming algorithm. Idempotent on rerun.\n",
  "apply-evidence":
    "usage: o2b brain apply-evidence --pref <id> --artifact <wikilink> --result applied|violated|outdated\n" +
    "  [--agent <name>] [--note <text>] [--vault <path>] [--json]\n" +
    "Appends a single event to today's log. Missing preference exits 2.\n",
  digest:
    "usage: o2b brain digest [--vault <path>] [--since <ISO>] [--until <ISO>] [--json] [--silent-if-empty]\n" +
    "Renders the 24-hour change digest. Empty + --silent-if-empty exits 2.\n",
  query:
    "usage: o2b brain query --preference <id> | --topic <slug> | --since <ISO> [--vault <path>] [--json]\n" +
    "Read-only lookup. One of --preference / --topic / --since is required.\n",
  reject:
    "usage: o2b brain reject --id <pref-id> --reason <text> [--yes] [--vault <path>] [--json]\n" +
    "Move a preference to retired/ with reason 'user-rejected'. --yes required when pinned.\n",
  pin:
    "usage: o2b brain pin --id <pref-id> [--vault <path>] [--json]\n" +
    "Set pinned: true. Idempotent. Exempts the preference from automatic retire.\n",
  unpin:
    "usage: o2b brain unpin --id <pref-id> [--vault <path>] [--json]\n" +
    "Clear pinned: true. Idempotent.\n",
  rollback:
    "usage: o2b brain rollback <run_id> [--vault <path>] [--yes]\n" +
    "                          [--force-rollback] [--json]\n" +
    "       o2b brain rollback <run_id> --dry-run [--vault <path>] [--json]\n" +
    "       o2b brain rollback --list [--vault <path>] [--json]\n" +
    "Restore Brain/ from a snapshot. Interactive prompt unless --yes.\n" +
    "--dry-run prints the would-be restore plan as live → snapshot\n" +
    "diff and exits 0 without writing.\n" +
    "From v0.10.6 each snapshot carries a sidecar sha256 manifest of\n" +
    "the Brain/ tree captured at snapshot time. rollback compares it\n" +
    "against the current Brain/ and aborts with exit 2 if they\n" +
    "differ — typically because another device (Syncthing) edited the\n" +
    "vault between snapshot and rollback. Pass --force-rollback to\n" +
    "overwrite anyway; the log entry records `drift_overridden: true`.\n" +
    "Snapshots produced before v0.10.6 have no sidecar; rollback emits\n" +
    "a stderr warning and falls through to the legacy direct-restore\n" +
    "path.\n",
  snapshot:
    "usage: o2b brain snapshot diff <run_id_a> [<run_id_b>]\n" +
    "                              [--vault <path>] [--json]\n" +
    "Read-only diff between two snapshots, or between a snapshot and\n" +
    "the live Brain/ tree (when <run_id_b> is omitted).\n",
  doctor:
    "usage: o2b brain doctor [--vault <path>] [--json] [--strict]\n" +
    "Validate invariants. Warnings exit 0 (or 2 with --strict). Errors always exit 1.\n",
  backlinks:
    "usage: o2b brain backlinks <id> [--vault <path>] [--json]\n" +
    "List inbound references to the given Brain artifact id (preference, retired, signal).\n",
  "migrate-frontmatter":
    "usage: o2b brain migrate-frontmatter [--vault <path>] [--apply] [--yes] [--json]\n" +
    "Rewrite legacy Group C frontmatter keys ('status:', 'applied_count:', ...)\n" +
    "to the '_'-prefixed shape across Brain/preferences/ and Brain/retired/.\n" +
    "Default is --dry-run; --apply takes a pre-run snapshot (rollback via run_id).\n" +
    "--apply requires --yes in non-interactive mode (--json or non-TTY stdin).\n",
  "set-primary":
    "usage: o2b brain set-primary <name> [--vault <path>] [--json]\n" +
    "       o2b brain set-primary --clear [--vault <path>] [--json]\n" +
    "Declare which agent owns the dream consolidation pass for this vault.\n" +
    "Stored in Brain/_brain.yaml as `primary_agent:`. Dream runs from a\n" +
    "different agent emit a warning but still proceed (observability, not\n" +
    "access control). Use --clear to remove the declaration.\n",
  "scan-inline":
    "usage: o2b brain scan-inline [--vault <path>] [--path <subdir>...] [--exclude <subdir>...]\n" +
    "                              [--dry-run] [--strict] [--json] [--agent <name>]\n" +
    "Walk the vault for @osb markers (inline form and fenced 'osb' blocks),\n" +
    "create signals in Brain/inbox/, and annotate the source files with\n" +
    "@osb✓ [[sig-...]]. Brain/, .git, node_modules, and similar directories\n" +
    "are always skipped. Idempotent on re-run.\n",
  "import-claude-memory":
    "usage: o2b brain import-claude-memory [--vault <path>] [--memory <path>]\n" +
    "                                       [--dry-run | --apply] [--yes] [--json]\n" +
    "                                       [--allow-arbitrary-memory-path]\n" +
    "Read metadata.type:feedback entries from a Claude Code memory directory and\n" +
    "write them as confirmed Brain preferences. A sidecar manifest\n" +
    "Brain/.imports/claude-memory.json tracks idempotency. UPDATE preserves\n" +
    "accumulated evidence fields. CONFLICT (preference exists without a manifest\n" +
    "entry) exits 2 — never silent overwrites.\n" +
    "Default is --dry-run; --apply requires --yes in non-interactive mode.\n",
  "import-session":
    "usage: o2b brain import-session <path> [--vault <vault>]\n" +
    "                                [--format auto|claude|codex|hermes]\n" +
    "                                [--since <ISO>] [--dry-run] [--json]\n" +
    "Extract signals from a Claude / Codex / Hermes session .jsonl file (or\n" +
    "directory of .jsonl files). Two extraction paths run in parallel:\n" +
    "@osb markers in user/assistant messages, and replay of brain_feedback\n" +
    "tool_use calls. Dedup against the inbox by normalised payload hash.\n" +
    "Autodetect failure exits 2 — pass --format to override.\n",
  merge:
    "usage: o2b brain merge <keep-pref-id> <drop-pref-id>\n" +
    "                       [--dry-run] [--force] [--vault <path>] [--json]\n" +
    "                       [--agent <name>]\n" +
    "Merge two near-duplicate preferences. <keep> retains identity and\n" +
    "principle; <drop> retires with reason 'merged-into' and a\n" +
    "superseded_by wikilink to <keep>. <keep> picks up the sorted-dedup\n" +
    "union of evidenced_by, the summed applied_count / violated_count,\n" +
    "and max(last_evidence_at). Confidence is recomputed by the next\n" +
    "dream pass — not by merge itself.\n" +
    "--dry-run prints the plan and writes nothing.\n" +
    "--force skips the interactive prompt but does NOT bypass invariant\n" +
    "guards (topic/scope mismatch, pin parity).\n",
  export:
    "usage: o2b brain export --format json|llms-txt [--vault <path>]\n" +
    "                         [--out <path>] [--force]\n" +
    "Read-only dump of active preferences (confirmed | unconfirmed |\n" +
    "quarantine) from Brain/preferences/. Retired and signal entries\n" +
    "are not included. JSON is single-line; llms-txt follows the\n" +
    "llmstxt.org H1 + summary + H2-section shape.\n" +
    "Default sink is stdout; --out writes to <path> (refuses to\n" +
    "overwrite without --force).\n",
  upgrade:
    "usage: o2b brain upgrade [--vault <path>] [--dry-run | --apply | --check]\n" +
    "                          [--yes] [--json]\n" +
    "Migrate the three release-owned files (`Brain/_brain.yaml`,\n" +
    "`Brain/_BRAIN.md`, `AI Wiki/_OPEN_SECOND_BRAIN.md`) forward to the\n" +
    "shape the installed open-second-brain release ships.\n" +
    "User-owned content (preferences/, retired/, inbox/, log/) is\n" +
    "never touched.\n" +
    "--dry-run (default) prints a per-file plan with a unified diff\n" +
    "for every pending update. Exit 0 regardless of pending count.\n" +
    "--check is dry-run + exit 2 when anything is pending or in error\n" +
    "(CI-friendly).\n" +
    "--apply takes a pre-apply snapshot named upgrade-<ts> (rollback\n" +
    "via run_id) and rewrites every pending file. Requires --yes in\n" +
    "non-interactive mode (--json or non-TTY stdin).\n" +
    "_brain.yaml merge is purely additive: missing schema-keys are\n" +
    "appended, existing values stay. _BRAIN.md and\n" +
    "_OPEN_SECOND_BRAIN.md are byte-compared against the rendered\n" +
    "template and overwritten when they differ.\n",
  explorer:
    "usage: o2b brain explorer [--port <n>] [--vault <path>]\n" +
    "       o2b brain explorer --export <path> [--force] [--vault <path>]\n" +
    "Live mode: bind a loopback HTTP server on 127.0.0.1:<port> (default\n" +
    "7777) that renders preferences and retired entries as a force-directed\n" +
    "graph. Press Ctrl+C to stop.\n" +
    "Export mode: write the same view as a single offline HTML file at\n" +
    "<path>. Without --force, refuses to overwrite an existing file.\n" +
    "Zero backend, no LLM, no network access. The page consumes a\n" +
    "prebuilt JSON graph; it does not parse vault Markdown client-side.\n",
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
      case "set-primary":
        return await cmdBrainSetPrimary(rest);
      case "protect":
        return await cmdBrainProtect(rest);
      case "unprotect":
        return await cmdBrainUnprotect(rest);
      case "snapshot":
        return await handleBrainSnapshotSubcommand(rest);
      case "rollback":
        return await cmdBrainRollback(rest);
      case "doctor":
        return await cmdBrainDoctor(rest);
      case "backlinks":
        return await cmdBrainBacklinks(rest);
      case "migrate-frontmatter":
        return await cmdBrainMigrateFrontmatter(rest);
      case "scan-inline":
        return await cmdBrainScanInline(rest);
      case "import-session":
        return await cmdBrainImportSession(rest);
      case "import-claude-memory":
        return await cmdBrainImportClaudeMemory(rest);
      case "merge":
        return await cmdBrainMerge(rest);
      case "upgrade":
        return await cmdBrainUpgrade(rest);
      case "export":
        return await cmdBrainExport(rest);
      case "explorer":
        return await cmdBrainExplorer(rest);
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
