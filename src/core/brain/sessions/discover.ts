/**
 * What session logs exist on this machine, and which were never imported.
 *
 * `importSession` needs a path. That made cross-agent recall worth nothing
 * for any session nobody knew to import: an operator had to already know
 * that Claude Code writes under `~/.claude/projects`, that Codex has moved
 * its rollouts between four subdirectories of `$CODEX_HOME`, that Grok
 * encodes the working directory into a path component, and then run the
 * verb once per file. This module is the other half - the sweep that says
 * what is here and what is still outstanding - and the ledger that makes
 * the second run cheap.
 *
 * ## The ledger is keyed by content, and lives beside the other derived state
 *
 * Re-importing an unchanged log used to re-parse every byte of it to
 * discover it had nothing to write: dedup suppresses the WRITES, not the
 * read. So an entry records the SHA-256 of the file's bytes at the moment
 * it was imported, and a file whose hash still matches is reported as
 * imported without anything opening it again. Content and not mtime, for
 * the reason `ingest/content-manifest.ts` gives at length: an rsync, a
 * Syncthing round trip or a `git checkout` moves the clock and not a byte,
 * and a ledger that believed the clock would re-import the whole machine
 * after any of them.
 *
 * That manifest is the same SHAPE and is deliberately NOT reused. Its keys
 * are canonical vault-RELATIVE paths, resolved against the vault on every
 * lookup (`classifyPaths` does `join(vault, canonicalNotePath(path))`);
 * session logs live outside the vault at absolute machine paths, which
 * `canonicalNotePath` exists to reject. Only the primitive both need -
 * {@link hashFile} - is shared.
 *
 * ## Why the sweep carries a deadline and a progress rail
 *
 * Measured before it was decided, on the shape of a real store: 1227
 * transcripts totalling 596 MB under `~/.claude/projects`, swept as a
 * synthetic fixture of the same size. {@link discoverSessions} takes
 * 3.1 s warm and 6.0 s on the first pass over a cold cache; the walk is
 * 4 ms of that and the hashing is all the rest. It emits 1229 progress
 * records, not one. So it gets both a rail whose denominator is known
 * once the walk is done, and the same cooperative deadline every other
 * long operation here carries - a run that would trip 600 s is one over
 * a store this could not otherwise report on at all. Neither is on by
 * default: the sink is opt-in at the CLI edge, and an absent safeguard is
 * a no-op.
 *
 * Nothing here parses a transcript. Discovery reads bytes to hash them and
 * makes no attempt to interpret them, which is what keeps a sweep over a
 * store this build has no adapter for (Cursor's `state.vscdb`) honest: it
 * is reported as FOUND and never as a gap, because a gap is work an
 * operator can close.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  resolveSessionRootsFor,
  isSessionRuntimeId,
  SESSION_RUNTIME_IDS,
  type HostContext,
  type ResolvedSessionRoot,
  type SessionRuntimeId,
} from "../../runtime/host-facts.ts";
import { hashFile } from "../ingest/content-manifest.ts";
import { DERIVED_STORE_DIR } from "../path-constants.ts";
import { progressCounter, type ProgressSink } from "../progress.ts";
import { OPERATION, type Safeguard } from "../safeguard.ts";
import { acquireLockSyncWithRetry } from "../sync-lockfile.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

/** Only ledger schema this build understands. Anything else is refused. */
export const SESSION_LEDGER_SCHEMA_VERSION = 1 as const;

/** Basename of the import ledger inside the derived store. */
const SESSION_LEDGER_FILE = "session-import-ledger.json";

/**
 * The progress stage this sweep opens. One stage, because the walk is
 * three orders of magnitude cheaper than the hashing and a rail that
 * announced it would be reporting on nothing.
 */
const HASH_STAGE = "hash";

/** Absolute path of the session import ledger for a vault. */
export function sessionLedgerPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, SESSION_LEDGER_FILE);
}

