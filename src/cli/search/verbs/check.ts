/**
 * `o2b search check` — pre-flight diagnostics over everything search needs
 * (vault, index directory, SQLite/FTS5, the vector extension, the
 * embedding key, the provider) plus the ABI stamp of the stored vectors.
 *
 * `--integrity` adds the one probe the rest of this report cannot give:
 * a full `PRAGMA quick_check` over the index FILE, run on demand
 * (what-the-index-already-knew, unit K, reader-side half).
 *
 * The store's own integrity gate runs that scan at WRITE open, behind a
 * 24-hour interval. That closes the hole for anyone who indexes; it
 * closes nothing for a pure reader, who never opens the store for
 * writing, never triggers a scan, and therefore never gets the fault key
 * the read open refuses on. Since the index file lives inside the vault
 * and vaults are replicated between machines, that reader is the person
 * most likely to end up with a rotting index and no signal at all.
 *
 * Three properties are deliberate here:
 *
 *   - It is OPT-IN. The scan is linear in the size of the index (~22 ms
 *     per megabyte, so roughly half a minute on a 1.3 GB one) and
 *     `search check` is advertised as a cheap pre-flight by onboarding,
 *     by the semantic-search hint and by two registered diagnostic
 *     exits. Absent the flag this verb emits exactly the bytes it always
 *     did and touches no `index_state` cell.
 *   - It REPORTS; it does not repair. The verdict is recorded in the same
 *     two `index_state` cells the write-open gate writes - there is one
 *     notion of this store's health, not two - and the exit is named for
 *     the operator to run, never run for them.
 *   - It never reports the ABSENCE of a fault as a pass. "Never checked"
 *     and "checked and clean" are separate states of the world and stay
 *     separate in both report shapes.
 *
 * One boundary note, stated rather than left to be discovered. `store.ts`
 * is the single SQL boundary for `core/search`, and it re-exports the
 * `index_state` keys the rest of the system reads - but not the two
 * integrity keys, and not `runIntegrityCheck`. This module therefore
 * reaches `store/lifecycle.ts`, `store/state.ts` and `store/sql.ts`
 * directly. Those are the SAME symbols the write-open gate uses, so the
 * two paths cannot disagree about what was scanned or where the verdict
 * lives; what is missing is a `Store` method to reach them through. The
 * clean home for the block below is `store.ts`, as one exported
 * `scanStoreIntegrity(config)`, and moving it there is a pure lift.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

import {
  SEARCH_INDEX_CORRUPT_CODE,
  SEARCH_INDEX_MISSING_CODE,
} from "../../../core/brain/diagnostics.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { formatStampMismatch } from "../../../core/integrity/stamp.ts";
import { indexCheck, serializeStampMismatches } from "../../../core/search/index.ts";
import type { IndexCheckReport, ResolvedSearchConfig } from "../../../core/search/index.ts";
import { acquireWriterLock } from "../../../core/search/store.ts";
import { runIntegrityCheck } from "../../../core/search/store/lifecycle.ts";
import { nowIso } from "../../../core/search/store/sql.ts";
import {
  deleteState,
  getState,
  INTEGRITY_CHECKED_AT_STATE_KEY,
  INTEGRITY_FAULT_STATE_KEY,
  setState,
} from "../../../core/search/store/state.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import {
  flagBoolean,
  parseFlags,
  resolveConfig,
  searchAdvisoryStream,
  VAULT_FLAGS,
} from "../helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The on-demand structural scan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a completed scan concluded, or that it did not run. `notRun` is a
 * first-class arm rather than a fault: a check that could not run has not
 * found the file healthy and must never be rendered as if it had.
 */
const INTEGRITY_VERDICT = Object.freeze({
  ok: "ok",
  faulty: "faulty",
  notRun: "not-run",
} as const);

type IntegrityVerdictLabel = (typeof INTEGRITY_VERDICT)[keyof typeof INTEGRITY_VERDICT];

/**
 * Scan cost as measured on this project's own indexes: about 22 ms per
 * megabyte of index file (0.85 s on 38 MB, 30 s on 1.3 GB). Used only to
 * tell the operator what the command is about to spend, before it spends
 * it - the estimate never gates anything.
 */
const SCAN_MS_PER_MEGABYTE = 22;

const BYTES_PER_MEGABYTE = 1024 * 1024;
const MS_PER_SECOND = 1000;
/** Decimal places for the sizes and durations this verb prints. */
const REPORT_PRECISION = 1;

