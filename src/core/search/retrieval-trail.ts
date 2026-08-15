/**
 * The retrieval trail (evidence-at-the-boundary, C2): why a search
 * narrowed, and why it came back empty.
 *
 * ## The problem this module removes
 *
 * A dozen degradation signals were computed by the pipeline and then
 * either dropped on the floor or flattened into free-form English inside
 * an untyped `warnings: string[]`. Several more said nothing at all - a
 * query that tokenises to an empty FTS match, an owner-scope filter that
 * removes every hit. A caller that got nothing back could not tell an
 * exhausted corpus from a broken embedder, because both answer with the
 * same empty array and the same silence.
 *
 * The sentences are not the fix. A sentence is a UI decision that a
 * machine has to pattern-match, and this tree already carried one lane
 * (`store/trigram.ts`) that classified its own fault onto a closed union
 * and then destroyed the type by interpolating it into prose at the last
 * step. So the vocabulary below is the wire format, one English mapping
 * lives behind an exhaustive switch with no default arm, and only the
 * human transcript ever calls it.
 *
 * ## Why there is no `lane` field
 *
 * Every code belongs to exactly one lane and says so in its own name
 * (`keyword-*`, `semantic-*`, `cross-vault-*`). A separate `lane` field
 * would be a second copy of a fact the code already carries, and two
 * copies of one fact are what drift. A consumer that wants to group by
 * lane groups by the code, which is stable by contract.
 *
 * ## The `detail` rule
 *
 * `detail` carries identifiers and integers only - never a provider
 * message, never a filesystem path, never query text. It is the rule
 * `brain/negative-recall.ts` states for its reasons and the one
 * `store/trigram.ts` states for its warnings, and it exists because this
 * channel travels into logs and MCP payloads: an FTS5 error echoes the
 * caller's own query back, and a SQLite error can name the index file.
 *
 * An identifier may carry ONE namespace segment, because the cross-vault
 * codes key on origin LABELS and a label is namespaced by construction
 * (`profile/<name>`, `source/<alias>`). {@link RETRIEVAL_DETAIL_IDENTIFIER}
 * is that grammar written once, so a reader, a writer and a test cannot
 * each hold a different idea of what an identifier is.
 *
 * ## Absent, not empty
 *
 * A healthy answer with rows in it carries no trail, so the envelope is
 * `{}` and every existing caller's bytes are unchanged - the same rule
 * `explain-envelope.ts` follows for its receipts. The trail appears when
 * something narrowed the answer, or when the answer is empty and owes an
 * explanation.
 */

import type {
  NegativeRecallState,
  NegativeRecallUnknownReason,
  NegativeRecallVerdict,
} from "../brain/negative-recall.ts";

/**
 * Why a retrieval narrowed, as a closed vocabulary.
 *
 * Every member names a site that exists in this pipeline today. Members
 * are NOT invented for conditions nothing reports: a code with no
 * producer would be a promise the search path does not keep.
 */
