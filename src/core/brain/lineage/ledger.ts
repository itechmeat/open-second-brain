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
 * (atomic rewrite) once it grows past the line cap. Skipped lines are
 * COUNTED and returned ({@link scanLineageLedger}) rather than merely
 * dropped - fail-soft for the resolver, reportable for the verifier.
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
 *
 * ## Declared work identity (signals-that-survive, Unit 9)
 *
 * A line may also carry a DECLARED work id and lane id (`wid` / `lane`),
 * sourced at the capture boundary by `identity.ts` and never derived
 * here. They are the durable half of continuation: the crutch's freshness
 * window expires, a work id does not. Both are optional and are omitted
 * when blank, so a ledger written by a host that declares nothing is
 * byte-identical to the one this module wrote before they existed - and
 * because the hash covers the line body by REMOVAL of the chain fields,
 * they ride the integrity chain without any change to it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
import { assertVaultIdentityForWrite, VaultIdentityMismatchError } from "../vault-identity.ts";
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
/**
 * How long a recorded gap keeps being reported.
 *
 * Without an aging policy one burst of writer contention makes
 * `verifyLineageLedger().ok` false forever and re-emits the same notices
 * on every doctor run, which trains an operator to ignore the stream the
 * whole unit exists to populate. A gap is a point-in-time observation,
 * not a standing defect, so it expires.
 */
const GAP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Age at which the SIDECAR's OWN trim lock is treated as abandoned.
 *
 * This is a breaker for one lock and one operation, and it is scoped
 * that narrowly on purpose. The ledger's writer lock never gets one: no
 * timeout can distinguish a crashed writer from a slow live one, and
 * killing a live writer's lock corrupts the file it protects. The trim
 * is different in kind - it is idempotent (keep the newest N records),
 * it protects diagnostics rather than the ledger, and the alternative is
 * that one crash inside the trim window disables the bound permanently.
 */
const GAP_LOCK_STALE_MS = 60_000;

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
  /** The OBSERVATION's timestamp, as the caller reported it. */
  readonly at: string;
  /**
   * When the gap itself was written, on the recording process's clock.
   *
   * Distinct from {@link at} on purpose: `at` is host-supplied and can
   * name any instant (an imported transcript backfills months-old
   * events), so aging on it would expire a gap recorded seconds ago.
   * Empty only for a record written before this field existed, which
   * then ages on `at` as the best available evidence.
   */
  readonly recordedAt: string;
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
  /**
   * DECLARED work identity for this observation (signals-that-survive,
   * Unit 9). Never derived - see `identity.ts` for the three rungs it is
   * sourced from. Absent when nothing declared one, which is why every
   * pre-existing line is byte-identical.
   */
  readonly workId?: string;
  /** DECLARED lane. A hard separator between work items, never a tiebreak. */
  readonly laneId?: string;
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
  /**
   * Last declared work identity for the session, carried forward from
   * the newest observation that declared one - for the same reason
   * `cwd` and `workspace` are: an event that arrived without the
   * declaration does not retract it.
   */
  readonly workId?: string;
  /** Last declared lane for the session. See {@link LineageObservation.laneId}. */
  readonly laneId?: string;
}

export type LineageLedgerState = ReadonlyMap<string, LineageLedgerEntry>;

/**
 * The Brain state directory: the dot-directory this module's ledger, its
 * gap sidecar and the work-identity markers all live under. Exported so
 * a sibling state file resolves through one definition rather than
 * re-deriving the relative path.
 */
export function brainStateDirPath(vault: string): string {
  return ensureInsideVault(join(vault, STATE_DIR_REL), vault);
}

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
  /** Declared work id (Unit 9). Absent unless a rung declared one. */
  readonly wid?: string;
  /** Declared lane id (Unit 9). Absent unless a rung declared one. */
  readonly lane?: string;
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

