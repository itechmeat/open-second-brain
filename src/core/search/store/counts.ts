/**
 * The index census: one row-count per table the operator surfaces care
 * about, taken together so `o2b search status` reports a single
 * consistent picture rather than four independent probes.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../search-error.ts";
import { EVENT_TIME_MAX_COLUMN, EVENT_TIME_MIN_COLUMN } from "../schema.ts";
import { countChunks, countChunksWithoutEmbeddings } from "./chunks.ts";
import type { ChunkHoldExclusion } from "./chunks.ts";
import { countDocuments } from "./documents.ts";
import {
  EMBEDDING_DIMENSION_STATE_KEY,
  getState,
  peekReadonlyIndex,
  type IndexPeek,
} from "./state.ts";
import { countEmbeddings, staleEmbeddings } from "./vectors.ts";
import {
  charLengthOverTokenBudget,
  MAX_CODE_POINTS_PER_TOKEN,
  NON_ASCII_CEILING_COEFFICIENT,
  textExtent,
  utf8ByteFloorUnderTokenBudget,
  LOCAL_EMBEDDING_MODEL,
} from "../embeddings/signature.ts";
import { LOCAL_DEFAULT_DIMENSION } from "../embeddings/local-provider.ts";
import type { ResolvedEmbeddingConfig } from "../types.ts";

export interface StoreCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  /** Embeddings whose `model`/`dimension` no longer match the current config. */
  readonly staleEmbeddings: number;
}

/** The embedding pair stored vectors are compared against. */
export interface StaleBaseline {
  readonly model: string | null;
  readonly dimension: number | null;
}

/**
 * Resolve the pair {@link staleEmbeddings} compares against, the way the
 * indexer resolves the active signature: the local embedder is named by
 * its built-in model and default dimension; otherwise the configured
 * dimension wins and the stored one fills in when none is configured.
 * `embedding_dimension` is null unless configured, so reading the
 * configuration alone left the stale count at zero on a default setup.
 */
export function staleBaseline(
  db: Database,
  semantic: Pick<ResolvedEmbeddingConfig, "provider" | "model" | "dimension">,
): StaleBaseline {
  const local = semantic.provider === "local";
  const model = local ? LOCAL_EMBEDDING_MODEL : (semantic.model ?? null);
  if (semantic.dimension !== null && semantic.dimension !== undefined) {
    return { model, dimension: semantic.dimension };
  }
  if (local) return { model, dimension: LOCAL_DEFAULT_DIMENSION };
  const raw = getState(db, EMBEDDING_DIMENSION_STATE_KEY);
  const stored = raw === null ? null : Number(raw);
  return {
    model,
    dimension: stored !== null && Number.isFinite(stored) && stored > 0 ? stored : null,
  };
}

export function counts(
  db: Database,
  configuredModel: string | null,
  configuredDimension: number | null,
): StoreCounts {
  return Object.freeze({
    documents: countDocuments(db),
    chunks: countChunks(db),
    embeddings: countEmbeddings(db),
    staleEmbeddings: staleEmbeddings(db, configuredModel, configuredDimension),
  });
}

/**
 * The event-time window census (t_9e1a4b3f): how many documents fall in
 * a `[sinceMs, untilMs]` window, answered from the persisted
 * `documents.event_time_min` / `event_time_max` bounds as ONE SQL
 * aggregate instead of a full hydration pass. Deliberately a function
 * beside {@link StoreCounts}, not a field on it: `StoreCounts` has no
 * window to be relative to, and its consumers keep their shape.
 */
export interface EventTimeWindowCensus {
  /** Every indexed document - the denominator of the other buckets. */
  readonly documents: number;
  /** Documents whose resolved event-time window is persisted (at least one bound non-null). */
  readonly declared: number;
  /**
   * Declared documents whose window intersects the query window, under
   * exactly the rule `eventTimeInRange` applies at query time: a window
   * is out only when a non-null bound proves it (`event_time_min >
   * until`, or `event_time_max < since`), with open window sides and
   * open query edges handled symmetrically.
   */
  readonly intersecting: number;
  /**
   * Documents with no persisted window - the unmeasured bucket: rows
   * that predate the lazy backfill and rows that declare nothing the
   * resolver can use. The query side judges these by storage mtime,
   * which is what the bucket is named for. They are deliberately NOT
   * counted by their mtime here - that would re-import storage time
   * into an event-time census - so `declared + mtimeFallback` always
   * equals {@link documents}.
   */
  readonly mtimeFallback: number;
  /**
   * The earliest instant any persisted window names (its lower bound, or
   * the upper one for an open-start window), unix ms. Null when no
   * document has a persisted window.
   */
  readonly earliestMs: number | null;
  /** The latest instant any persisted window names, unix ms; null as above. */
  readonly latestMs: number | null;
}

/**
 * Take the census. `sinceMs` / `untilMs` are unix ms and mirror
 * `ResolvedTimeRange`: a null edge is an OPEN one, never zero.
 */
