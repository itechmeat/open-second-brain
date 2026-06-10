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
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { BRAIN_ROOT_REL, ensureInsideVault } from "../paths.ts";
import type { SessionLineage } from "./types.ts";

/** Crutch link window: a continuation must start this close to the
 * predecessor's compression evidence. CRUTCH(t_1459706f). */
export const CRUTCH_LINK_WINDOW_MS = 900_000;

/** Compact the ledger once it holds more lines than this. */
const MAX_LEDGER_LINES = 512;
/** Sessions retained (most recent first) by a compaction rewrite. */
const RETAIN_SESSIONS = 256;

const STATE_DIR_REL = posix.join(BRAIN_ROOT_REL, ".state");
const LEDGER_FILE = "session-lineage.jsonl";

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
}

export type LineageLedgerState = ReadonlyMap<string, LineageLedgerEntry>;

export function sessionLineageLedgerPath(vault: string): string {
  return ensureInsideVault(join(vault, STATE_DIR_REL, LEDGER_FILE), vault);
}

interface LedgerLine {
  readonly sid: string;
  readonly at: string;
  readonly cwd?: string;
  readonly event: string;
  readonly ce?: boolean;
  readonly parent?: string | null;
  readonly root?: string;
  readonly depth?: number;
  readonly src?: SessionLineage["source"];
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
  };
}

function parseLines(raw: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      const candidate = parsed as LedgerLine;
      if (typeof candidate.sid !== "string" || typeof candidate.at !== "string") continue;
      out.push(candidate);
    } catch {
      // Fail-soft: a corrupt line never poisons the ledger.
    }
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
    });
  }
  return state;
}

/** Read the ledger into per-session state. Missing file reads empty. */
export function readLineageLedger(vault: string): LineageLedgerState {
  const path = sessionLineageLedgerPath(vault);
  if (!existsSync(path)) return new Map();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  return buildState(parseLines(raw));
}

/**
 * Append one observation; compact the file (atomic rewrite keeping the
 * most recent sessions) once it crosses the line cap. Fail-soft: any
 * filesystem error is swallowed - lineage is an enhancement, never a
 * capture blocker.
 */
export function recordLineageObservation(vault: string, obs: LineageObservation): void {
  try {
    const path = sessionLineageLedgerPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    const serialized = `${JSON.stringify(toLine(obs))}\n`;
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = parseLines(existing);
    if (lines.length + 1 > MAX_LEDGER_LINES) {
      lines.push(toLine(obs));
      const state = buildState(lines);
      const retained = [...state.values()]
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
        .slice(0, RETAIN_SESSIONS);
      // One summary line per retained session, oldest first so a
      // future append keeps chronological order readable.
      retained.reverse();
      const compacted = retained
        .map((entry) =>
          JSON.stringify({
            sid: entry.sessionId,
            at: new Date(entry.lastSeenMs).toISOString(),
            ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
            event: entry.lastEvent,
            ...(entry.compressionEvidence ? { ce: true } : {}),
            ...(entry.lineage !== undefined
              ? {
                  parent: entry.lineage.parentId,
                  root: entry.lineage.rootId,
                  depth: entry.lineage.depth,
                  src: entry.lineage.source,
                }
              : {}),
          }),
        )
        .join("\n");
      atomicWriteFileSync(path, `${compacted}\n`);
      return;
    }
    appendFileSync(path, serialized, "utf8");
  } catch {
    // Fail-soft by contract.
  }
}