/**
 * Where the value column of this report's aligned `label:` lines starts.
 * Used to indent the continuation lines of a multi-line value.
 */
const VALUE_COLUMN = " ".repeat("vault_readable:        ".length);

/**
 * The `integrity_checked_at` cell as found BEFORE this run. `at: null`
 * on the `read` arm is the load-bearing state - no full check has ever
 * completed against this file - and it is kept apart from `unreadable`
 * because a store nobody has verified and a store whose metadata is
 * itself damaged are different findings, and reporting the second as
 * "never" would be an invented fact.
 */
type PriorCheck =
  | { readonly kind: "read"; readonly at: string | null }
  | { readonly kind: "unreadable"; readonly detail: string };

/** The result of one on-demand integrity scan, in full. */
interface IntegrityReport {
  /** Whether a full `PRAGMA quick_check` actually completed this run. */
  readonly scanned: boolean;
  readonly verdict: IntegrityVerdictLabel;
  /** What this file said about its own last full check, or `null` when none ran. */
  readonly priorCheck: PriorCheck | null;
  /** The stamp this run recorded, or `null` when no scan ran. */
  readonly checkedAt: string | null;
  /** Wall time the scan itself took, or `null` when no scan ran. */
  readonly elapsedMs: number | null;
  /** Size of the file that was scanned, or `null` when there was none. */
  readonly indexBytes: number | null;
  /** The verdict text, only when the scan condemned the file. */
  readonly fault: string | null;
  /** Why the scan could not run, only on the `not-run` arm. */
  readonly reason: string | null;
  /** Whether the verdict reached `index_state`; false is reported, never hidden. */
  readonly recorded: boolean;
  /** Registered diagnostic code naming this state's exit, or `null` when clean. */
  readonly exitCode: string | null;
}

/** The `not-run` arm: a stated reason and the exit that ends it. */
function scanDidNotRun(reason: string, exitCode: string): IntegrityReport {
  return {
    scanned: false,
    verdict: INTEGRITY_VERDICT.notRun,
    priorCheck: null,
    checkedAt: null,
    elapsedMs: null,
    indexBytes: null,
    fault: null,
    reason,
    recorded: false,
    exitCode,
  };
}

/** `n` bytes as megabytes, for the size this verb quotes to the operator. */
function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MEGABYTE).toFixed(REPORT_PRECISION);
}

/**
 * `ms` in the unit that carries information at its magnitude. A small
 * vault's scan really does take a few milliseconds, and rounding that to
 * "0.0 s" would read as a scan that did not happen.
 */
function duration(ms: number): string {
  return ms < MS_PER_SECOND
    ? `${Math.round(ms)} ms`
    : `${(ms / MS_PER_SECOND).toFixed(REPORT_PRECISION)} s`;
}

/**
 * The line written BEFORE the scan starts. It goes to stderr in both
 * report shapes: an operator who typed the flag still cannot know that
 * their 1.3 GB index means a thirty-second wait, and stdout under
 * `--json` is a payload a caller parses.
 */
function announceScan(dbPath: string, bytes: number): void {
  const estimate = duration((bytes / BYTES_PER_MEGABYTE) * SCAN_MS_PER_MEGABYTE);
  process.stderr.write(
    `integrity scan: reading all ${megabytes(bytes)} MB of ${dbPath}; ` +
      `expect roughly ${estimate} (the scan is linear in the size of the index)\n`,
  );
}

/**
 * Record a completed scan's verdict in the SAME two cells the write-open
 * gate uses, so this verb adds no second notion of the store's health and
 * the read open starts refusing a condemned file immediately.
 *
 * Returns whether the record landed. A file damaged badly enough may
 * refuse the write; that is reported on stderr and carried in the report
 * rather than swallowed, because a fault nobody could record is a fault
 * the read path will not act on.
 */
function recordVerdict(db: Database, dbPath: string, stamp: string, fault: string | null): boolean {
  try {
    setState(db, INTEGRITY_CHECKED_AT_STATE_KEY, stamp);
    if (fault === null) deleteState(db, INTEGRITY_FAULT_STATE_KEY);
    else setState(db, INTEGRITY_FAULT_STATE_KEY, fault);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`warning: could not record the integrity verdict in ${dbPath}: ${msg}\n`);
    return false;
  }
}

