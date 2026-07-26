/**
 * Session-lineage ledger (continuity-hygiene-freshness suite).
 *
 * Append-only JSONL under `Brain/.state/` (dot-directory: excluded
 * from vault walking and search indexing, like `.snapshots`). One line
 * per lifecycle observation: session id, timestamp, cwd, event name,
 * whether the event evidences a compression boundary, and the resolved
 * lineage when the caller already knows it.
 *
 * The ledger exists for one consumer: the interim crutch resolution in
 * `crutch.ts` (CRUTCH(t_1459706f)). Once the host emits native lineage
 * fields the ledger keeps working as a cache of resolved links but is
 * no longer load-bearing.
 *
 * Contract for capture callers: resolve lineage BEFORE recording the
 * session's own observation - the crutch treats "this session already
 * has ledger history without a link" as proof it is a parallel
 * session, not a continuation.
 *
 * Everything here is fail-soft: a missing ledger reads as empty,
 * corrupt lines are skipped, and the file is compacted in place
 * (atomic rewrite) once it grows past the line cap.
 *
 * ## Integrity (context-integrity-gates, Unit D)
 *
 * Every line carries a SEQUENCE NUMBER and a HASH CHAIN link, so a line
 * that was edited, removed, or never written is detectable after the
 * fact - by {@link import('./verify.ts').verifyLineageLedger}, which
 * REPORTS and never refuses. The read path below deliberately does not
 * consult the chain: `readLineageLedger`'s catch-to-empty-map is
 * load-bearing for both the anticipatory cache and the lifecycle hook,
 * and a ledger that refused to load would break resolution rather than
 * degrade it. Integrity here is an audit property, not a gate.
 *
 * The whole read-modify-write runs under a SYNCHRONOUS writer lock
 * (`acquireLockSync`, the same primitive the continuity store and the
 * idempotency ledger use, re-reading under the lock exactly as they
 * do). Before it, two hooks crossing the compaction cap could both read
 * the file and the second rewrite could clobber the first's
 * observation. `acquireLockSync` has no retry by design; a busy lock
 * therefore DROPS the observation, and the drop is written to a gap
 * sidecar and returned as a named notice rather than vanishing.
 *
 * Compaction retains the most recent lines VERBATIM. It used to fold
 * the file to one summary line per session, which destroyed per-session
 * event history, dropped `firstSeenMs` (the summary was stamped at
 * `lastSeenMs`, so a reread saw first === last), deleted every session
 * past the retention rank, and - through a re-serializer that hard-
 * coded its field list - silently dropped any field a later writer
 * added. Verbatim retention removes all four at once, including the
 * last as a class of bug rather than an instance.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  DEGRADATION_CODE,
  type DegradationNotice,
  degradationNotice,
} from "../../integrity/degradation.ts";
import type { GitWorkspaceIdentity } from "../git/reader.ts";
import { computePayloadHash } from "../idempotency-ledger.ts";
import { BRAIN_ROOT_REL, ensureInsideVault } from "../paths.ts";
import { acquireLockSync, type LockHandle } from "../sync-lockfile.ts";
import type { SessionLineage } from "./types.ts";

/** Crutch link window: a continuation must start this close to the
 * predecessor's compression evidence. CRUTCH(t_1459706f). */
export const CRUTCH_LINK_WINDOW_MS = 900_000;

/** Compact the ledger once it holds more lines than this. */
const MAX_LEDGER_LINES = 512;
/**
 * LINES retained verbatim by a compaction rewrite - not sessions. The
 * unit changed with the fold: a summary kept one line per session and
 * lost that session's history, whereas keeping raw lines keeps history
 * and loses only the oldest of it.
 */
const RETAIN_LEDGER_LINES = 256;
/** Gap records retained; the sidecar must not grow without bound either. */
const MAX_GAP_LINES = 256;

const STATE_DIR_REL = posix.join(BRAIN_ROOT_REL, ".state");
const LEDGER_FILE = "session-lineage.jsonl";
const GAPS_FILE = "session-lineage-gaps.jsonl";