/** What was recorded about one imported session log. */
export interface SessionLedgerEntry {
  /** SHA-256 hex of the file's bytes at the moment it was imported. */
  readonly hash: string;
  /** Which runtime wrote it, for the per-runtime coverage report. */
  readonly runtime: SessionRuntimeId;
  /** When this build imported it, to the second. */
  readonly imported_at: string;
}

/** Absolute log path → what was recorded about it. */
export interface SessionImportLedger {
  readonly schema_version: typeof SESSION_LEDGER_SCHEMA_VERSION;
  readonly entries: Readonly<Record<string, SessionLedgerEntry>>;
}

/** One declared root, measured against the host. */
export interface DiscoveredRoot extends ResolvedSessionRoot {
  /** Whether the directory exists here. Absent is not empty. */
  readonly present: boolean;
}

/** One runtime's coverage: what is here, and how much of it is outstanding. */
export interface RuntimeCoverage {
  readonly runtime: SessionRuntimeId;
  readonly roots: ReadonlyArray<DiscoveredRoot>;
  /** Session logs found under this runtime's roots. */
  readonly found: number;
  /** Of those, the ones the ledger records at their current bytes. */
  readonly imported: number;
  /**
   * Of those, the ones an import would still have work to do on: never
   * recorded, or recorded at different bytes.
   */
  readonly gap: number;
  /**
   * Of those, the ones no adapter in this build can parse. Counted apart
   * from the gap because a gap is work an operator can close, and
   * `found = imported + gap + unparsable` only reads as a coverage answer
   * when the third term is visible.
   */
  readonly unparsable: number;
  /** The gap, as absolute paths, sorted. */
  readonly gapPaths: ReadonlyArray<string>;
}

/** What one machine-wide sweep found. */
export interface SessionDiscovery {
  readonly byRuntime: ReadonlyArray<RuntimeCoverage>;
  readonly found: number;
  readonly imported: number;
  readonly gap: number;
  readonly unparsable: number;
  /**
   * Roots and files that exist and could not be read. Carried even when
   * something was found: a partial sweep found less than it should have,
   * and the counts alone cannot say so.
   */
  readonly unreadable: ReadonlyArray<string>;
}

export interface DiscoverSessionsOptions {
  /** The machine to ask about. Defaults to the one this process runs on. */
  readonly host?: HostContext;
  /** Cooperative deadline, checked once per file. */
  readonly safeguard?: Safeguard;
  /** Where per-file progress goes. Absent means nobody is watching. */
  readonly onProgress?: ProgressSink;
}

/** One file to record as imported. */
export interface SessionImportRecord {
  readonly path: string;
  readonly runtime: SessionRuntimeId;
}

/** The host this process is running on, when the caller named none. */
function currentHost(): HostContext {
  return { home: process.env["HOME"] ?? "", env: process.env };
}

/**
 * Read the ledger. A missing file is an empty ledger - every log then
 * classifies as a gap, which is the correct answer for a vault that has
 * imported nothing. A CORRUPT or unknown-schema file is a hard error: a
 * silent reset would report an operator's entire already-imported machine
 * as outstanding and send them to re-import all of it.
 */
export function readSessionLedger(vault: string): SessionImportLedger {
  const path = sessionLedgerPath(vault);
  if (!existsSync(path)) return { schema_version: SESSION_LEDGER_SCHEMA_VERSION, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`session import ledger is corrupted JSON: ${path}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`session import ledger is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SESSION_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `session import ledger schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${SESSION_LEDGER_SCHEMA_VERSION}): ${path}`,
    );
  }
  const entries: Record<string, SessionLedgerEntry> = {};
  const raw = obj["entries"];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = readEntry(value);
      if (entry !== null) entries[key] = entry;
    }
  }
  return { schema_version: SESSION_LEDGER_SCHEMA_VERSION, entries };
}

/**
 * One entry, or `null` when it is not one this build can read.
 *
 * The runtime went through JSON, so it is a string until the guard says
 * otherwise: a release that adds a runtime writes entries this one cannot
 * attribute, and attributing them to an arbitrary runtime would be worse
 * than treating the file as never imported.
 */