/** What this file records about its own last completed full check. */
function readPriorCheck(db: Database): PriorCheck {
  try {
    return { kind: "read", at: getState(db, INTEGRITY_CHECKED_AT_STATE_KEY) };
  } catch (e) {
    return { kind: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run the scan on demand, ignoring the interval gate the write path
 * honours: an operator who asked for a check has asked for THIS check,
 * and a gate that answered "one ran yesterday" would defeat the purpose
 * of the verb.
 *
 * The writer lock is held across the scan so no concurrent index run can
 * mutate the file underneath it, and so the verdict this run records
 * cannot race the one a write open records.
 */
async function scanIntegrity(config: ResolvedSearchConfig): Promise<IntegrityReport> {
  const dbPath = config.dbPath;
  if (!existsSync(dbPath)) {
    return scanDidNotRun(`no search index at ${dbPath}`, SEARCH_INDEX_MISSING_CODE);
  }
  const indexBytes = statSync(dbPath).size;
  announceScan(dbPath, indexBytes);

  const release = await acquireWriterLock(dbPath);
  try {
    let db: Database;
    try {
      db = new Database(dbPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return scanDidNotRun(`cannot open ${dbPath}: ${msg}`, SEARCH_INDEX_CORRUPT_CODE);
    }
    try {
      // Read the previous stamp through the SAME key the write-open gate
      // writes, so this verb consults the store's own record of its
      // health rather than a second one.
      const priorCheck = readPriorCheck(db);

      const startedAt = performance.now();
      const verdict = runIntegrityCheck(db);
      const elapsedMs = Math.round(performance.now() - startedAt);

      // `quick_check` passes any well-formed sqlite file, including one
      // that is not a search index at all. A PASS therefore needs the
      // metadata read above as its proof, or it would report a foreign
      // database as a healthy index - exactly the misleading pass this
      // unit exists to prevent. A FAILURE needs no such proof: a
      // malformed database at the index path is a fault either way, and
      // is reported as the fault it is.
      if (verdict.ok && priorCheck.kind === "unreadable") {
        return scanDidNotRun(
          `${dbPath} does not read as a search index: ${priorCheck.detail}`,
          SEARCH_INDEX_CORRUPT_CODE,
        );
      }

      const stamp = nowIso();
      const fault = verdict.ok ? null : verdict.fault;
      const recorded = recordVerdict(db, dbPath, stamp, fault);

      return {
        scanned: true,
        verdict: verdict.ok ? INTEGRITY_VERDICT.ok : INTEGRITY_VERDICT.faulty,
        priorCheck,
        checkedAt: stamp,
        elapsedMs,
        indexBytes,
        fault,
        reason: null,
        recorded,
        exitCode: verdict.ok ? null : SEARCH_INDEX_CORRUPT_CODE,
      };
    } finally {
      db.close();
    }
  } finally {
    await release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Render one pre-flight probe's verdict, in the wording the check has always used. */
function ok(passed: boolean): string {
  return passed ? "OK" : "MISSING";
}

function jsonForCheck(r: IndexCheckReport): Record<string, unknown> {
  return {
    vault_readable: r.vaultReadable,
    index_dir_writable: r.indexDirWritable,
    sqlite_ok: r.sqliteOk,
    fts5_ok: r.fts5Ok,
    vec_extension: r.vecExtension,
    embedding_key_resolved: r.embeddingKeyResolved,
    provider_reachable: r.providerReachable,
    provider_reason: r.providerReason,
    // Emitted only on drift, so a matching store's JSON is byte-identical
    // to the pre-gate output (context-integrity-gates, Unit E).
    ...(r.embeddingAbi.length > 0
      ? { embedding_abi: serializeStampMismatches(r.embeddingAbi) }
      : {}),
    warnings: r.warnings,
    fatal: r.fatal,
    recommendations: r.recommendations,
  };
}

/** The `integrity` sub-object, present only when the flag asked for one. */
function jsonForIntegrity(r: IntegrityReport): Record<string, unknown> {
  return {
    scanned: r.scanned,
    verdict: r.verdict,
    ...(r.scanned
      ? {
          // The key is present exactly when the cell was READ, so an
          // absent key is never mistaken for a store nobody checked.
          ...(r.priorCheck?.kind === "read"
            ? { previously_checked_at: r.priorCheck.at }
            : { previous_check_unreadable: r.priorCheck?.detail ?? null }),
          checked_at: r.checkedAt,
          elapsed_ms: r.elapsedMs,
          index_bytes: r.indexBytes,
          recorded: r.recorded,
        }
      : {}),
    ...(r.fault !== null ? { fault: r.fault } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
    ...(r.exitCode !== null ? nextCommandField(r.exitCode) : {}),
  };
}

function renderCheckHuman(r: IndexCheckReport): string {
  const lines: string[] = [];
  lines.push(`vault_readable:        ${ok(r.vaultReadable)}`);
  lines.push(`index_dir_writable:    ${ok(r.indexDirWritable)}`);
  lines.push(`sqlite_ok:             ${ok(r.sqliteOk)}`);
  lines.push(`fts5_ok:               ${ok(r.fts5Ok)}`);
  lines.push(`vec_extension:         ${r.vecExtension}`);
  lines.push(`embedding_key:         ${ok(r.embeddingKeyResolved)}`);
  // Only on drift: a matching store renders exactly as before.
  for (const m of r.embeddingAbi) {
    lines.push(`embedding_abi:         ${formatStampMismatch(m)}`);
  }
  if (r.providerReachable !== null) {
    lines.push(`provider_reachable:    ${r.providerReachable ? "OK" : "FAIL"}`);
    if (r.providerReason) lines.push(`provider_reason:       ${r.providerReason}`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const f of r.fatal) lines.push(`fatal:   ${f}`);
  if (r.recommendations.length > 0) {
    lines.push("");
    lines.push("recommendations:");
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  return lines.join("\n") + "\n";
}

/** The three things this file can say about its own last full check. */
function describePriorCheck(prior: PriorCheck | null): string {
  if (prior === null || prior.kind === "unreadable") {
    return `unreadable (${prior?.detail ?? "no scan ran"})`;
  }
  return prior.at ?? "never";
}

/** The human integrity block, appended only when the flag asked for one. */
function renderIntegrityHuman(r: IntegrityReport): string {
  const lines: string[] = [];
  if (!r.scanned) {
    lines.push(`integrity:             ${r.verdict} (${r.reason})`);
    return lines.join("\n") + "\n";
  }
  const cost =
    r.elapsedMs !== null && r.indexBytes !== null
      ? ` (scanned ${megabytes(r.indexBytes)} MB in ${duration(r.elapsedMs)})`
      : "";
  lines.push(`integrity:             ${r.verdict}${cost}`);
  // "Never" is a state, not a blank: it is what makes a store nobody has
  // verified readable as such instead of as a healthy one. "Unreadable"
  // is a third state and is never folded into it.
  lines.push(`previous_full_check:   ${describePriorCheck(r.priorCheck)}`);
  // `quick_check` reports one line per damaged tree, so the verdict is
  // routinely multi-line. Every line is kept - the trees it names are the
  // cause an operator reports - and the continuations are indented to the
  // value column so the block stays readable beside the aligned labels.
  if (r.fault !== null) {
    lines.push(`integrity_fault:       ${r.fault.split("\n").join(`\n${VALUE_COLUMN}`)}`);
  }
  if (!r.recorded) {
    lines.push("integrity_recorded:    NO (the verdict could not be written to the index)");
  }
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Verb
// ─────────────────────────────────────────────────────────────────────────────

export async function cmdSearchCheck(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    integrity: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const jsonRequested = flagBoolean(flags, "json");
  const report = await indexCheck(cfg);
  // Absent the flag nothing below runs, nothing is written, and the two
  // report shapes are byte-identical to what they were before it existed.
  const integrity = flagBoolean(flags, "integrity") ? await scanIntegrity(cfg) : null;

  if (jsonRequested) {
    process.stdout.write(
      JSON.stringify({
        ...jsonForCheck(report),
        ...(integrity === null ? {} : { integrity: jsonForIntegrity(integrity) }),
      }) + "\n",
    );
  } else {
    process.stdout.write(renderCheckHuman(report));
    if (integrity !== null) process.stdout.write(renderIntegrityHuman(integrity));
  }
  if (integrity?.exitCode != null) {
    emitNextStep(integrity.exitCode, searchAdvisoryStream(argv, jsonRequested));
  }
  // A requested check that found a fault, or could not run at all, is not
  // a clean pre-flight - neither may exit 0.
  return report.fatal.length > 0 || (integrity !== null && integrity.exitCode !== null) ? 1 : 0;
}
