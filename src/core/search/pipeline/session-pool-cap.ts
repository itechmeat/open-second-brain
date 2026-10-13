/**
 * The per-source-session pool cap (t_bb6ce095): bound how many ranked
 * rows one group may contribute to the filtered pool the caller's window
 * is cut from.
 *
 * A row's group key is its SOURCE import session when the note states
 * one - `session_ref` frontmatter on imported signal notes, `session_id`
 * on handoff notes - and the row's own PATH otherwise. The fallback is
 * the review fix (M2): the crowding this cap was built to measure comes
 * from material that carries no session frontmatter at all - bench
 * session notes (the LongMemEval and LoCoMo converters write plain
 * bodies) and the several chunks of one long note - so grouping by
 * frontmatter alone capped nothing there, byte for byte. All chunks of
 * one note share a path, so the fallback groups exactly that note. The
 * three key kinds are namespaced apart (`ref:`, `id:` and `path:`
 * prefixes), so no two kinds can collide regardless of the value: even a
 * session value that itself begins with `path:` stays in the session key
 * space and cannot fuse with the note it names. An unreadable file
 * falls back to its path too: the path is a real identity even when the
 * frontmatter behind it cannot be read, and the chunks of one unreadable
 * note are one group for the same reason.
 *
 * Identity rides the per-call frontmatter cache the assemble stage
 * already builds - one parsed read per path, shared with every other
 * filter - so the cap adds no new read shape to the pipeline.
 *
 * Byte-identity is an OFF-path property only: at the off value the phase
 * never runs and reads nothing. When the knob is on, every row names a
 * group (a session or a path), so any vault can have rows capped - there
 * is no longer a class of vault the cap cannot see into.
 */

import { readCachedFrontmatterEntry, type FrontmatterCache } from "../result-filters.ts";
import { SearchError } from "../types.ts";
import type { BrainSearchResult } from "../types.ts";

/** Frontmatter key naming the SOURCE import session (signal notes). */
const SESSION_REF_KEY = "session_ref";
/** Frontmatter key naming the source session (handoff notes). */
const SESSION_ID_KEY = "session_id";
/**
 * Namespaces of the three group-key kinds. One map holds all of them, and
 * the disjoint prefixes make cross-kind collisions impossible by
 * construction: whatever a session value says - including a value that
 * itself begins with one of these prefixes - it lands in its own key
 * space and cannot fuse with another kind's group.
 */
const REF_GROUP_PREFIX = "ref:";
const ID_GROUP_PREFIX = "id:";
const PATH_GROUP_PREFIX = "path:";

/** The cap result: surviving rows in ranked order, plus the drop count. */
export interface SessionPoolCapResult {
  readonly results: BrainSearchResult[];
  /** Rows the cap removed, summed across every group. */
  readonly dropped: number;
  /**
   * The largest number of input rows any single group held, whether or
   * not the cap dropped from it. The caller's re-widen contract (review
   * M3) reads it: a window the cap under-filled needs a pool wide enough
   * that the groups it did not exhaust can fill the remaining slots, and
   * this is the observed occupancy that width has to outrun.
   */
  readonly widestGroupRows: number;
}

/** What the cap reads per row: the vault root, the cap, the shared cache. */
export interface SessionPoolCapOptions {
  readonly vault: string;
  /**
   * Rows one group may keep, in ranked order. Must be a non-negative
   * integer; the caller gates the phase on the configured knob being on,
   * so zero never reaches this module.
   */
  readonly capPerSession: number;
  readonly frontmatterCache: FrontmatterCache;
}

/**
 * Validate the cap value in force for one query - the per-query
 * `poolMaxPerSession` override, else the resolved config value - under
 * the same rules `validateResolvedConfig` applies to the config key.
 *
 * The per-query path used to bypass that gate (review CR): a fractional
 * value turned the cap on with a fractional comparison (`seen >= 1.5`
 * kept two rows), NaN silently read as off, and a negative as
 * drop-every-identified-row. A malformed value is refused by name,
 * through the same INVALID_INPUT error path the config refusal uses.
 * The refusal fires at the assemble stage's read site, before any
 * ranking, cap grouping or result assembly runs and before anything is
 * written - but after the lane fetch and hydration a refused query has
 * already paid. `0` stays legal: it is the documented per-query off
 * switch.
 */
export function resolveSessionPoolCap(value: number): number {
  if (!Number.isFinite(value)) {
    throw new SearchError(
      "INVALID_INPUT",
      `poolMaxPerSession must be a finite number, got '${value}'`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new SearchError("INVALID_INPUT", `poolMaxPerSession must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new SearchError("INVALID_INPUT", `poolMaxPerSession must be >= 0, got ${value}`);
  }
  return value;
}

/**
 * The group key of a ranked row.
 *
 * `session_ref` wins over `session_id` when a row carries both (imported
 * material is what crowds a pool). Only a non-empty string names a
 * session - an empty or non-typed frontmatter value is absent identity -
 * and an unreadable file has no frontmatter to speak of, so it lands on
 * the same path fallback as a note that never carried any.
 */
function sessionKey(vault: string, r: BrainSearchResult, cache: FrontmatterCache): string {
  const { meta } = readCachedFrontmatterEntry(cache, vault, r.path);
  const ref = meta[SESSION_REF_KEY];
  if (typeof ref === "string" && ref !== "") return `${REF_GROUP_PREFIX}${ref}`;
  const id = meta[SESSION_ID_KEY];
  if (typeof id === "string" && id !== "") return `${ID_GROUP_PREFIX}${id}`;
  return `${PATH_GROUP_PREFIX}${r.path}`;
}

/**
 * Cap every group's contribution to the ranked pool.
 *
 * The first {@link SessionPoolCapOptions.capPerSession} rows of each
 * group survive, in the order the ranker produced; the rest are dropped
 * and counted, so the caller can name the narrowing and compute the
 * re-widen width. Pure: the same rows and a same-filled cache answer
 * identically, and the only cache effect is the read-through fill every
 * other filter stage already causes.
 */
export function applySessionPoolCap(
  ranked: ReadonlyArray<BrainSearchResult>,
  opts: SessionPoolCapOptions,
): SessionPoolCapResult {
  const kept: BrainSearchResult[] = [];
  // Input rows per group (the density the re-widen outruns) and kept
  // rows per group (the quota actually consumed).
  const groupInput = new Map<string, number>();
  const groupKept = new Map<string, number>();
  let widestGroupRows = 0;
  let dropped = 0;
  for (const r of ranked) {
    const key = sessionKey(opts.vault, r, opts.frontmatterCache);
    const held = (groupInput.get(key) ?? 0) + 1;
    groupInput.set(key, held);
    if (held > widestGroupRows) widestGroupRows = held;
    const seen = groupKept.get(key) ?? 0;
    if (seen >= opts.capPerSession) {
      dropped += 1;
      continue;
    }
    groupKept.set(key, seen + 1);
    kept.push(r);
  }
  return { results: kept, dropped, widestGroupRows };
}