export function eventTimeWindowCensus(
  db: Database,
  sinceMs: number | null,
  untilMs: number | null,
): EventTimeWindowCensus {
  const row = db
    .query<
      {
        documents: number;
        declared: number;
        intersecting: number;
        mtime_fallback: number;
        earliest: number | null;
        latest: number | null;
      },
      { $since: number | null; $until: number | null }
    >(
      `SELECT
         COUNT(*) AS documents,
         COUNT(*) FILTER (
           WHERE ${EVENT_TIME_MIN_COLUMN} IS NOT NULL OR ${EVENT_TIME_MAX_COLUMN} IS NOT NULL
         ) AS declared,
         COUNT(*) FILTER (
           WHERE (${EVENT_TIME_MIN_COLUMN} IS NOT NULL OR ${EVENT_TIME_MAX_COLUMN} IS NOT NULL)
             AND (${EVENT_TIME_MIN_COLUMN} IS NULL OR $until IS NULL
                  OR ${EVENT_TIME_MIN_COLUMN} <= $until)
             AND (${EVENT_TIME_MAX_COLUMN} IS NULL OR $since IS NULL
                  OR ${EVENT_TIME_MAX_COLUMN} >= $since)
         ) AS intersecting,
         COUNT(*) FILTER (
           WHERE ${EVENT_TIME_MIN_COLUMN} IS NULL AND ${EVENT_TIME_MAX_COLUMN} IS NULL
         ) AS mtime_fallback,
         MIN(COALESCE(${EVENT_TIME_MIN_COLUMN}, ${EVENT_TIME_MAX_COLUMN})) AS earliest,
         MAX(COALESCE(${EVENT_TIME_MAX_COLUMN}, ${EVENT_TIME_MIN_COLUMN})) AS latest
       FROM documents`,
    )
    .get({ $since: sinceMs, $until: untilMs });
  if (row === null) {
    // Unreachable while the query is an unfiltered aggregate, and
    // therefore exactly the shape that must not degrade to a zero count:
    // a zero here would be a clean census nobody took.
    throw new SearchError(
      "INDEX_UNREADABLE",
      "event-time window census: the aggregate over `documents` returned no row, so no census " +
        "was taken. Run: o2b search check",
    );
  }
  return Object.freeze({
    documents: row.documents,
    declared: row.declared,
    intersecting: row.intersecting,
    mtimeFallback: row.mtime_fallback,
    earliestMs: row.earliest,
    latestMs: row.latest,
  });
}

/** Chunks that carry no vector, against the chunks there are. */
export interface PendingVectorTally {
  /** Chunks with no row in `embeddings`, held chunks excluded when asked. */
  readonly pending: number;
  /** Chunks in the index at all, so the pending count has a denominator. */
  readonly chunks: number;
}

/**
 * Both counts from one connection, so they describe one instant.
 *
 * `hold` is the config's chunk-hold exclusion key: a chunk held out of
 * embedding under that key is not work the index owes a vector for, so a
 * tally that counted it as pending would recommend a backfill that finds
 * nothing to do and never clears. Callers that have no configuration in
 * hand (the key-free diagnostic reads) omit it and see the raw count.
 */
export function pendingVectorTally(db: Database, hold?: ChunkHoldExclusion): PendingVectorTally {
  return Object.freeze({
    pending: countChunksWithoutEmbeddings(db, undefined, hold),
    chunks: countChunks(db),
  });
}

/**
 * {@link pendingVectorTally} taken WITHOUT opening a `Store`, for
 * `indexCheck` - which deliberately probes an in-memory database and
 * never touches the real index, so anything it reports about stored
 * state has to be read explicitly. `hold` threads the config's chunk-hold
 * exclusion through, exactly as {@link pendingVectorTally} takes it.
 *
 * The peek keeps its three outcomes rather than collapsing to a number:
 * "no index here" and "an index that will not open" are not a pending
 * count of zero, and zero is exactly what a caller would read as a
 * fully-embedded vault.
 */
export function peekPendingVectorsSync(
  dbPath: string,
  hold?: ChunkHoldExclusion,
): IndexPeek<PendingVectorTally> {
  return peekReadonlyIndex(dbPath, (_read, db) => pendingVectorTally(db, hold));
}

/** Split of the chunk table by what the census can decide about it. */
export interface ChunkWindowTally {
  /** Chunks over the window even at the conservative hold bound. */
  readonly overWindow: number;
  /** Chunks the hold bound does not prove over, whose estimates still read over. */
  readonly undecided: number;
}

/** The prefix value that means "this backend prepends nothing". */
export const NO_REQUEST_PREFIX = "";