/** Site recorded on every notice this module emits. */
const LEDGER_SITE = "brain.lineage.ledger";

/** Why an observation never reached the ledger. Structural, closed. */
export const LINEAGE_GAP_REASON = Object.freeze({
  /** Another writer held the lock; `acquireLockSync` has no retry. */
  lockBusy: "writer-lock-busy",
  /** The lock could not be taken for any other reason (permissions, io). */
  lockFailed: "writer-lock-failed",
  /** The lock was held but the read-modify-write itself failed. */
  writeFailed: "write-failed",
} as const);

export type LineageGapReason = (typeof LINEAGE_GAP_REASON)[keyof typeof LINEAGE_GAP_REASON];

export const LINEAGE_RECORD_STATUS = Object.freeze({
  appended: "appended",
  dropped: "dropped",
} as const);

export type LineageRecordStatus =
  (typeof LINEAGE_RECORD_STATUS)[keyof typeof LINEAGE_RECORD_STATUS];

/**
 * Outcome of one {@link recordLineageObservation}. The function used to
 * return `void`, so a swallowed failure and a successful append were
 * indistinguishable to its caller; they no longer are.
 */
export interface LineageRecordResult {
  readonly status: LineageRecordStatus;
  /** Sequence number allocated to the appended line. */
  readonly seq?: number;
  /** True when this write also compacted the file. */
  readonly compacted?: boolean;
  /** Present only on `dropped`: the named gap. */
  readonly notice?: DegradationNotice;
}

/** One recorded gap: an observation that was never appended. */
export interface LineageGapRecord {
  readonly sessionId: string;
  readonly at: string;
  readonly event: string;
  readonly reason: string;
}

export interface LineageObservation {
  readonly sessionId: string;
  /** ISO-8601 timestamp of the observation (host clock, injected). */
  readonly at: string;
  readonly cwd?: string;
  readonly event: string;
  /** True when this event evidences a compression boundary. */
  readonly compressionEvidence?: boolean;
  /** Resolved lineage to persist alongside the observation. */
  readonly lineage?: SessionLineage;
  /**
   * Git working state the observation was made in
   * (context-integrity-gates, Unit C). Absent when the session's `cwd`
   * is not inside a repository or the bounded probe found nothing; the
   * remote is already canonicalized, so no credential reaches this
   * record.
   */
  readonly workspace?: GitWorkspaceIdentity;
}

export interface LineageLedgerEntry {
  readonly sessionId: string;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly cwd?: string;
  readonly lastEvent: string;
  /** Evidence flag of the LATEST observation (not sticky). */
  readonly compressionEvidence: boolean;
  /** Last persisted lineage for the session, if any. */
  readonly lineage?: SessionLineage;
  /**
   * Last attested git working state for the session, if any. Carried
   * forward from the newest observation that reported one, exactly as
   * `cwd` is - a probe that came back empty on one event does not erase
   * what the session already attested.
   */
  readonly workspace?: GitWorkspaceIdentity;
}

export type LineageLedgerState = ReadonlyMap<string, LineageLedgerEntry>;

export function sessionLineageLedgerPath(vault: string): string {
  return ensureInsideVault(join(vault, STATE_DIR_REL, LEDGER_FILE), vault);
}

/**
 * Sidecar holding observations that were never appended. Lives beside
 * the ledger under the same dot-directory, which is excluded from vault
 * walking and search indexing - a diagnostic must not become a note.
 */
export function sessionLineageGapsPath(vault: string): string {
  return ensureInsideVault(join(vault, STATE_DIR_REL, GAPS_FILE), vault);
}

export interface LedgerLine {
  readonly sid: string;
  readonly at: string;
  readonly cwd?: string;
  readonly event: string;
  readonly ce?: boolean;
  readonly parent?: string | null;
  readonly root?: string;
  readonly depth?: number;
  readonly src?: SessionLineage["source"];
  /** Canonical remote identity (Unit C). Never carries a credential. */
  readonly repo?: string;
  readonly branch?: string;
  readonly commit?: string;
  /** Monotonic sequence number (Unit D). Absent on pre-chain lines. */
  readonly seq?: number;
  /** Chain hash of the preceding line; `null` at a chain anchor. */
  readonly prev?: string | null;
  /** This line's chain hash. Absent on pre-chain lines. */
  readonly h?: string;
}

