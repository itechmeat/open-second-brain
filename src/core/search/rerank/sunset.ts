/**
 * Announced decommissions of cross-encoder rerank models.
 *
 * The rerank stage keys on the configured `search_rerank_model` string, and
 * a model its vendor has retired stops answering on a known date. Once that
 * date has passed, every search would pay a request the endpoint can only
 * refuse; the stage skips the call instead and names the skip on the
 * retrieval trail (`rerank-model-sunset`).
 *
 * ## One mechanism, not two
 *
 * This is the embedding survey's problem with a different population, so
 * it reuses that module's survey shape, states, sources, staleness horizon
 * and classifier unchanged (`embeddings/sunset.ts`). Its header holds the
 * reasoning this table inherits: why a static survey rather than a network
 * registry, why a negative expires while a positive survives a stale
 * survey, and why absence is `unsurveyed` rather than `none_announced`.
 * Only the rows below are rerank-specific.
 *
 * ## Why the ZeroEntropy rows are negatives
 *
 * ZeroEntropy announced on 2026-07-24 that its hosted products are sunset
 * after 2026-09-04, and that its models are open source under Apache 2.0.
 * That is an ENDPOINT going away, not a model being decommissioned: an
 * entry here is a claim about the model string, and a self-hosted
 * `zerank` checkpoint keeps answering after the hosted API is gone. A
 * positive row would make the skip refuse a live self-hosted endpoint. So
 * the checkpoints are recorded as open-checkpoint negatives, and a dead
 * hosted endpoint is reported by the liveness code instead
 * (`rerank-provider-unavailable`, category `gone` or `network`).
 *
 * Pure and injectable like the embedding classifier: the clock and the
 * survey are parameters, so no wall clock is read here.
 */

import {
  EMBEDDING_SUNSET,
  classifyEmbeddingSunset,
  type EmbeddingSunsetEntry,
  type EmbeddingSunsetSurvey,
  type EmbeddingSunsetVerdict,
} from "../embeddings/sunset.ts";

/** Where the Cohere rows were read from. Cited, not remembered. */
const COHERE_DEPRECATIONS_URL = "https://docs.cohere.com/docs/deprecations";

/** The shutdown date that page states for both second-generation rerank models. */
const COHERE_RERANK_V2_SHUTDOWN = "2025-04-30";

const COHERE_RERANK_V2_SOURCE =
  `Cohere deprecations, announced 2024-12-02, shutdown ${COHERE_RERANK_V2_SHUTDOWN}, ` +
  `recommended replacement rerank-v3.5: ${COHERE_DEPRECATIONS_URL}`;

/** Every model that entry names, verbatim. */
const COHERE_RERANK_V2_MODELS: ReadonlyArray<string> = Object.freeze([
  "rerank-english-v2.0",
  "rerank-multilingual-v2.0",
]);

/** Where the ZeroEntropy announcement was read. */
const ZEROENTROPY_ANNOUNCEMENT_URL =
  "https://zeroentropy.dev/articles/zeroentropy-is-joining-notion/";

const ZEROENTROPY_SOURCE =
  "open-weight checkpoint under Apache 2.0 per the ZeroEntropy announcement of 2026-07-24 " +
  `(${ZEROENTROPY_ANNOUNCEMENT_URL}) and the model card on huggingface.co: there is no operator ` +
  "with the authority to decommission the model itself";

const ZEROENTROPY_NOTE =
  "the hosted ZeroEntropy API is sunset after 2026-09-04; that is liveness of one endpoint, " +
  "not a sunset of the model";

/**
 * The checkpoint names read on the day of review: `zerank-2`, `zerank-1`
 * and `zerank-1-small` as the announcement page names them (the hosted
 * API ids an operator typed for the endpoint now gone), and the three
 * repository ids the model cards carry. Listed rather than matched by
 * prefix, as every survey row is.
 *
 * `zerank-2-small` and `zerank-2-nano` are deliberately left unsurveyed:
 * the page lists them as products, but no open checkpoint for either was
 * found on review day, so no claim is made about them and the doctor
 * reports them as `rerank-model-sunset-unsurveyed`.
 */
const ZEROENTROPY_CHECKPOINTS: ReadonlyArray<string> = Object.freeze([
  "zerank-2",
  "zerank-1",
  "zerank-1-small",
  "zeroentropy/zerank-2-reranker",
  "zeroentropy/zerank-1-reranker",
  "zeroentropy/zerank-1-small-reranker",
]);

function zeroEntropyCheckpoint(model: string): EmbeddingSunsetEntry {
  return { model, sunsetAt: null, source: ZEROENTROPY_SOURCE, note: ZEROENTROPY_NOTE };
}

/**
 * The shipped rerank survey. Adding an entry is a one-line edit plus a bump
 * of `reviewedAt`; every row owes a `source` and a test enforces it.
 */
export const RERANK_SUNSET_SURVEY: EmbeddingSunsetSurvey = Object.freeze({
  reviewedAt: "2026-10-01",
  entries: Object.freeze([
    ...COHERE_RERANK_V2_MODELS.map((model) => ({
      model,
      sunsetAt: COHERE_RERANK_V2_SHUTDOWN,
      source: COHERE_RERANK_V2_SOURCE,
      note: "fine-tuned models created from these base models are not affected, per the same page",
    })),
    ...ZEROENTROPY_CHECKPOINTS.map(zeroEntropyCheckpoint),
  ]),
});

/** What the rerank survey says about `model` at `nowMs`. */
export function classifyRerankSunset(
  model: string | null,
  nowMs: number,
  survey: EmbeddingSunsetSurvey = RERANK_SUNSET_SURVEY,
): EmbeddingSunsetVerdict {
  return classifyEmbeddingSunset(model, nowMs, survey);
}

/**
 * Whether the rerank request is skipped: only an announced date that has
 * already passed. A future date, a negative, an off-survey model and an
 * undetermined verdict all keep calling the endpoint.
 */
export function rerankSunsetHasPassed(verdict: EmbeddingSunsetVerdict): boolean {
  return (
    verdict.state === EMBEDDING_SUNSET.announced &&
    verdict.days_remaining !== null &&
    verdict.days_remaining < 0
  );
}