/**
 * One SQL pass, two aggregates: chunks the census can prove are over
 * `windowTokens`, and chunks it cannot place on either side of it.
 *
 * `requestPrefix` is the text the CONFIGURED BACKEND prepends to every
 * indexed chunk before the provider counts a token - `passage: ` for the
 * recommended e5 default, empty for a backend that implements no
 * instruction-prefix contract. It is measured into both thresholds
 * because the provider counts it: a census that ignored it would report
 * zero for chunks the request path puts over the window by exactly the
 * width of the prefix. It is a required argument for the same reason -
 * an optional one is the drift this parameter exists to close.
 *
 * The unit measured is a token ESTIMATE, never the `chunks.token_count`
 * column: that column is the chunker's own count (whitespace words, one
 * per character for unspaced scripts such as Han), a
 * different unit from a model's token window, and comparing the two as
 * though they matched is the arithmetic this census exists to stop.
 *
 * ## Why two aggregates, and where the boundary sits
 *
 * `overWindow` is the HOLD population, so it uses the hold's own bound:
 * code points charged at no more than one token per
 * {@link MAX_CODE_POINTS_PER_TOKEN}. Only that conservative bound proves a
 * chunk over the window - the chars-over-four average is not a bound, and
 * the phase that embeds must never hold on it.
 *
 * The undecided band is everything the proof cannot settle: chunks whose
 * conservative bound still fits the window but whose HIGH estimate - the
 * average rate for Latin text, a near-character-level charge for Han and
 * supplementary-plane text - reads over it. Three populations land there:
 *
 *   - Latin chunks between the average estimate and the sound bound. The
 *     average reads HIGH on real prose (real tokenizers absorb more than
 *     four code points per token), so acting on it would hold work on a
 *     guess - exactly the defect that moved the hold to the conservative
 *     bound;
 *   - Han text, where a BERT-family tokenizer is roughly
 *     character-level. `BAAI/bge-small-zh-v1.5` declares a 512-token
 *     window, and a Chinese chunk that estimates at 512 costs about four
 *     times that;
 *   - supplementary-plane text, where SQLite's `length()` counts one per
 *     character and `String.length` counts two, so the database reads
 *     half the estimated size.
 *
 * None of the three is fixable by a tighter constant on its own, and all
 * are observable in SQL through the same two measurements: `length()`
 * (code points) and `octet_length()` (UTF-8 bytes), whose difference
 * bounds the non-ASCII code points exactly. Charging those at
 * `MAX_TOKENS_PER_NON_ASCII_CODE_POINT` gives the high estimate, and the
 * gap between the two arms is reported as undecided rather than passed.
 *
 * ## Cost
 *
 * Cheaper than the single aggregate it replaced, not dearer. `length()`
 * walks the UTF-8 body and dominates the query; `octet_length()` reads a
 * stored byte count. The `WHERE` clause therefore tests the free
 * measurement first ({@link utf8ByteFloorUnderTokenBudget}) and only the
 * survivors are walked - which on a wide-window model is no rows at all.
 * Measured on a 21 000-chunk / 137 MB fixture, warm: 307 ms before
 * against 316 ms after at a 512-token window, and 288 ms before against
 * 71 ms after at the 8192-token window `BAAI/bge-m3` declares.
 */
export function chunkWindowTally(
  db: Database,
  windowTokens: number,
  requestPrefix: string,
): ChunkWindowTally {
  const prefix = textExtent(requestPrefix);
  const row = db
    .query<
      { over_window: number; undecided: number },
      {
        $budget: number;
        $holdBudget: number;
        $byteFloor: number;
        $coefficient: number;
        $prefixCodePoints: number;
        $prefixUtf8Bytes: number;
      }
    >(
      // MATERIALIZED, not a plain subquery: `code_points` is read three
      // times below, and without it SQLite re-evaluates `length()` -
      // a full walk of the chunk body - once per reference.
      `WITH extents AS MATERIALIZED (
         SELECT length(content) + $prefixCodePoints AS code_points,
                octet_length(content) + $prefixUtf8Bytes AS utf8_bytes
         FROM chunks
         WHERE octet_length(content) + $prefixUtf8Bytes > $byteFloor
       )
       SELECT
         COUNT(*) FILTER (WHERE code_points > $holdBudget) AS over_window,
         COUNT(*) FILTER (
           WHERE code_points <= $holdBudget
             AND code_points + $coefficient * min(code_points, utf8_bytes - code_points) > $budget
         ) AS undecided
       FROM extents`,
    )
    .get({
      $budget: charLengthOverTokenBudget(windowTokens),
      $holdBudget: windowTokens * MAX_CODE_POINTS_PER_TOKEN,
      $byteFloor: utf8ByteFloorUnderTokenBudget(windowTokens),
      $coefficient: NON_ASCII_CEILING_COEFFICIENT,
      $prefixCodePoints: prefix.codePoints,
      $prefixUtf8Bytes: prefix.utf8Bytes,
    });
  if (row === null) {
    // Unreachable while the query is an unfiltered aggregate, and
    // therefore exactly the shape that must not degrade to a zero count:
    // a zero here would be a clean census nobody took.
    throw new SearchError(
      "INDEX_UNREADABLE",
      "chunk-window census: the aggregate over `chunks` returned no row, so no census was " +
        "taken. Run: o2b search check",
    );
  }
  return Object.freeze({ overWindow: row.over_window, undecided: row.undecided });
}

/**
 * The provable half of {@link chunkWindowTally} on its own, for a caller
 * that already knows the backend sends no prefix. Kept as a named
 * projection rather than a second query so the two cannot drift.
 */
export function chunksOverTokenWindow(db: Database, windowTokens: number): number {
  return chunkWindowTally(db, windowTokens, NO_REQUEST_PREFIX).overWindow;
}