/**
 * Project a declared work identity onto its line fields (Unit 9). A
 * blank declaration is not a declaration: it is omitted, so a host that
 * sends an empty string leaves the line byte-identical to one that sent
 * nothing at all.
 */
function identityFields(
  workId: string | undefined,
  laneId: string | undefined,
): Pick<LedgerLine, "wid" | "lane"> {
  const wid = declared(workId);
  const lane = declared(laneId);
  return {
    ...(wid !== undefined ? { wid } : {}),
    ...(lane !== undefined ? { lane } : {}),
  };
}

/** A trimmed non-empty declaration, or `undefined`. */
function declared(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
    ...identityFields(obs.workId, obs.laneId),
  };
}

/** What one parse of the ledger text found, including what it could not use. */
interface ParsedLedger {
  readonly lines: LineageLedgerLine[];
  /**
   * 1-based file positions of the non-blank lines that are not a usable
   * ledger record. Recorded rather than discarded: dropping them
   * silently is what let a wholly destroyed ledger verify as clean, and
   * the position is what makes one addressable.
   */
  readonly skippedLineNumbers: number[];
}

/**
 * Parse the file into lines, KEEPING the source text of each. The raw
 * text is what compaction writes back, which is how a field this
 * version does not know about survives a rewrite.
 */
function readLedgerLines(raw: string): ParsedLedger {
  const lines: LineageLedgerLine[] = [];
  const skippedLineNumbers: number[] = [];
  const source = raw.split("\n");
  for (let index = 0; index < source.length; index++) {
    const trimmed = source[index]!.trim();
    if (trimmed.length === 0) continue;
    const lineNumber = index + 1;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        skippedLineNumbers.push(lineNumber);
        continue;
      }
      const candidate = parsed as LedgerLine;
      if (typeof candidate.sid !== "string" || typeof candidate.at !== "string") {
        skippedLineNumbers.push(lineNumber);
        continue;
      }
      lines.push({ raw: trimmed, line: candidate });
    } catch {
      // Fail-soft for the READ path, recorded for the VERIFIER: a corrupt
      // line never poisons resolution, and never passes unreported.
      skippedLineNumbers.push(lineNumber);
    }
  }
  return { lines, skippedLineNumbers };
}

/**
 * One read of the ledger file, with the three states the old
 * `LineageLedgerLine[]` return collapsed into an empty array: the file
 * is absent, the file is present but could not be read, or the file was
 * read and some of it was not usable.
 */
export interface LineageLedgerScan {
  /** The ledger file exists on disk. */
  readonly exists: boolean;
  /** The file's bytes were obtained. False for an absent or unreadable file. */
  readonly readable: boolean;
  /** Usable records, in file order. */
  readonly lines: ReadonlyArray<LineageLedgerLine>;
  /** 1-based positions of the non-blank lines that could not be read. */
  readonly skippedLineNumbers: ReadonlyArray<number>;
}

/**
 * Read the ledger as parsed lines in file order, reporting what it could
 * not use. Fail-soft like every other read here - it never throws, and
 * an unreadable file yields no lines - but the caller can now tell an
 * absent ledger from a destroyed one. Exposed for `verify.ts`, which
 * needs line order and the chain fields that per-session state folds
 * away.
 */
export function scanLineageLedger(vault: string): LineageLedgerScan {
  const absent = Object.freeze({
    exists: false,
    readable: false,
    lines: Object.freeze([]),
    skippedLineNumbers: Object.freeze([]),
  });
  let path: string;
  try {
    path = sessionLineageLedgerPath(vault);
  } catch {
    return absent;
  }
  if (!existsSync(path)) return absent;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return Object.freeze({
      exists: true,
      readable: false,
      lines: Object.freeze([]),
      skippedLineNumbers: Object.freeze([]),
    });
  }
  const parsed = readLedgerLines(raw);
  return Object.freeze({
    exists: true,
    readable: true,
    lines: Object.freeze(parsed.lines),
    skippedLineNumbers: Object.freeze(parsed.skippedLineNumbers),
  });
}

