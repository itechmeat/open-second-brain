/**
 * Consolidate the scattered embeddings-health signals into the brain
 * doctor (t_f99250aa).
 *
 * The facts already existed, each behind its own verb: the pending-vector
 * census (`readPendingVectorCensus`, with its unrecorded-is-not-zero
 * contract), the index counts including `staleEmbeddings`, the provider
 * readout `o2b search check` owns. Nothing read them together where an
 * operator looks, so a vault whose index lagged its configuration stayed
 * silent until a query came back thin. This check is the strictly earlier
 * signal: it speaks from the doctor pass an operator already runs.
 *
 * ## Why it lives in `o2b brain doctor`
 *
 * `o2b search check` owns the provider question and its exit table, but
 * it is a verb an operator must think to run; this doctor is the pass
 * they run to be told what they did not think to ask. The
 * `core/brain -> core/search` import edge already exists
 * (`embedding-sunset-check.ts`, this check's shape precedent), and the
 * check inherits the context clock (`ctx.now`) the age clause is
 * computed against rather than reading a clock of its own.
 *
 * ## The four answers, and why three of them are not silence
 *
 * | state                        | outcome                                     |
 * |------------------------------|---------------------------------------------|
 * | measured, embedded, current  | nothing - the condition does not hold       |
 * | measured, backlog            | warning naming both counts and the commands |
 * | census unrecorded            | uncertain: NO statement was made            |
 * | anything else unmeasurable   | uncertain, naming which half could not run  |
 *
 * `unrecorded` is deliberately not folded into healthy. An absent or
 * unreadable index proves nothing about how many chunks are waiting, and
 * zero is precisely the answer that reads as "nothing is waiting". The
 * same refusal covers a HALF read: the census opened the file but the
 * count half failed, so `staleEmbeddings` arrives as `null` - and a null
 * count may never collapse into the zero that reads as healthy.
 *
 * ## What the message may say
 *
 * The remedy clauses are per condition, because the conditions have
 * different verbs: a chunk with no vector is closed by
 * `o2b search vector-backfill` (the vector phase run alone), while
 * vectors stored under a retired model or dimension are incomparable to
 * new queries and need `o2b search reindex --embeddings` - a backfill
 * finds them fully vectorised and does nothing. `o2b search check` is
 * the shared readout for the provider facts behind either state. The
 * disabled state has its own reported class (`semantic-capability-disabled`)
 * and is not repeated here, following `embedding-sunset-check`.
 *
 * The check is strictly read-only: every fact it touches is a synchronous
 * read-only peek at the index file.
 */

import { resolveSearchConfig } from "../../search/index.ts";
import { readPendingVectorCensus } from "../../search/indexer.ts";
import { staleBaseline } from "../../search/store/counts.ts";
import { LAST_INDEXED_AT_STATE_KEY, withReadonlyIndex } from "../../search/store/state.ts";
import { staleEmbeddings } from "../../search/store/vectors.ts";
import type { PendingVectorCensus, ResolvedEmbeddingConfig } from "../../search/types.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** Indexed chunks wait for vectors, or stored vectors no longer match. */
export const EMBEDDINGS_BACKLOG_CODE = "embeddings-backlog";

/** The pending-vector census could not be taken; no statement was made. */
export const EMBEDDINGS_CENSUS_UNRECORDED_CODE = "embeddings-census-unrecorded";

/** The check ran and could observe too little to say anything at all. */
export const EMBEDDINGS_HEALTH_UNMEASURED_CODE = "embeddings-health-unmeasured";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What one probe read off the index.
 *
 * `census` keeps the two-verdict shape of `readPendingVectorCensus` so
 * the unrecorded contract travels with the data rather than being
 * re-derived here. `staleEmbeddings` is `null` when the count half of
 * the read failed - NOT zero, for the reason in the header.
 */
export interface EmbeddingsHealthProbeSnapshot {
  readonly census: PendingVectorCensus;
  /** Vectors whose model/dimension no longer match the configured pair. */
  readonly staleEmbeddings: number | null;
  /** ISO instant of the last index run, when the index recorded one. */
  readonly lastIndexedAt: string | null;
}

/** The slice of the embedding configuration the stale count is resolved from. */
export type EmbeddingsHealthSemantic = Pick<
  ResolvedEmbeddingConfig,
  "provider" | "model" | "dimension"
>;

/**
 * The seam the check reads its facts through.
 *
 * Receives the resolved index path and the embedding configuration so
 * the default probe below can resolve the pair stored vectors are
 * compared against (`staleBaseline`: an unset dimension falls back to
 * the stored one, and with none the comparison is by model alone); a
 * test injects any snapshot it wants without building an index.
 */
export type EmbeddingsHealthProbe = (
  dbPath: string,
  semantic: EmbeddingsHealthSemantic,
) => EmbeddingsHealthProbeSnapshot;

/**
 * The default probe: the exported census fold, then one synchronous
 * read-only peek for the counts the census does not carry.
 *
 * Two peeks over one file, not one, because the census's unrecorded
 * contract is folded in `readPendingVectorCensus` and re-deriving it
 * here is exactly the drift the reuse exists to prevent. A file that
 * vanishes between the two peeks is a half read, and the check answers
 * that with uncertainty rather than a health claim.
 */
