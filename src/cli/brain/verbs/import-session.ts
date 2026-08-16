/**
 * `o2b brain import-session`: one path, or the whole machine.
 *
 * The verb took a path and nothing else, which meant an operator had to
 * already know that Claude Code writes under `~/.claude/projects`, that
 * Codex has moved its rollouts between four subdirectories of
 * `$CODEX_HOME`, and that Grok encodes the working directory into a path
 * component - and then run this once per file. `--status` and
 * `--discover` are the machine-wide half, over the roots
 * `src/core/runtime/host-facts.ts` declares.
 *
 * The two modes never blend. A path names exactly one thing to import; a
 * sweep imports what the declared roots hold. Given both, the verb
 * refuses and names both rather than ranking them, because either
 * ranking is a guess about which one the operator meant.
 *
 * `--discover --all` is the only sweeping form that writes, and it writes
 * through the same `importSession` the path form calls - not a second
 * copy of it. That is what keeps the privacy posture identical rather
 * than merely similar: redaction, the tool-payload exclusion and the
 * dedup index are the ones that were already there.
 */

import { statSync } from "node:fs";
import { resolveAgentName, resolveSessionCaptureRoles } from "../../../core/config.ts";
import {
  importSession,
  importSessionPath,
  IMPORT_WRITE_MODE,
} from "../../../core/brain/sessions/import.ts";
import {
  discoverSessions,
  discoveryGap,
  recordSessionImports,
  runtimeForPath,
  type RuntimeCoverage,
  type SessionDiscovery,
  type SessionImportRecord,
} from "../../../core/brain/sessions/discover.ts";
import { SessionImportError, type SessionAdapterId } from "../../../core/brain/sessions/types.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
} from "../../../core/brain/safeguard.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import {
  isSessionAdapterId,
  sessionAdapterFormatChoices,
} from "../../../core/brain/sessions/registry.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import {
  CliError,
  brainVerbContext,
  fail,
  info,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  parseOptionalIsoDate,
} from "../helpers.ts";