/** The sidecar as a whole: what it still lists, and what it no longer can. */
export interface LineageGapReport {
  /** The sidecar file exists on disk. */
  readonly exists: boolean;
  /** Gap records still within the retention window, oldest first. */
  readonly records: ReadonlyArray<LineageGapRecord>;
  /**
   * Records the sidecar's bound discarded. They are COUNTED, never
   * listed, so a capped listing is never mistaken for a complete one.
   */
  readonly discarded: number;
  /** True when `discarded > 0`: {@link records} is a suffix, not the whole. */
  readonly truncated: boolean;
  /** Dropped observations still on the record: listed plus discarded. */
  readonly total: number;
}

export interface ReadLineageGapsOptions {
  /** Injected clock (epoch ms) for the retention window. */
  readonly nowMs?: number;
}

/** One line of the sidecar: either a gap record or the truncation marker. */
interface ParsedGapFile {
  readonly records: LineageGapRecord[];
  /** Records earlier trims discarded, from the accumulator line. */
  readonly discarded: number;
  /** When the accumulator was last written; `null` when there is none. */
  readonly discardedAt: string | null;
  /** Records this parse dropped because they fell outside retention. */
  readonly aged: number;
}

/** Key that distinguishes the accumulator line from a gap record. */
const GAP_DISCARDED_KEY = "discarded";
/** Key carrying {@link LineageGapRecord.recordedAt} on the wire. */
const GAP_RECORDED_AT_KEY = "rat";

function parseGapFile(raw: string, nowMs: number): ParsedGapFile {
  const records: LineageGapRecord[] = [];
  let discarded = 0;
  let discardedAt: string | null = null;
  let aged = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A corrupt gap line is itself a gap we cannot name; skip it.
      continue;
    }
    const count = parsed[GAP_DISCARDED_KEY];
    if (typeof count === "number" && Number.isFinite(count)) {
      const at = typeof parsed["at"] === "string" ? parsed["at"] : "";
      if (!isExpired(at, nowMs)) {
        discarded += Math.max(0, Math.trunc(count));
        discardedAt = at;
      }
      continue;
    }
    if (typeof parsed["sid"] !== "string") continue;
    const at = typeof parsed["at"] === "string" ? parsed["at"] : "";
    const recordedAt = typeof parsed[GAP_RECORDED_AT_KEY] === "string" ? parsed["rat"] : "";
    if (isExpired(recordedAt.length > 0 ? recordedAt : at, nowMs)) {
      aged++;
      continue;
    }
    records.push({
      sessionId: parsed["sid"],
      at,
      recordedAt,
      event: typeof parsed["event"] === "string" ? parsed["event"] : "unknown",
      reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "unknown",
    });
  }
  return { records, discarded, discardedAt, aged };
}

/**
 * The on-disk form of one gap record. Written by the append AND by the
 * trim's rewrite, so a trimmed sidecar is byte-comparable with a
 * freshly appended one and no field is lost in the round trip.
 */
function gapLine(record: LineageGapRecord): Record<string, unknown> {
  return {
    sid: record.sessionId,
    at: record.at,
    ...(record.recordedAt.length > 0 ? { [GAP_RECORDED_AT_KEY]: record.recordedAt } : {}),
    event: record.event,
    reason: record.reason,
  };
}

/**
 * True when a recorded instant is older than the retention window. An
 * undatable record never expires: aging out something whose age is
 * unknown would be a guess, and this module reports rather than guesses.
 */
function isExpired(at: string, nowMs: number): boolean {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms > GAP_RETENTION_MS;
}

/**
 * Read the sidecar. Fail-soft; a missing sidecar reads as none.
 * Records older than {@link GAP_RETENTION_MS} are omitted here as well as
 * pruned on the next trim, so a vault that has stopped dropping
 * observations stops reporting them even if nothing writes again.
 */