function readEntry(value: unknown): SessionLedgerEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const hash = row["hash"];
  const runtime = row["runtime"];
  const importedAt = row["imported_at"];
  if (typeof hash !== "string" || !isSessionRuntimeId(runtime)) return null;
  return {
    hash,
    runtime,
    imported_at: typeof importedAt === "string" ? importedAt : "",
  };
}

/** Canonical ledger bytes: keys sorted, so a no-op rerun is byte-identical. */
function serializeLedger(entries: Record<string, SessionLedgerEntry>): string {
  const sorted: Record<string, SessionLedgerEntry> = {};
  for (const key of Object.keys(entries).toSorted()) sorted[key] = entries[key]!;
  return (
    JSON.stringify({ schema_version: SESSION_LEDGER_SCHEMA_VERSION, entries: sorted }, null, 2) +
    "\n"
  );
}

/**
 * Record `imports` as imported at their current bytes. Returns `true` when
 * the ledger was rewritten, `false` on a byte-identical no-op.
 *
 * A path that has since vanished is dropped rather than recorded, so it
 * re-classifies as new if it ever reappears. The read, the merge and the
 * write are one critical section under the same lock every other Brain
 * read-modify-write takes: `--discover --all` and an explicit-path import
 * can be running in two processes at once, and two snapshots written back
 * in sequence would each lose the other's entry.
 *
 * Every OTHER entry that no longer names a file is dropped in the same
 * pass. Dropping only the re-submitted ones left a dead key behind for
 * every transcript a runtime renamed, rotated or deleted - and nothing
 * ever removed it, because a re-submission is the one moment the ledger
 * hears a path's name again. The pruning happens here and not in
 * {@link discoverSessions} on purpose: discovery writes nothing, and a
 * report that quietly rewrote the state it reports on would be a report
 * nobody could re-run. The cost is one `existsSync` per entry, on a write
 * path that already hashes a file per record.
 */
export function recordSessionImports(
  vault: string,
  imports: ReadonlyArray<SessionImportRecord>,
  now: Date = new Date(),
): boolean {
  assertVaultIdentityForWrite(vault);
  const path = sessionLedgerPath(vault);
  const handle = acquireLockSyncWithRetry(path);
  try {
    const entries: Record<string, SessionLedgerEntry> = { ...readSessionLedger(vault).entries };
    const stamp = isoSecond(now);
    for (const record of imports) {
      if (!existsSync(record.path)) {
        delete entries[record.path];
        continue;
      }
      entries[record.path] = {
        hash: hashFile(record.path),
        runtime: record.runtime,
        imported_at: stamp,
      };
    }
    for (const path of Object.keys(entries)) {
      if (!existsSync(path)) delete entries[path];
    }
    const next = serializeLedger(entries);
    if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
    atomicWriteFileSync(path, next);
    return true;
  } finally {
    handle.release();
  }
}

/** Every file matching `root`'s declared glob, sorted, or a read failure. */
function filesUnder(root: DiscoveredRoot): { files: ReadonlyArray<string>; unreadable: string[] } {
  if (!root.present) return { files: [], unreadable: [] };
  try {
    const found = [
      ...new Bun.Glob(root.glob).scanSync({
        cwd: root.path,
        onlyFiles: true,
        // A symlink cycle would drive the walk into unbounded recursion,
        // and a sweep that follows links out of a declared root is
        // reaching further than the declaration says.
        followSymlinks: false,
        // A plain `readdirSync` walk sees dotfiles, and `~/.codex/.tmp`
        // is a declared root; matching it would be inconsistent.
        dot: true,
      }),
    ].map((rel) => join(root.path, rel));
    found.sort();
    return { files: found, unreadable: [] };
  } catch (err) {
    // The root is there and this process cannot see inside it. Reporting
    // zero without saying so is the failure this branch exists to avoid.
    const detail = err instanceof Error ? err.message : String(err);
    return { files: [], unreadable: [`${root.path}: ${detail}`] };
  }
}