/** A parsed line together with the exact text it came from. */
export interface LineageLedgerLine {
  /** Verbatim source text - what compaction retains, unchanged. */
  readonly raw: string;
  readonly line: LedgerLine;
}

/** The chain-carrying fields, excluded from the body that is hashed. */
const CHAIN_FIELDS = ["seq", "prev", "h"] as const;

/**
 * The hashed body of a line: everything EXCEPT the chain fields. Built
 * by removal rather than by an allow-list, so a field a future writer
 * adds is covered by the hash automatically - the same reason
 * compaction retains raw text instead of re-serializing.
 */
function lineBody(line: LedgerLine): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(line as unknown as Record<string, unknown>) };
  for (const field of CHAIN_FIELDS) delete body[field];
  return body;
}

function chainHash(prev: string | null, seq: number, body: Record<string, unknown>): string {
  return computePayloadHash({ prev, seq, body });
}

/**
 * Recompute the chain hash a stored line SHOULD carry. A line whose
 * recorded `h` differs from this was edited after it was written.
 */
export function lineageChainHash(line: LedgerLine): string {
  return chainHash(line.prev ?? null, typeof line.seq === "number" ? line.seq : 0, lineBody(line));
}

/** True when a line carries a usable chain link. */
export function isChainedLine(line: LedgerLine): boolean {
  return (
    typeof line.h === "string" &&
    line.h.length > 0 &&
    typeof line.seq === "number" &&
    Number.isInteger(line.seq) &&
    line.seq > 0
  );
}

/**
 * Project a workspace identity onto its line fields, omitting the ones
 * git could not attest. A key that is absent means "not attested" - the
 * distinction the fail-closed match predicate turns on.
 */
function workspaceFields(
  workspace: GitWorkspaceIdentity | undefined,
): Pick<LedgerLine, "repo" | "branch" | "commit"> {
  if (workspace === undefined) return {};
  return {
    ...(workspace.repo !== null ? { repo: workspace.repo } : {}),
    ...(workspace.branch !== null ? { branch: workspace.branch } : {}),
    ...(workspace.commit !== null ? { commit: workspace.commit } : {}),
  };
}

/** Inverse of {@link workspaceFields}; `undefined` when nothing was attested. */
function readWorkspace(line: LedgerLine): GitWorkspaceIdentity | undefined {
  const repo = typeof line.repo === "string" ? line.repo : null;
  const branch = typeof line.branch === "string" ? line.branch : null;
  const commit = typeof line.commit === "string" ? line.commit : null;
  if (repo === null && branch === null && commit === null) return undefined;
  return Object.freeze({ repo, branch, commit });
}

function toLine(obs: LineageObservation): LedgerLine {
  return {
    sid: obs.sessionId,
    at: obs.at,
    ...(obs.cwd !== undefined ? { cwd: obs.cwd } : {}),
    event: obs.event,
    ...(obs.compressionEvidence === true ? { ce: true } : {}),
    ...(obs.lineage !== undefined
      ? {
          parent: obs.lineage.parentId,
          root: obs.lineage.rootId,
          depth: obs.lineage.depth,
          src: obs.lineage.source,
        }
      : {}),
    ...workspaceFields(obs.workspace),
  };
}

/**
 * Parse the file into lines, KEEPING the source text of each. The raw
 * text is what compaction writes back, which is how a field this
 * version does not know about survives a rewrite.
 */
function readLedgerLines(raw: string): LineageLedgerLine[] {
  const out: LineageLedgerLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      const candidate = parsed as LedgerLine;
      if (typeof candidate.sid !== "string" || typeof candidate.at !== "string") continue;
      out.push({ raw: trimmed, line: candidate });
    } catch {
      // Fail-soft: a corrupt line never poisons the ledger.
    }
  }
  return out;
}