export function readLineageGapReport(
  vault: string,
  opts: ReadLineageGapsOptions = {},
): LineageGapReport {
  const nowMs = opts.nowMs ?? Date.now();
  const empty = Object.freeze({
    exists: false,
    records: Object.freeze([]),
    discarded: 0,
    truncated: false,
    total: 0,
  });
  let raw: string;
  try {
    const path = sessionLineageGapsPath(vault);
    if (!existsSync(path)) return empty;
    raw = readFileSync(path, "utf8");
  } catch {
    return empty;
  }
  const parsed = parseGapFile(raw, nowMs);
  return Object.freeze({
    exists: true,
    records: Object.freeze(parsed.records),
    discarded: parsed.discarded,
    truncated: parsed.discarded > 0,
    total: parsed.records.length + parsed.discarded,
  });
}

/** The listed gap records. See {@link readLineageGapReport} for the rest. */
export function readLineageGaps(
  vault: string,
  opts: ReadLineageGapsOptions = {},
): ReadonlyArray<LineageGapRecord> {
  return readLineageGapReport(vault, opts).records;
}

/**
 * Session ids that spoke but whose observation never reached the ledger.
 *
 * This is the OTHER half of "does this session have history of its own".
 * The crutch's Rule 1 reads the ledger for the session's own line and
 * treats its absence as proof of a brand-new session; a writer-lock drop
 * removes exactly that line, so without this set a session that DID
 * speak looks new and can be stitched onto an unrelated parallel one.
 * Fail-soft like every read here.
 */
export function lineageGapSessionIds(vault: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const gap of readLineageGaps(vault)) ids.add(gap.sessionId);
  return ids;
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
    const workId = declared(line.wid) ?? prev?.workId;
    const laneId = declared(line.lane) ?? prev?.laneId;
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
      ...(workId !== undefined ? { workId } : {}),
      ...(laneId !== undefined ? { laneId } : {}),
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
  return buildState(scanLineageLedger(vault).lines.map((entry) => entry.line));
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
  // Vault-identity write guard (Unit J), AHEAD OF THE FIRST BYTE: the
  // `mkdirSync` below materializes `Brain/.state/` under whatever root
  // it is handed, so asserting after it would refuse a store this
  // function had already created. A refusal is returned as a named drop,
  // never thrown, and deliberately does NOT reach the gap sidecar -
  // writing the diagnostic into the wrong vault is the very thing the
  // guard just refused.
  try {
    assertVaultIdentityForWrite(vault);
  } catch (err) {
    return {
      status: LINEAGE_RECORD_STATUS.dropped,
      notice:
        err instanceof VaultIdentityMismatchError
          ? err.notice
          : degradationNotice({
              code: DEGRADATION_CODE.vaultMarkerMismatch,
              site: LEDGER_SITE,
              detail:
                `observation for session ${obs.sessionId} (event ${obs.event}) ` +
                "was not appended: the vault write guard refused this root",
            }),
    };
  }

  let handle: LockHandle | undefined;
  try {
    const path = sessionLineageLedgerPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    try {
      handle = acquireLockSync(path);
    } catch (err) {
      // No retry, by the lock's design: a loud named gap beats a silent
      // retry loop that still fails. The gap is exactly what the
      // sequence numbers above would otherwise leave unexplained. The
      // lock file is NAMED on the notice: a lock left behind by a
      // SIGKILLed writer disables capture for the life of the vault, and
      // an operator cannot remove a file the diagnostic never mentions.
      const errno = err as NodeJS.ErrnoException;
      return recordGap(
        vault,
        obs,
        errno.code === "ELOCKED" ? LINEAGE_GAP_REASON.lockBusy : LINEAGE_GAP_REASON.lockFailed,
        typeof errno.path === "string" ? errno.path : undefined,
      );
    }

    // Re-read UNDER the lock, exactly as the idempotency ledger does:
    // the chain head and the next sequence number must come from the
    // file as it is now, not as it was before the lock was taken.
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const entries = readLedgerLines(existing).lines;
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
  lockPath?: string,
): LineageRecordResult {
  const notice = degradationNotice({
    code: DEGRADATION_CODE.lineageObservationDropped,
    site: LEDGER_SITE,
    ...(lockPath !== undefined ? { path: lockPath } : {}),
    detail:
      `observation for session ${obs.sessionId} (event ${obs.event}) ` +
      `was not appended: ${reason}` +
      (lockPath !== undefined ? `; the lock is held at ${lockPath}` : ""),
  });
  try {
    const path = sessionLineageGapsPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    const nowMs = Date.now();
    // O_APPEND: concurrent gap writers cannot interleave a short line.
    appendFileSync(
      path,
      `${JSON.stringify(gapLine({ sessionId: obs.sessionId, at: obs.at, recordedAt: new Date(nowMs).toISOString(), event: obs.event, reason }))}\n`,
      "utf8",
    );
    boundGapSidecar(path, nowMs);
  } catch {
    // The gap could not be persisted; the notice still names it.
  }
  return { status: LINEAGE_RECORD_STATUS.dropped, notice };
}

