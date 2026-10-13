/**
 * The per-source-session pool cap (t_bb6ce095): bound how many ranked
 * rows one SOURCE import session may contribute to the pool the
 * diversity rerank and the caller's window draw from.
 *
 * "Source session" is the import that produced a note, never the
 * caller's conversation: imported signal notes carry `session_ref`
 * frontmatter and handoff notes carry `session_id`. Identity is read
 * through the per-call frontmatter cache the assemble stage already
 * builds - one parsed read per path, shared with every other filter - so
 * the cap adds no new read shape to the pipeline.
 *
 * Rows without identity, and rows whose file could not be read, pass
 * through uncapped, mirroring the `duplicateKey` null handling: an
 * ordinary vault note has no session to bound, and an unreadable file is
 * nothing this phase can claim knowledge about. Both sides keep the cap
 * a measured no-op on vaults that never group by a source session.
 */

import { readCachedFrontmatterEntry, type FrontmatterCache } from "../result-filters.ts";
import type { BrainSearchResult } from "../types.ts";

/** Frontmatter key naming the SOURCE import session (signal notes). */
const SESSION_REF_KEY = "session_ref";
/** Frontmatter key naming the source session (handoff notes). */
const SESSION_ID_KEY = "session_id";

/** The cap result: surviving rows in ranked order, plus the drop count. */
export interface SessionPoolCapResult {
  readonly results: BrainSearchResult[];
  /** Rows the cap removed, summed across every session. */
  readonly dropped: number;
}

/** What the cap reads per row: the vault root, the cap, the shared cache. */
export interface SessionPoolCapOptions {
  readonly vault: string;
  /**
   * Rows one source session may keep, in ranked order. Must be positive;
   * the caller gates the phase on the configured knob being on, so zero
   * never reaches this module.
   */
  readonly capPerSession: number;
  readonly frontmatterCache: FrontmatterCache;
}

/**
 * The session-identity key of a ranked row, or `null` when the row
 * cannot state one.
 *
 * `session_ref` wins over `session_id` when a row carries both (imported
 * material is what crowds a pool). Only a non-empty string names a
 * session - an empty or non-typed frontmatter value is absent identity -
 * and an unreadable file is unknown, which is the same pass-through
 * side: the cap never invents a grouping it cannot read.
 */
function sessionKey(vault: string, r: BrainSearchResult, cache: FrontmatterCache): string | null {
  const { meta, unreadable } = readCachedFrontmatterEntry(cache, vault, r.path);
  if (unreadable) return null;
  const ref = meta[SESSION_REF_KEY];
  if (typeof ref === "string" && ref !== "") return ref;
  const id = meta[SESSION_ID_KEY];
  if (typeof id === "string" && id !== "") return id;
  return null;
}

/**
 * Cap every source session's contribution to the ranked pool.
 *
 * The first {@link SessionPoolCapOptions.capPerSession} rows of each
 * session survive, in the order the ranker produced; the rest are
 * dropped and counted, so the caller can name the narrowing. Rows
 * without a session key pass through untouched. Pure: the same rows and
 * a same-filled cache answer identically, and the only cache effect is
 * the read-through fill every other filter stage already causes.
 */
export function applySessionPoolCap(
  ranked: ReadonlyArray<BrainSearchResult>,
  opts: SessionPoolCapOptions,
): SessionPoolCapResult {
  const kept: BrainSearchResult[] = [];
  const seenPerSession = new Map<string, number>();
  let dropped = 0;
  for (const r of ranked) {
    const key = sessionKey(opts.vault, r, opts.frontmatterCache);
    if (key === null) {
      kept.push(r);
      continue;
    }
    const seen = seenPerSession.get(key) ?? 0;
    if (seen >= opts.capPerSession) {
      dropped += 1;
      continue;
    }
    seenPerSession.set(key, seen + 1);
    kept.push(r);
  }
  return { results: kept, dropped };
}