export const RETRIEVAL_DEGRADATION = Object.freeze({
  /**
   * The query tokenised to an empty FTS match, so the keyword lane never
   * ran. The purest silent empty in the tree: `fts.ts` returned no hits
   * and no warning, which reads exactly like a vault with nothing in it.
   */
  keywordFtsMatchEmpty: "keyword-fts-match-empty",
  /**
   * The trigram candidate lane could not be read. `detail.fault` carries
   * the lane's own closed classification (`locked`, `corrupt`, ...),
   * which existed already and was being interpolated into a sentence.
   */
  keywordTrigramLaneFault: "keyword-trigram-lane-fault",
  /** The index holds no compatible embedding, so the vector lane was skipped. */
  semanticEmbeddingsAbsent: "semantic-embeddings-absent",
  /** sqlite-vec is not loaded on this machine, so the vector lane was skipped. */
  semanticVecExtensionUnavailable: "semantic-vec-extension-unavailable",
  /**
   * The configured semantic capability blocks the lane. `detail.tier`
   * carries the rung of `SEMANTIC_CAPABILITY_TIER` that blocked it.
   */
  semanticCapabilityBlocked: "semantic-capability-blocked",
  /**
   * The embedding provider could not answer. `detail.category` carries
   * `classifyEmbeddingError`'s category - already computed at the call
   * site and, until now, stringified into a sentence and thrown away.
   */
  semanticProviderUnavailable: "semantic-provider-unavailable",
  /** The provider answered with an empty vector, so there was nothing to search. */
  semanticEmptyQueryVector: "semantic-empty-query-vector",
  /** A structured semantic lane was requested while semantic search is off. */
  semanticStructuredLanesSkipped: "semantic-structured-lanes-skipped",
  /**
   * The index carries embeddings written by another build.
   * `detail.fields` counts the contradicted ABI fields; their names stay
   * in the operator-facing warning, which is where they are actionable.
   */
  semanticEmbeddingAbiDrift: "semantic-embedding-abi-drift",
  /**
   * The caller wanted hybrid recall and the semantic lane did not run, so
   * the answer is keyword-only. The umbrella over the five codes above -
   * they say why, this says what the caller received.
   */
  hybridDegraded: "hybrid-degraded",
  /**
   * The rank cap truncated the candidate pool: matches existed below the
   * cut and were never ranked. `detail.cap` is the cap that bit.
   */
  rankCapTruncatedPool: "rank-cap-truncated-pool",
  /**
   * The caller's relevance floor dropped ranked rows. `detail.dropped`
   * counts them - which is how a floor that removed every hit stops
   * looking like a vault with no match.
   */
  relevanceFloorDroppedRows: "relevance-floor-dropped-rows",
  /**
   * Visibility, ownership or session/project scope dropped ranked rows.
   * `detail.dropped` counts them against `detail.before`, so a scope that
   * removed every hit is distinguishable from an exhausted corpus.
   */
  scopeFiltersDroppedRows: "scope-filters-dropped-rows",
  /**
   * A cross-vault origin could not be searched. `detail.origin` is the
   * origin LABEL, which is an identifier the results already carry - the
   * failure's own message is deliberately not here.
   */
  crossVaultOriginFailed: "cross-vault-origin-failed",
  /**
   * An origin answered confidently and the remaining origins were
   * deliberately not searched. `detail.skipped` counts them.
   */
  crossVaultChainStopped: "cross-vault-chain-stopped",
} as const);

/** Closed union over {@link RETRIEVAL_DEGRADATION}. */
export type RetrievalDegradationCode =
  (typeof RETRIEVAL_DEGRADATION)[keyof typeof RETRIEVAL_DEGRADATION];

/** Membership list, ordered lane by lane along the pipeline. */
export const RETRIEVAL_DEGRADATION_CODES: ReadonlyArray<RetrievalDegradationCode> = Object.freeze([
  RETRIEVAL_DEGRADATION.keywordFtsMatchEmpty,
  RETRIEVAL_DEGRADATION.keywordTrigramLaneFault,
  RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent,
  RETRIEVAL_DEGRADATION.semanticVecExtensionUnavailable,
  RETRIEVAL_DEGRADATION.semanticCapabilityBlocked,
  RETRIEVAL_DEGRADATION.semanticProviderUnavailable,
  RETRIEVAL_DEGRADATION.semanticEmptyQueryVector,
  RETRIEVAL_DEGRADATION.semanticStructuredLanesSkipped,
  RETRIEVAL_DEGRADATION.semanticEmbeddingAbiDrift,
  RETRIEVAL_DEGRADATION.hybridDegraded,
  RETRIEVAL_DEGRADATION.rankCapTruncatedPool,
  RETRIEVAL_DEGRADATION.relevanceFloorDroppedRows,
  RETRIEVAL_DEGRADATION.scopeFiltersDroppedRows,
  RETRIEVAL_DEGRADATION.crossVaultOriginFailed,
  RETRIEVAL_DEGRADATION.crossVaultChainStopped,
]);