export async function cmdBrainImportSession(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    since: { type: "string" },
    "dry-run": { type: "boolean" },
    agent: { type: "string" },
    recall: { type: "boolean" },
    "recall-session-id": { type: "string" },
    "recall-summary-group-size": { type: "string" },
    "ingest-scope": { type: "string" },
    "filter-role": { type: "string-array" },
    "filter-text": { type: "string" },
    "preserve-event-time": { type: "boolean" },
    discover: { type: "boolean" },
    status: { type: "boolean" },
    all: { type: "boolean" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const discover = flags["discover"] === true;
  const status = flags["status"] === true;
  const importAll = flags["all"] === true;
  const sessionPath = positional[0] ?? null;
  assertOneMode(sessionPath, discover, status, importAll);
  const { config, vault } = brainVerbContext(flags);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  if (flags["agent"] !== undefined && explicitAgent === null) {
    return fail("--agent must be a non-empty string when provided");
  }
  const agent = explicitAgent ?? resolveAgentName(config);
  const recallSessionId = normalizeFlagString(flags["recall-session-id"]);
  if (flags["recall-session-id"] !== undefined && recallSessionId === null) {
    return fail("--recall-session-id must be a non-empty string when provided");
  }
  const recallSummaryGroupSize = parsePositiveIntegerFlag(
    flags["recall-summary-group-size"],
    "--recall-summary-group-size",
  );
  const ingestScope = normalizeFlagString(flags["ingest-scope"] as string | undefined);
  const explicitRoles = normalizeRoleFilter(flags["filter-role"] as string[] | undefined);
  // Config-level default (t_e2346fe9): session_capture_roles applies
  // only when no explicit --filter-role flag is given; flag wins.
  let filterRoles = explicitRoles;
  if (explicitRoles.length === 0) {
    try {
      filterRoles = resolveSessionCaptureRoles(config) ?? [];
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  const filterText = normalizeFlagString(flags["filter-text"] as string | undefined);
  const preserveEventTime = Boolean(flags["preserve-event-time"]);
  const formatRaw = flags["format"] as string | undefined;
  let format: SessionAdapterId | undefined;
  if (formatRaw !== undefined && formatRaw !== "auto") {
    if (!isSessionAdapterId(formatRaw))
      return fail(`--format must be one of ${sessionAdapterFormatChoices()}; got ${formatRaw}`);
    format = formatRaw;
  }

  const { value: since, error: sinceErr } = parseOptionalIsoDate(flags, "since");
  if (sinceErr) return fail(sinceErr);

  const dryRun = Boolean(flags["dry-run"]);
  const recall = Boolean(flags["recall"]);
  const asJson = flags["json"] === true;

  // Built once and handed to every import this invocation performs, so a
  // discovered import and a named-path import cannot diverge in what they
  // filter, what they stamp, or what they withhold.
  const importOptions = {
    agent,
    ...(format ? { format } : {}),
    ...(since ? { since } : {}),
    dryRun,
    recall,
    ...(recallSessionId !== null ? { recallSessionId } : {}),
    ...(recallSummaryGroupSize !== undefined ? { recallSummaryGroupSize } : {}),
    ...(ingestScope !== null ? { ingestScope } : {}),
    ...(filterRoles.length > 0 ? { filterRoles } : {}),
    ...(filterText !== null ? { filterTextIncludes: filterText } : {}),
    ...(preserveEventTime ? { preserveEventTime } : {}),
  };

  if (sessionPath === null) {
    return await sweep({
      vault,
      config,
      agent,
      asJson,
      recall,
      dryRun,
      discover,
      importAll,
      progress: flags["progress"] === true,
      importOptions,
    });
  }

  let stat;
  try {
    stat = statSync(sessionPath);
  } catch (err) {
    return fail(`cannot stat ${sessionPath}: ${(err as Error).message ?? err}`);
  }

  let result: Awaited<ReturnType<typeof importSessionPath>>;
  try {
    result = stat.isDirectory()
      ? await importSessionPath(vault, sessionPath, importOptions)
      : { files: [await importSession(vault, sessionPath, importOptions)], warnings: [] };
  } catch (exc) {
    return reportImportFailure(exc);
  }

  // Past this line the import HAPPENED: signals are on disk. Everything
  // that follows is bookkeeping about it, and a bookkeeping failure is
  // reported as itself rather than as a failed import. The ledger write
  // used to sit inside the same `try` as the import above, so a corrupt
  // ledger printed `import-session failed: …`, exited 1 and emitted no
  // report at all - for a run whose signals had already been written and
  // whose log events had already been appended.
  let ledgerError: string | null = null;
  if (!dryRun) {
    logImports(vault, agent, result.files);
    try {
      // A named path is still coverage. Recording it is what stops a
      // later `--status` from reporting a log the operator has already
      // imported by hand as outstanding - the exact false gap this whole
      // surface exists to remove.
      //
      // The files that were actually IMPORTED, not the files that were
      // found. `importSessionPath` collects a per-file failure into
      // `warnings` and carries on, so walking the directory again here
      // recorded the ones that failed as imported: they left the ledger
      // at their current bytes, vanished from `--status` and `--discover`
      // until something edited them, and would stay invisible even after
      // a later release shipped an adapter that could read them.
      recordUnderDeclaredRoots(
        vault,
        result.files.map((f) => f.file),
      );
    } catch (exc) {
      ledgerError = (exc as Error).message ?? String(exc);
    }
  }

  emitImportReport(result, { asJson, recall });
  if (ledgerError !== null) return reportLedgerFailure(ledgerError);
  return 0;
}

/**
 * The import landed and the coverage ledger did not.
 *
 * Non-zero, because something the operator asked for did not happen - but
 * named as what it is. The repair is different from a failed import (the
 * signals are already in the vault; re-running would only re-import work
 * dedup will suppress), and the consequence is bounded and worth stating:
 * the next sweep offers these files again.
 */
function reportLedgerFailure(detail: string): number {
  process.stderr.write(
    `error: the import completed and its signals were written, but the session import ledger ` +
      `could not be updated: ${detail}. A later --status or --discover will offer these files ` +
      "again; re-importing them is safe, because dedup suppresses the writes.\n",
  );
  return 1;
}

/**
 * Refuse a combination rather than rank it.
 *
 * Each message names BOTH halves of the conflict and says what each one
 * does, because the operator asked for two things and the repair is
 * choosing between them - a message that named only the flag it dropped
 * would leave them guessing which behaviour they still have.
 */
function assertOneMode(
  sessionPath: string | null,
  discover: boolean,
  status: boolean,
  importAll: boolean,
): void {
  if (discover && status) {
    throw new CliError(
      "--discover and --status ask two different questions of one sweep: --status reports the " +
        "per-runtime found/imported/gap counts, --discover lists the files it would import. " +
        "Pass one.",
    );
  }
  if (importAll && !discover) {
    throw new CliError(
      "--all only means something alongside --discover: it turns the discovery report into an " +
        "import of the gap it just listed. Pass --discover --all.",
    );
  }
  if (sessionPath !== null && (discover || status)) {
    throw new CliError(
      `${sessionPath} and ${discover ? "--discover" : "--status"} cannot both be given: a path ` +
        "imports exactly that path, and the sweep works over the session roots this build " +
        "declares. Drop one.",
    );
  }
  if (sessionPath === null && !discover && !status) {
    throw new CliError(
      "brain import-session requires a <path> argument, or --discover / --status to sweep the " +
        "session stores this machine declares.",
    );
  }
}

interface SweepRequest {
  readonly vault: string;
  readonly config: string | null;
  readonly agent: string;
  readonly asJson: boolean;
  readonly recall: boolean;
  readonly dryRun: boolean;
  readonly discover: boolean;
  readonly importAll: boolean;
  readonly progress: boolean;
  readonly importOptions: Parameters<typeof importSession>[2];
}

/** The machine-wide half: `--status`, `--discover`, and `--discover --all`. */
async function sweep(req: SweepRequest): Promise<number> {
  // Progress is opt-in: attaching a sink by default would change the
  // stderr of every existing invocation. The rail decides whether the
  // stream can carry it at all.
  const observation = req.progress
    ? attachProgress({ command: "brain", argv: ["import-session"], jsonRequested: req.asJson })
    : null;
  reportProgressRefusal(observation);

  let discovery: SessionDiscovery;
  try {
    discovery = discoverSessions(req.vault, {
      safeguard: createSafeguard({
        operation: OPERATION.sessions,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.sessions, req.config ?? undefined),
      }),
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
  } catch (exc) {
    return fail(`session discovery failed: ${(exc as Error).message ?? exc}`);
  }

  if (!req.importAll) {
    emitCoverage(discovery, { asJson: req.asJson, listGap: req.discover });
    return 0;
  }

  const gap = discoveryGap(discovery);
  const files: Awaited<ReturnType<typeof importSession>>[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  const imported: SessionImportRecord[] = [];
  for (const entry of gap) {
    try {
      // Sequential on purpose: `importSession` builds and consults one
      // dedup index per call, and two concurrent imports would each miss
      // the other's writes.
      // oxlint-disable-next-line no-await-in-loop
      files.push(await importSession(req.vault, entry.path, req.importOptions));
      imported.push(entry);
    } catch (exc) {
      // One unreadable log must not lose the rest of the sweep; the
      // failure is named and the run carries on.
      failures.push({ path: entry.path, message: (exc as Error).message ?? String(exc) });
    }
  }

  // Same ordering as the path form, for the same reason: the imports have
  // landed, so a lock timeout or a read-only vault in the ledger write is
  // a bookkeeping failure and must not swallow the report of what was
  // imported. This call was not in a `try` at all, so it took the whole
  // run's report down with it.
  let ledgerError: string | null = null;
  if (!req.dryRun) {
    logImports(req.vault, req.agent, files);
    if (imported.length > 0) {
      try {
        recordSessionImports(req.vault, imported);
      } catch (exc) {
        ledgerError = (exc as Error).message ?? String(exc);
      }
    }
  }

  emitImportReport({ files, warnings: [] }, { asJson: req.asJson, recall: req.recall, failures });
  if (ledgerError !== null) return reportLedgerFailure(ledgerError);
  return failures.length > 0 ? 1 : 0;
}

/** `path -> the runtime whose declared root contains it`, recorded in the ledger. */
function recordUnderDeclaredRoots(vault: string, paths: ReadonlyArray<string>): void {
  const records: SessionImportRecord[] = [];
  for (const path of paths) {
    const runtime = runtimeForPath(path);
    if (runtime !== null) records.push({ path, runtime });
  }
  if (records.length > 0) recordSessionImports(vault, records);
}

/** Append one `import-session` log event per imported file, fail-soft. */
function logImports(
  vault: string,
  agent: string,
  files: ReadonlyArray<Awaited<ReturnType<typeof importSession>>>,
): void {
  for (const f of files) {
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

/** One coverage row, as the JSON surface serialises it. */
function coverageJson(row: RuntimeCoverage): Record<string, unknown> {
  return {
    runtime: row.runtime,
    found: row.found,
    imported: row.imported,
    gap: row.gap,
    unparsable: row.unparsable,
    roots: row.roots.map((root) => ({
      id: root.id,
      path: root.path,
      present: root.present,
      adapter: root.adapter,
      format: root.format,
    })),
  };
}

/** Report what the sweep found, without importing anything. */
function emitCoverage(
  discovery: SessionDiscovery,
  opts: { asJson: boolean; listGap: boolean },
): void {
  if (opts.asJson) {
    okJson({
      found: discovery.found,
      imported: discovery.imported,
      gap: discovery.gap,
      unparsable: discovery.unparsable,
      unreadable: discovery.unreadable,
      by_runtime: discovery.byRuntime.map(coverageJson),
      ...(opts.listGap
        ? { would_import: discovery.byRuntime.flatMap((row) => [...row.gapPaths]) }
        : {}),
    });
    return;
  }
  ok(`found: ${discovery.found}`);
  ok(`imported: ${discovery.imported}`);
  ok(`gap: ${discovery.gap}`);
  if (discovery.unparsable > 0) ok(`unparsable: ${discovery.unparsable}`);
  for (const row of discovery.byRuntime) {
    ok(`runtime: ${row.runtime}`);
    ok(`  found: ${row.found}`);
    ok(`  imported: ${row.imported}`);
    ok(`  gap: ${row.gap}`);
    if (row.unparsable > 0) ok(`  unparsable: ${row.unparsable}`);
    // Where it looked. "found: 0" without the root it looked under is an
    // answer an operator cannot act on or disbelieve.
    for (const root of row.roots) {
      ok(`  root: ${root.path} (${root.present ? "present" : "absent"})`);
    }
    if (opts.listGap) for (const path of row.gapPaths) ok(`  would import: ${path}`);
  }
  for (const line of discovery.unreadable) info(`  unreadable: ${line}`);
}

/** The per-file import report, shared by the path form and the sweep. */
function emitImportReport(
  result: {
    files: ReadonlyArray<Awaited<ReturnType<typeof importSession>>>;
    warnings: ReadonlyArray<{ path: string; message: string }>;
  },
  opts: {
    asJson: boolean;
    recall: boolean;
    failures?: ReadonlyArray<{ path: string; message: string }>;
  },
): void {
  const failures = opts.failures ?? [];
  if (opts.asJson) {
    okJson({
      files: result.files.map((f) => ({
        file: f.file,
        format: f.format,
        write_mode: f.write_mode,
        turns_scanned: f.turns_scanned,
        signals_created: f.signals_created,
        signals_withheld: f.signals_withheld,
        signals_deduped: f.signals_deduped,
        facts_extracted: f.facts_extracted,
        facts_withheld: f.facts_withheld,
        tool_replays: f.tool_replays,
        malformed: f.malformed,
        filtered_turns: f.filtered_turns,
        recall_turns_imported: f.recall_turns_imported,
        recall_summary_nodes: f.recall_summary_nodes,
        errors: f.errors,
      })),
      warnings: result.warnings,
      ...(failures.length > 0 ? { failed: failures } : {}),
    });
    return;
  }
  for (const f of result.files) {
    ok(`file: ${f.file}`);
    ok(`  format: ${f.format}`);
    ok(`  write_mode: ${f.write_mode}`);
    ok(`  turns_scanned: ${f.turns_scanned}`);
    ok(`  signals_created: ${f.signals_created}`);
    // Printed only on a rehearsal, where it is the whole answer; an
    // applied run's withheld count is zero by construction.
    if (f.write_mode === IMPORT_WRITE_MODE.dryRun) {
      ok(`  signals_withheld: ${f.signals_withheld}`);
      ok(`  facts_withheld: ${f.facts_withheld}`);
    }
    ok(`  signals_deduped: ${f.signals_deduped}`);
    ok(`  tool_replays: ${f.tool_replays}`);
    ok(`  filtered_turns: ${f.filtered_turns}`);
    if (opts.recall) {
      ok(`  recall_turns_imported: ${f.recall_turns_imported}`);
      ok(`  recall_summary_nodes: ${f.recall_summary_nodes}`);
    }
    if (f.malformed > 0) ok(`  malformed: ${f.malformed}`);
    for (const e of f.errors) info(`  error: ${e.path}: ${e.message}`);
  }
  for (const w of result.warnings) info(`  warning: ${w.path}: ${w.message}`);
  for (const f of failures) process.stderr.write(`error: ${f.path}: ${f.message}\n`);
}

/** Map a session-import throw onto this verb's exit codes. */
function reportImportFailure(exc: unknown): number {
  if (exc instanceof SessionImportError) {
    process.stderr.write(`error: ${exc.message}\n`);
    if (exc.code === "DETECT_FAIL" || exc.code === "UNKNOWN_FORMAT") return 2;
    return 1;
  }
  return fail(`import-session failed: ${(exc as Error).message ?? exc}`);
}

function normalizeRoleFilter(
  raw: string[] | undefined,
): Array<"user" | "assistant" | "system" | "tool" | "meta"> {
  if (!raw || raw.length === 0) return [];
  const allowed = new Set(["user", "assistant", "system", "tool", "meta"] as const);
  const out: Array<"user" | "assistant" | "system" | "tool" | "meta"> = [];
  for (const value of raw) {
    const normalized = value.trim().toLowerCase() as
      | "user"
      | "assistant"
      | "system"
      | "tool"
      | "meta";
    if (!allowed.has(normalized)) {
      throw new CliError(`--filter-role contains unsupported value: ${value}`);
    }
    out.push(normalized);
  }
  return [...new Set(out)];
}

function parsePositiveIntegerFlag(
  value: string | boolean | string[] | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new CliError(`${flag} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${flag} must be a positive integer`);
  return parsed;
}