/**
 * Keep the gap sidecar bounded, aged, and HONEST about the difference.
 *
 * Three properties, each of which was previously absent:
 *
 *   - the bound always applies. The trim takes the sidecar's OWN lock
 *     (never the ledger's, so it cannot deadlock against the writer that
 *     called it) and reclaims that lock once it is older than
 *     {@link GAP_LOCK_STALE_MS} - otherwise one crash inside the trim
 *     window leaves a lock nothing ever removes and the bound stops
 *     existing for the life of the vault;
 *   - records past {@link GAP_RETENTION_MS} are pruned, so a burst of
 *     contention stops being reported instead of pinning the verifier's
 *     verdict to `false` permanently;
 *   - every record the bound removes is ADDED TO AN ACCUMULATOR, so 400
 *     drops are never presented as the 256 that happen to still be
 *     listed.
 */
function boundGapSidecar(path: string, nowMs: number): void {
  let handle: LockHandle | undefined;
  try {
    const before = parseGapFile(readFileSync(path, "utf8"), nowMs);
    if (before.records.length <= MAX_GAP_LINES && before.aged === 0) return;
    handle = acquireGapLock(path, nowMs);
    // Re-read under the lock: another writer may have appended, and the
    // count that decides the trim must be the current one.
    const current = parseGapFile(readFileSync(path, "utf8"), nowMs);
    const kept = current.records.slice(-MAX_GAP_LINES);
    const discarded = current.discarded + (current.records.length - kept.length);
    const lines: string[] = [];
    if (discarded > 0) {
      lines.push(
        JSON.stringify({ [GAP_DISCARDED_KEY]: discarded, at: new Date(nowMs).toISOString() }),
      );
    }
    for (const record of kept) lines.push(JSON.stringify(gapLine(record)));
    atomicWriteFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  } catch {
    // Best-effort: the sidecar is diagnostics, and a failed trim must
    // never propagate into the capture path that recorded the gap.
  } finally {
    handle?.release();
  }
}

/**
 * Take the sidecar's trim lock, reclaiming it once when it is provably
 * abandoned. Scoped to this one lock and this one idempotent operation -
 * see {@link GAP_LOCK_STALE_MS} for why the ledger's writer lock gets no
 * such treatment.
 */
function acquireGapLock(path: string, nowMs: number): LockHandle {
  try {
    return acquireLockSync(path);
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code !== "ELOCKED") throw err;
    const lockPath = typeof errno.path === "string" ? errno.path : `${path}.lock`;
    if (nowMs - statSync(lockPath).mtimeMs <= GAP_LOCK_STALE_MS) throw err;
    unlinkSync(lockPath);
    // Exactly one retry. A second ELOCKED means a live writer took the
    // lock in between, which is contention rather than abandonment.
    return acquireLockSync(path);
  }
}