/** Whether the declared root exists here, without letting an errno escape. */
function rootPresent(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sweep every declared session root on `opts.host` and report, per
 * runtime, what is here and what has never been imported into `vault`.
 *
 * Reads only to hash. Writes nothing - not even the ledger, which records
 * imports and would be lying if a report updated it.
 */
export function discoverSessions(
  vault: string,
  opts: DiscoverSessionsOptions = {},
): SessionDiscovery {
  const host = opts.host ?? currentHost();
  const ledger = readSessionLedger(vault);
  const unreadable: string[] = [];

  // Walk first, so the counter has a denominator before it starts.
  const perRuntime = SESSION_RUNTIME_IDS.map((runtime) => {
    const roots: DiscoveredRoot[] = resolveSessionRootsFor(runtime, host).map((root) => ({
      ...root,
      present: rootPresent(root.path),
    }));
    const files: Array<{ path: string; root: DiscoveredRoot }> = [];
    for (const root of roots) {
      const scan = filesUnder(root);
      unreadable.push(...scan.unreadable);
      for (const path of scan.files) files.push({ path, root });
    }
    return { runtime, roots, files };
  });

  const total = perRuntime.reduce((sum, r) => sum + r.files.length, 0);
  const progress = progressCounter(OPERATION.sessions, opts.onProgress);
  progress.start(HASH_STAGE, total);

  const byRuntime: RuntimeCoverage[] = [];
  try {
    for (const entry of perRuntime) {
      let imported = 0;
      let unparsable = 0;
      const gapPaths: string[] = [];
      for (const file of entry.files) {
        opts.safeguard?.checkpoint();
        progress.advance(HASH_STAGE);
        if (file.root.adapter === null) {
          unparsable += 1;
          continue;
        }
        let hash: string;
        try {
          hash = hashFile(file.path);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          unreadable.push(`${file.path}: ${detail}`);
          continue;
        }
        if (ledger.entries[file.path]?.hash === hash) imported += 1;
        else gapPaths.push(file.path);
      }
      gapPaths.sort();
      byRuntime.push({
        runtime: entry.runtime,
        roots: Object.freeze(entry.roots),
        found: entry.files.length,
        imported,
        gap: gapPaths.length,
        unparsable,
        gapPaths: Object.freeze(gapPaths),
      });
    }
  } catch (err) {
    // The stream promises to terminate whichever way the run ends; a
    // sweep that simply stopped arriving reads as one that hung.
    progress.stop("failed");
    throw err;
  }
  progress.finish();

  return Object.freeze({
    byRuntime: Object.freeze(byRuntime),
    found: byRuntime.reduce((sum, r) => sum + r.found, 0),
    imported: byRuntime.reduce((sum, r) => sum + r.imported, 0),
    gap: byRuntime.reduce((sum, r) => sum + r.gap, 0),
    unparsable: byRuntime.reduce((sum, r) => sum + r.unparsable, 0),
    unreadable: Object.freeze(unreadable.toSorted()),
  });
}

/**
 * Which declared root `path` sits under, or `null` when it sits under
 * none.
 *
 * Pure path arithmetic - no walk, no stat, no hash - because the caller
 * is an explicit-path import that has already done its work and only
 * needs to know whether the file it just imported is part of this
 * machine's coverage. A log the operator copied to `/tmp` is not, and
 * recording it would put a path in the ledger that no sweep will ever
 * look for again.
 */
export function runtimeForPath(path: string, host?: HostContext): SessionRuntimeId | null {
  const ctx = host ?? currentHost();
  for (const runtime of SESSION_RUNTIME_IDS) {
    for (const root of resolveSessionRootsFor(runtime, ctx)) {
      if (path === root.path || path.startsWith(`${root.path}/`)) return runtime;
    }
  }
  return null;
}

/** Every outstanding log across every runtime, with the runtime that wrote it. */
export function discoveryGap(discovery: SessionDiscovery): ReadonlyArray<SessionImportRecord> {
  const out: SessionImportRecord[] = [];
  for (const row of discovery.byRuntime) {
    for (const path of row.gapPaths) out.push({ path, runtime: row.runtime });
  }
  return Object.freeze(out);
}