function indexProbe(
  dbPath: string,
  semantic: EmbeddingsHealthSemantic,
): EmbeddingsHealthProbeSnapshot {
  const census = readPendingVectorCensus(dbPath);
  if (census.verdict !== "measured") {
    return { census, staleEmbeddings: null, lastIndexedAt: null };
  }
  const counts = withReadonlyIndex(dbPath, (read, db) => {
    const baseline = staleBaseline(db, semantic);
    return {
      stale: staleEmbeddings(db, baseline.model, baseline.dimension),
      last: read(LAST_INDEXED_AT_STATE_KEY),
    };
  });
  return {
    census,
    staleEmbeddings: counts?.stale ?? null,
    lastIndexedAt: counts?.last ?? null,
  };
}

function unmeasurable(message: string): string {
  return `${message} No statement was made about the index, and none may be inferred from a read that did not happen.`;
}

function unrecordedMessage(reason: string): string {
  return (
    `${reason}. The pending-vector census could not be taken, so no embeddings-health ` +
    "statement was made: an absent or unreadable index is not an empty one, and zero is " +
    "precisely the count that reads as fully embedded."
  );
}

function backlogMessage(
  pending: number,
  chunks: number,
  stale: number,
  lastIndexedAt: string | null,
  now: Date,
): string {
  const remedies: string[] = [];
  if (pending > 0) {
    remedies.push(
      `${pending} of ${chunks} indexed chunk(s) have no vector; ` +
        "run `o2b search vector-backfill` to compute them",
    );
  }
  if (stale > 0) {
    remedies.push(
      `${stale} stored vector(s) no longer match the configured embedding model, so they are ` +
        "not comparable to new queries; run `o2b search reindex --embeddings` to re-embed",
    );
  }
  const age =
    lastIndexedAt !== null && Number.isFinite(Date.parse(lastIndexedAt))
      ? ` The index last ran ${daysBetween(Date.parse(lastIndexedAt), now.getTime())} ago.`
      : "";
  return (
    `the search index is behind its embedding configuration: ${remedies.join("; and ")}. ` +
    `Then run \`o2b search check\` to read the provider verdict behind either state.${age}`
  );
}

/** A whole-day age clause, floored, for the warning's context sentence. */
function daysBetween(fromMs: number, toMs: number): string {
  const days = Math.floor((toMs - fromMs) / MS_PER_DAY);
  return days < 1 ? "less than a day" : `${days} day(s)`;
}

/**
 * Build the check against `probe`, following `makeEmbeddingSunsetCheck`:
 * the index facts are data the check reads rather than logic it owns, so
 * every verdict is reachable from a test without building an index.
 */
export function makeEmbeddingsHealthCheck(probe: EmbeddingsHealthProbe = indexProbe): DoctorCheck {
  return {
    failSoft: true,
    run(ctx: DoctorCheckContext, out: DoctorFindings): void {
      let search;
      try {
        search = resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath });
      } catch (err) {
        pushUncertain(out.uncertain, {
          code: EMBEDDINGS_HEALTH_UNMEASURED_CODE,
          path: ctx.configPath ?? ctx.vault,
          message: unmeasurable(
            `the search configuration could not be resolved, so the index could not be checked: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        });
        return;
      }
      // No semantic search, no index lane to be healthy or sick. The
      // disabled state has its own reported class
      // (`semantic-capability-disabled`) with its own exit; repeating it
      // here would meet an operator with two findings for one condition.
      if (!search.semantic.enabled || search.semantic.provider === "disabled") return;

      // The index the pass was pointed at wins over the one the search
      // configuration names, so every probe and every finding speak about
      // the same file the rest of the doctor pass reads.
      const dbPath = ctx.dbPath ?? search.dbPath;

      // The local embedder ships inside this build and carries no model
      // string in the configuration (`staleBaseline` names it the way the
      // index does). Any other provider with no configured model leaves
      // stored vectors nothing to be compared against, and a stale count
      // of zero from no baseline would read as healthy.
      if (search.semantic.provider !== "local" && !search.semantic.model) {
        pushUncertain(out.uncertain, {
          code: EMBEDDINGS_HEALTH_UNMEASURED_CODE,
          path: dbPath,
          message: unmeasurable(
            "no embedding model is configured, so stored vectors have no baseline to be " +
              "compared against",
          ),
        });
        return;
      }
      let snap;
      try {
        snap = probe(dbPath, search.semantic);
      } catch (err) {
        pushUncertain(out.uncertain, {
          code: EMBEDDINGS_HEALTH_UNMEASURED_CODE,
          path: dbPath,
          message: unmeasurable(
            `the index probe failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        });
        return;
      }

      if (snap.census.verdict === "unrecorded") {
        pushUncertain(out.uncertain, {
          code: EMBEDDINGS_CENSUS_UNRECORDED_CODE,
          path: dbPath,
          message: unrecordedMessage(snap.census.reason),
        });
        return;
      }
      const stale = snap.staleEmbeddings;
      if (stale === null) {
        // The census half measured, the count half did not: reporting the
        // pending count alone would read as a clean stale bill, and that
        // half-read-as-healthy is exactly the failure this check exists
        // to refuse.
        pushUncertain(out.uncertain, {
          code: EMBEDDINGS_HEALTH_UNMEASURED_CODE,
          path: dbPath,
          message: unmeasurable(
            "the index opened for the pending-vector census but its embedding counts could " +
              "not be read",
          ),
        });
        return;
      }
      const { pending, chunks } = snap.census;
      if (pending === 0 && stale === 0) return;
      out.issues.push({
        severity: "warning",
        code: EMBEDDINGS_BACKLOG_CODE,
        path: dbPath,
        message: backlogMessage(pending, chunks, stale, snap.lastIndexedAt, ctx.now),
      } satisfies DoctorIssue);
    },
  };
}

/** The registered instance, reading the live index. */
export const embeddingsHealthCheck: DoctorCheck = makeEmbeddingsHealthCheck();