/** Narrow a string read back across a tool boundary. */
export function isRetrievalDegradationCode(value: unknown): value is RetrievalDegradationCode {
  return (
    typeof value === "string" &&
    (RETRIEVAL_DEGRADATION_CODES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Identifiers and integers only. The type is the enforcement: there is no
 * shape here a provider message or an absolute path can be assigned to
 * without a reader noticing it is prose.
 */
export type RetrievalDegradationDetail = Readonly<Record<string, string | number>>;

/**
 * What "an identifier" means for a {@link RetrievalDegradationDetail}
 * string: an optional namespace segment, then the identifier body.
 *
 * The namespace is not a concession - it is the shape of the one detail
 * value the pipeline computes rather than names, the cross-vault origin
 * LABEL (`profile/<name>`, `source/<alias>`). The rejected alternative was
 * to split the label into a kind and a name so the separator never
 * appeared: that would break the join a caller makes between a trail entry
 * and the rows beside it, which carry the whole label on `origin` and in
 * their `origin:<label>` reason.
 *
 * Exactly one separator, never leading, is what keeps the widening from
 * re-admitting what the rule exists to exclude: `/var/lib/index.sqlite`
 * and `Brain/notes/a.md` both fail it, as does anything carrying
 * whitespace or prose punctuation. It is stated as a pattern rather than
 * as prose so the tests assert the rule itself instead of restating it.
 */
export const RETRIEVAL_DETAIL_IDENTIFIER = /^(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.:-]+$/u;

/** One narrowing, as the pipeline recorded it. */
export interface RetrievalDegradation {
  readonly code: RetrievalDegradationCode;
  readonly detail?: RetrievalDegradationDetail;
}

/**
 * What the corpus supports when nothing degraded and nothing matched -
 * the three surfaced fields of a {@link NegativeRecallVerdict}. The
 * digest-bound coverage receipt is deliberately left off: it is a
 * multi-field attestation the recall gate exists to serve, and repeating
 * it on every empty search would pay for a receipt nobody asked for.
 */
export interface RetrievalCorpusStatement {
  readonly state: NegativeRecallState;
  readonly reason: string;
  readonly unknownReason?: NegativeRecallUnknownReason;
}

/**
 * What one retrieval did, beyond the rows it returned.
 *
 * `retrieved` and `pool` are both stated, because `SearchOutcome.total`
 * is the size of the RANKED POOL and not the number of rows handed back:
 * a caller had to infer the retrieved count from the array it happened to
 * receive, and under `disclosure: "cards"` that array is empty by design.
 */
export interface RetrievalTrail {
  /** Rows handed back, whether they rode `results` or `cards`. */
  readonly retrieved: number;
  /** Size of the ranked pool the window was cut from - `SearchOutcome.total`. */
  readonly pool: number;
  readonly degraded: ReadonlyArray<RetrievalDegradation>;
  /**
   * Present only on a zero-result answer that no degradation accounts
   * for. When a lane degraded, the degradation IS the explanation and
   * claiming the corpus holds nothing would be a stronger statement than
   * the search can support.
   */
  readonly empty?: RetrievalCorpusStatement;
}

/**
 * The sink the pipeline threads, exactly parallel to the `warnings`
 * array it rides beside: mutable, created once per query, pushed to by
 * each lane at the point where it already pushes its sentence.
 */
export type RetrievalDegradationSink = RetrievalDegradation[];

/** Record one narrowing. The only writer, so the shape cannot drift. */
export function noteDegradation(
  sink: RetrievalDegradationSink,
  code: RetrievalDegradationCode,
  detail?: RetrievalDegradationDetail,
): void {
  sink.push(Object.freeze(detail !== undefined ? { code, detail } : { code }));
}

/**
 * The one English mapping, exhaustive over the vocabulary with no default
 * arm - so adding a code fails to compile here rather than silently
 * inheriting another code's sentence. Called by the human transcript and
 * by nothing else: the machine surfaces carry codes.
 */
export function describeRetrievalDegradation(code: RetrievalDegradationCode): string {
  switch (code) {
    case RETRIEVAL_DEGRADATION.keywordFtsMatchEmpty:
      return "the query carried no term the keyword index can match, so the keyword lane never ran";
    case RETRIEVAL_DEGRADATION.keywordTrigramLaneFault:
      return "the trigram candidate lane could not be read, so substring matches were not merged into the keyword pool";
    case RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent:
      return "the index holds no compatible embedding, so the semantic lane could not run";
    case RETRIEVAL_DEGRADATION.semanticVecExtensionUnavailable:
      return "the sqlite-vec extension is not loaded, so the semantic lane could not run";
    case RETRIEVAL_DEGRADATION.semanticCapabilityBlocked:
      return "the configured semantic capability blocks the vector lane, so it did not run";
    case RETRIEVAL_DEGRADATION.semanticProviderUnavailable:
      return "the embedding provider could not answer, so the semantic lane did not run";
    case RETRIEVAL_DEGRADATION.semanticEmptyQueryVector:
      return "the embedding provider returned an empty query vector, so the semantic lane was skipped";
    case RETRIEVAL_DEGRADATION.semanticStructuredLanesSkipped:
      return "the query declared a structured semantic lane while semantic search is disabled, so that lane was skipped";
    case RETRIEVAL_DEGRADATION.semanticEmbeddingAbiDrift:
      return "the index carries embeddings written by another build, so its neighbours may not be comparable";
    case RETRIEVAL_DEGRADATION.hybridDegraded:
      return "the semantic lane did not run, so this answer is keyword-only";
    case RETRIEVAL_DEGRADATION.rankCapTruncatedPool:
      return "the rank cap truncated the candidate pool, so lower-ranked matches were never considered";
    case RETRIEVAL_DEGRADATION.relevanceFloorDroppedRows:
      return "the requested relevance floor dropped every ranked row it judged, so matches below it are not in this answer";
    case RETRIEVAL_DEGRADATION.scopeFiltersDroppedRows:
      return "visibility, ownership or session scope dropped ranked rows, so this answer is narrower than the match set";
    case RETRIEVAL_DEGRADATION.crossVaultOriginFailed:
      return "a search origin could not be read, so its documents were not searched";
    case RETRIEVAL_DEGRADATION.crossVaultChainStopped:
      return "an origin answered confidently, so the remaining origins were deliberately not searched";
  }
}

/**
 * Project a {@link NegativeRecallVerdict} onto the trail's statement.
 * One projection, so the CLI and the MCP payload cannot disagree about
 * which of the verdict's fields an empty search reports.
 */
export function corpusStatementFor(verdict: NegativeRecallVerdict): RetrievalCorpusStatement {
  return Object.freeze({
    state: verdict.state,
    reason: verdict.reason,
    ...(verdict.unknown_reason !== undefined ? { unknownReason: verdict.unknown_reason } : {}),
  });
}

/**
 * The trail for one answer, or `undefined` when there is nothing to
 * report: rows came back and no lane narrowed them. That absence is what
 * keeps a healthy response byte-identical to the pre-change one.
 */
export function buildRetrievalTrail(input: {
  readonly retrieved: number;
  readonly pool: number;
  readonly degraded: ReadonlyArray<RetrievalDegradation>;
  readonly empty?: RetrievalCorpusStatement | undefined;
}): RetrievalTrail | undefined {
  if (input.retrieved > 0 && input.degraded.length === 0) return undefined;
  return Object.freeze({
    retrieved: input.retrieved,
    pool: input.pool,
    degraded: Object.freeze([...input.degraded]),
    // A degradation already accounts for the empty; the corpus statement
    // is the answer only when nothing else is.
    ...(input.empty !== undefined && input.degraded.length === 0 ? { empty: input.empty } : {}),
  });
}

/** Response key carrying the retrieval trail. */
export const RETRIEVAL_TRAIL_KEY = "retrieval_trail";

/**
 * The trail keys for one outcome, ready to spread into a response object -
 * the seam `explain-envelope.ts` proved, so the CLI `--json` payload and
 * the MCP response name the same key with the same body.
 *
 * The parameter is structural rather than `SearchOutcome`, because
 * `search/types.ts` names {@link RetrievalTrail} on the outcome and a type
 * import back from here would close that loop.
 */
export function retrievalTrailEnvelope(outcome: {
  readonly retrievalTrail?: RetrievalTrail;
}): Record<string, unknown> {
  const trail = outcome.retrievalTrail;
  if (trail === undefined) return {};
  return {
    [RETRIEVAL_TRAIL_KEY]: {
      retrieved: trail.retrieved,
      pool: trail.pool,
      degraded: trail.degraded.map((d) => (d.detail !== undefined ? { ...d } : { code: d.code })),
      ...(trail.empty !== undefined
        ? {
            empty: {
              state: trail.empty.state,
              reason: trail.empty.reason,
              ...(trail.empty.unknownReason !== undefined
                ? { unknown_reason: trail.empty.unknownReason }
                : {}),
            },
          }
        : {}),
    },
  };
}