/**
 * Read the ledger as parsed lines in file order. Fail-soft like every
 * other read here: an unreadable file yields an empty array. Exposed
 * for `verify.ts`, which needs line order and the chain fields that
 * per-session state folds away.
 */
export function readLineageLedgerLines(vault: string): LineageLedgerLine[] {
  try {
    const path = sessionLineageLedgerPath(vault);
    if (!existsSync(path)) return [];
    return readLedgerLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/** Read the recorded gaps. Fail-soft; a missing sidecar reads as none. */
export function readLineageGaps(vault: string): LineageGapRecord[] {
  const out: LineageGapRecord[] = [];
  try {
    const path = sessionLineageGapsPath(vault);
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed["sid"] !== "string") continue;
        out.push({
          sessionId: parsed["sid"],
          at: typeof parsed["at"] === "string" ? parsed["at"] : "",
          event: typeof parsed["event"] === "string" ? parsed["event"] : "unknown",
          reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "unknown",
        });
      } catch {
        // A corrupt gap line is itself a gap we cannot name; skip it.
      }
    }
  } catch {
    // Fail-soft.
  }
  return out;
}

function buildState(lines: ReadonlyArray<LedgerLine>): Map<string, LineageLedgerEntry> {
  const state = new Map<string, LineageLedgerEntry>();
  for (const line of lines) {
    const atMs = Date.parse(line.at);
    if (!Number.isFinite(atMs)) continue;
    const prev = state.get(line.sid);
    const lineage: SessionLineage | undefined =
      typeof line.root === "string" && line.src !== undefined
        ? Object.freeze({
            rootId: line.root,
            parentId: line.parent ?? null,
            depth: typeof line.depth === "number" ? line.depth : 0,
            source: line.src,
          })
        : prev?.lineage;
    const workspace = readWorkspace(line) ?? prev?.workspace;
    state.set(line.sid, {
      sessionId: line.sid,
      firstSeenMs: prev === undefined ? atMs : Math.min(prev.firstSeenMs, atMs),
      lastSeenMs: prev === undefined ? atMs : Math.max(prev.lastSeenMs, atMs),
      ...(line.cwd !== undefined
        ? { cwd: line.cwd }
        : prev?.cwd !== undefined
          ? { cwd: prev.cwd }
          : {}),
      lastEvent: line.event ?? prev?.lastEvent ?? "unknown",
      compressionEvidence: line.ce === true,
      ...(lineage !== undefined ? { lineage } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    });
  }
  return state;
}

/**
 * Read the ledger into per-session state. Missing file reads empty.
 *
 * Deliberately does NOT verify the chain. The catch-to-empty-map below
 * is load-bearing for `resolveRootId` in the anticipatory cache and for
 * the lifecycle hook, both of which treat "no lineage" as a normal
 * state and neither of which can handle a throw. Integrity findings
 * belong to `verify.ts`, which reports them to the doctor.
 */
export function readLineageLedger(vault: string): LineageLedgerState {
  const path = sessionLineageLedgerPath(vault);
  if (!existsSync(path)) return new Map();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  return buildState(readLedgerLines(raw).map((entry) => entry.line));
}

/**
 * Append one observation under the writer lock, compacting the file
 * (atomic rewrite keeping the most recent lines verbatim) once it
 * crosses the line cap.
 *
 * Fail-soft by contract: nothing here throws into a lifecycle hook. But
 * a failure is no longer SILENT - a dropped observation is written to
 * the gap sidecar and returned as a named notice, so the absence is
 * attributable instead of being indistinguishable from a session that
 * simply never spoke.
 */
export function recordLineageObservation(
  vault: string,
  obs: LineageObservation,
): LineageRecordResult {
  let handle: LockHandle | undefined;
  try {
    const path = sessionLineageLedgerPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    try {
      handle = acquireLockSync(path);
    } catch (err) {
      // No retry, by the lock's design: a loud named gap beats a silent
      // retry loop that still fails. The gap is exactly what the
      // sequence numbers above would otherwise leave unexplained.
      return recordGap(
        vault,
        obs,
        (err as NodeJS.ErrnoException).code === "ELOCKED"
          ? LINEAGE_GAP_REASON.lockBusy
          : LINEAGE_GAP_REASON.lockFailed,
      );
    }

    // Re-read UNDER the lock, exactly as the idempotency ledger does:
    // the chain head and the next sequence number must come from the
    // file as it is now, not as it was before the lock was taken.
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const entries = readLedgerLines(existing);
    const body = toLine(obs);
    const { seq, prev } = nextChainPosition(entries);
    const line: LedgerLine = {
      ...body,
      seq,
      prev,
      h: chainHash(prev, seq, body as unknown as Record<string, unknown>),
    };
    const serialized = JSON.stringify(line);

    if (entries.length + 1 > MAX_LEDGER_LINES) {
      // Verbatim retention: raw source text, never a re-serialization.
      // Retained lines keep their own sequence numbers and chain links,
      // so the chain stays contiguous across the truncation.
      const retained = entries.slice(-RETAIN_LEDGER_LINES).map((entry) => entry.raw);
      retained.push(serialized);
      atomicWriteFileSync(path, `${retained.join("\n")}\n`);
      return { status: LINEAGE_RECORD_STATUS.appended, seq, compacted: true };
    }
    appendFileSync(path, `${serialized}\n`, "utf8");
    return { status: LINEAGE_RECORD_STATUS.appended, seq };
  } catch {
    return recordGap(vault, obs, LINEAGE_GAP_REASON.writeFailed);
  } finally {
    handle?.release();
  }
}

/**
 * Sequence number and chain link for the next line. Sequence numbers
 * continue from the last CHAINED line, so a compacted file keeps
 * counting from where its retained head left off, and a pre-chain
 * ledger starts a fresh chain at 1 with a null anchor.
 */
function nextChainPosition(entries: ReadonlyArray<LineageLedgerLine>): {
  seq: number;
  prev: string | null;
} {
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = entries[index]!.line;
    if (!isChainedLine(line)) continue;
    return { seq: line.seq! + 1, prev: line.h! };
  }
  return { seq: 1, prev: null };
}

