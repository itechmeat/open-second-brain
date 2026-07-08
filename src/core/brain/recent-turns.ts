/**
 * Bounded verbatim last-N-turns buffer (C3 / t_92317f91).
 *
 * Short-term continuity scaffolding — NOT curated long-term memory. After a
 * host compaction, OSB retains only summarized/extracted forms (active.md,
 * pre-compact extract, session summary); the exact recent wording is lost.
 * This buffer keeps a small, strictly-bounded ring of the last N conversation
 * turns verbatim so the agent can recover "what did the user literally say
 * 2-3 turns ago" immediately post-compaction.
 *
 * Design choices that keep it from becoming verbatim hoarding:
 *   - Its OWN continuity kind (`recent_turn`) and its OWN reader — it never
 *     leaks into the curated preference/signal/provenance surfaces.
 *   - A hard read cap `RECENT_TURNS_CAP` (default 20): the observable buffer
 *     never exceeds N turns. The continuity log is append-only by invariant
 *     (`store.ts`: files are never rewritten/migrated), so eviction is a
 *     bounded READ VIEW over the newest N — the older `recent_turn` rows share
 *     the continuity log's existing retention lifecycle rather than being
 *     rewritten in place. This is stated plainly, not disguised as a delete.
 *   - Per-turn verbatim text is truncated to `MAX_TURN_CHARS`, so no single
 *     row can grow without bound.
 *
 * Post-compaction re-surface is opt-in (default off → nothing surfaced), so an
 * unchanged install's context is byte-identical.
 */

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";

/**
 * Hard cap on the observable buffer size (N). The last N turns are kept; a
 * read never returns more than this many, regardless of the requested limit.
 */
export const RECENT_TURNS_CAP = 20;

/** Per-turn verbatim text ceiling — bounds each stored row (no hoarding). */
export const MAX_TURN_CHARS = 8_000;

export interface RecentTurnInput {
  /** Speaker role, e.g. `user` | `assistant` (free-form, host-defined). */
  readonly role: string;
  /** Verbatim turn text. Truncated to {@link MAX_TURN_CHARS} on store. */
  readonly text: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  /** Canonical UTC ISO-8601 timestamp; defaults to now when absent. */
  readonly createdAt?: string;
}

export interface RecentTurn {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly seq: number;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface ListRecentTurnsOptions {
  /** Max turns to return; clamped to [1, {@link RECENT_TURNS_CAP}]. */
  readonly limit?: number;
}

export interface ResurfaceOptions {
  /**
   * Opt-in gate. Default/absent → OFF: {@link resurfaceRecentTurns} returns
   * null and nothing is added to the post-compaction context (byte-identical).
   */
  readonly enabled?: boolean;
  /** Max turns to surface; clamped like {@link ListRecentTurnsOptions.limit}. */
  readonly limit?: number;
}

/**
 * Append one verbatim turn to the bounded buffer. The turn is persisted as a
 * `recent_turn` continuity record. A monotonic `seq` (the count of existing
 * `recent_turn` rows) stamps insertion order so same-timestamp turns keep a
 * deterministic, stable order on read.
 */
export function appendRecentTurn(vault: string, input: RecentTurnInput): ContinuityRecord {
  const seq = listContinuityRecords(vault, { kind: "recent_turn" }).length;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const text = input.text.slice(0, MAX_TURN_CHARS);
  const sourceRefs: ContinuitySourceRef[] = [];
  if (input.sessionId !== undefined && input.sessionId.length > 0) {
    sourceRefs.push({ id: input.sessionId, kind: "session" });
  }
  return appendContinuityRecord(vault, {
    kind: "recent_turn",
    createdAt,
    sourceRefs,
    payload: {
      role: input.role,
      text,
      seq,
      ...(input.sessionId !== undefined && input.sessionId.length > 0
        ? { session_id: input.sessionId }
        : {}),
      ...(input.turnId !== undefined && input.turnId.length > 0 ? { turn_id: input.turnId } : {}),
      truncated: text.length < input.text.length,
    },
  });
}

/**
 * Read the newest turns in chronological order (oldest → newest). Never
 * returns more than {@link RECENT_TURNS_CAP}; the older overflow is evicted
 * from this view (the hard cap). Reads only the `recent_turn` kind — the
 * buffer is isolated from every curated surface.
 */
export function listRecentTurns(vault: string, opts: ListRecentTurnsOptions = {}): RecentTurn[] {
  const requested = opts.limit ?? RECENT_TURNS_CAP;
  const limit = Math.max(1, Math.min(RECENT_TURNS_CAP, Math.floor(requested)));
  const turns = listContinuityRecords(vault, { kind: "recent_turn" })
    .map(toRecentTurn)
    .filter((turn): turn is RecentTurn => turn !== null)
    .toSorted(compareTurns);
  return turns.slice(Math.max(0, turns.length - limit));
}

/**
 * Optional post-compaction re-surface. Returns a formatted verbatim block of
 * the recent buffer ONLY when opted in AND the buffer is non-empty; otherwise
 * null (nothing surfaced → byte-identical context). Callers gate `enabled`
 * with the `recent_turns_resurface` config flag (default off).
 */
export function resurfaceRecentTurns(vault: string, opts: ResurfaceOptions = {}): string | null {
  if (opts.enabled !== true) return null;
  const turns = listRecentTurns(vault, opts.limit !== undefined ? { limit: opts.limit } : {});
  if (turns.length === 0) return null;
  const lines = turns.map((turn) => `- **${turn.role}**: ${turn.text}`);
  return [`## Recent turns (verbatim, last ${turns.length})`, ...lines].join("\n");
}

function toRecentTurn(record: ContinuityRecord): RecentTurn | null {
  const payload = record.payload;
  const role = payload["role"];
  const text = payload["text"];
  if (typeof role !== "string" || typeof text !== "string") return null;
  const seq = typeof payload["seq"] === "number" ? payload["seq"] : 0;
  const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : undefined;
  const turnId = typeof payload["turn_id"] === "string" ? payload["turn_id"] : undefined;
  return {
    role,
    text,
    createdAt: record.createdAt,
    seq,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

/** Deterministic chronological order: seq (insertion), then timestamp. */
function compareTurns(a: RecentTurn, b: RecentTurn): number {
  return a.seq - b.seq || a.createdAt.localeCompare(b.createdAt);
}