/**
 * Record an observation that never reached the ledger. Best-effort and
 * itself fail-soft: if even the sidecar cannot be written, the returned
 * notice is the only trace, which is still strictly more than the
 * nothing this path used to leave.
 */
function recordGap(
  vault: string,
  obs: LineageObservation,
  reason: LineageGapReason,
): LineageRecordResult {
  const notice = degradationNotice({
    code: DEGRADATION_CODE.lineageObservationDropped,
    site: LEDGER_SITE,
    detail:
      `observation for session ${obs.sessionId} (event ${obs.event}) ` +
      `was not appended: ${reason}`,
  });
  try {
    const path = sessionLineageGapsPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    const record: Record<string, unknown> = {
      sid: obs.sessionId,
      at: obs.at,
      event: obs.event,
      reason,
    };
    // O_APPEND: concurrent gap writers cannot interleave a short line.
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    boundGapSidecar(path);
  } catch {
    // The gap could not be persisted; the notice still names it.
  }
  return { status: LINEAGE_RECORD_STATUS.dropped, notice };
}

/**
 * Keep the gap sidecar bounded. Takes the sidecar's OWN lock (never the
 * ledger's, so this cannot deadlock against the writer that called it)
 * and skips the trim entirely when that lock is busy - an oversized
 * sidecar is a better outcome than a lost gap record.
 */
function boundGapSidecar(path: string): void {
  let handle: LockHandle | undefined;
  try {
    if (countLines(readFileSync(path, "utf8")) <= MAX_GAP_LINES) return;
    handle = acquireLockSync(path);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    if (lines.length <= MAX_GAP_LINES) return;
    atomicWriteFileSync(path, `${lines.slice(-MAX_GAP_LINES).join("\n")}\n`);
  } catch {
    // Best-effort.
  } finally {
    handle?.release();
  }
}

function countLines(raw: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}
