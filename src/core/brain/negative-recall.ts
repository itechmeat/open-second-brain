/**
 * U2 - what does a "no" from this system actually claim?
 *
 * Every negative the recall stack produces today is a statement about
 * the RETRIEVAL ATTEMPT, never about the CORPUS. A zero-result search
 * over a stale, partial or never-built index is byte-identical to one
 * over a complete index, so a caller cannot tell an exhaustive negative
 * from an under-powered one. That is the same failure as an integrity
 * check that could not run reporting the same thing as one that passed.
 *
 * This module supplies the corpus statement:
 *
 *   - `not_found`      - the searched corpus was ADMISSIBLE (defined
 *                        below) and held nothing matching.
 *   - `unknown`        - no honest claim about the corpus could be made,
 *                        with a named reason saying which way that
 *                        happened.
 *   - `did_not_happen` - stored evidence positively attests the thing did
 *                        not occur, the caller asserted non-occurrence,
 *                        and the searched corpus already reflected that
 *                        evidence.
 *
 * ## What "admissible" means, precisely
 *
 * The word does real work, so it is spelled out rather than implied. An
 * index is admissible when all four hold, each of them a fact the index
 * reports about itself:
 *
 *   1. it exists and its facts could be read;
 *   2. it recorded a completed run, stamped with a readable instant;
 *   3. it carries at least one document under every authorized note root;
 *   4. it holds a current embedding for every chunk it holds.
 *
 * That is narrower than "the vault was searched exhaustively", and the
 * gap is named rather than hidden: (3) is satisfied by ONE document under
 * a root, so a folder of a thousand notes with one indexed note passes
 * it. The index cannot tell that case from a folder holding exactly one
 * note - it knows what it was given, never what it was not - so the
 * receipt reports the document count beside the root list and a reader
 * judging weight reads that. Closing the gap needs a filesystem census
 * against `resolveNoteRoots`, which this pure module deliberately does
 * not do.
 *
 * ## Why this is not part of `recall-adequacy.ts`
 *
 * That module's single responsibility is SCORE FITNESS: given the top-k
 * relevance scores of an attempt, is the grounding strong enough to
 * answer. It never looks at the corpus and it must not start to. Negative
 * recall is the orthogonal axis - not "were the hits good enough" but
 * "was the haystack the whole haystack" - so it is a sibling in the same
 * idiom rather than a widening of a well-scoped type. The two compose:
 * the recall gate computes adequacy first and reaches for this module
 * only on the zero-usable-result path.
 *
 * ## The receipt is over the SEARCHED set, and it names the gap
 *
 * Two universes disagree. `resolveNoteRoots` (notes/note-walk.ts)
 * enumerates the AUTHORIZED set - the note folders the operator declared
 * in `notes.read_paths`. `indexStatus` (search/indexer.ts) describes the
 * SEARCHED set - what the index actually holds. The digest is taken over
 * the searched set, because that is the only universe a negative can
 * honestly attest to; a receipt over the authorized set would claim
 * coverage that was never achieved. The divergence is not swallowed:
 * every authorized root the index holds no document under lands in
 * {@link CoverageReceipt.unindexed_roots} and forces `unknown` with
 * {@link NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent}, so a receipt
 * over the index alone cannot hide the gap either.
 *
 * A root the index carries no document under is reported that way even
 * when the folder is genuinely empty. From the index alone those two
 * cases are indistinguishable, and the conservative reading - refuse to
 * claim completeness - is the one this wave exists to install. The
 * reverse asymmetry is condition (3) above: presence of one document is
 * not proof the root was read out, which is why the receipt reports the
 * document count and this module never calls a root exhausted.
 *
 * ## `did_not_happen` is never inferred from absence
 *
 * Absence of evidence is exactly what `not_found` reports. This state
 * requires POSITIVE stored evidence: a claim that existed and now carries
 * a tombstone, a closed `valid_until`, or a `superseded_by` edge, all of
 * which the claim graph already projects. It additionally requires that
 * the searched index is at least as new as that evidence - an index built
 * before the retraction was recorded has not seen it, and a negative from
 * it says nothing about the retraction - and that the caller ASSERTED
 * non-occurrence, so evidence handed over for context is never turned
 * into a verdict nobody asked for. See {@link retractionEvidenceFromClaim}
 * for the one projection limit.
 *
 * ### Deferred on the shipped surface
 *
 * No caller in `src/` supplies either half of that pair yet: the recall
 * gate in `src/mcp/search-tools.ts` passes neither evidence nor an
 * assertion, and nothing there reads the claim graph. So
 * `did_not_happen` is currently reachable through this function only, not
 * through `brain_recall_gate`, and that surface declares the narrower
 * subset it can actually produce rather than advertising a state its
 * handler cannot emit. Reading the claim graph on the gate's zero-result
 * path is a design decision with its own cost, taken separately; the arm
 * and its tests stay so that decision remains a wiring change.
 *
 * ## Pure by construction
 *
 * No filesystem, no clock, no store. Callers hand in the index facts and
 * the two root sets; the recall gate in `src/mcp/search-tools.ts` is the
 * wiring. That keeps every state above reachable in a unit test without a
 * vault, which is what makes the refusals testable at all.
 */

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import type { ClaimNode } from "./claim-graph.ts";

/** The three answers a negative recall can honestly give. */
export const NEGATIVE_RECALL_STATE = Object.freeze({
  /** The searched index was admissible (module docblock) and held no match. */
  notFound: "not_found",
  /** No claim about the corpus could be made; `unknown_reason` says why. */
  unknown: "unknown",
  /**
   * Stored evidence attests non-occurrence and the caller claimed it;
   * never inferred from absence and never from evidence alone.
   */
  didNotHappen: "did_not_happen",
} as const);

/** Closed union over {@link NEGATIVE_RECALL_STATE}. */
export type NegativeRecallState =
  (typeof NEGATIVE_RECALL_STATE)[keyof typeof NEGATIVE_RECALL_STATE];

/** Membership list, ordered from weakest to strongest claim. */
export const NEGATIVE_RECALL_STATES: ReadonlyArray<NegativeRecallState> = Object.freeze([
  NEGATIVE_RECALL_STATE.notFound,
  NEGATIVE_RECALL_STATE.unknown,
  NEGATIVE_RECALL_STATE.didNotHappen,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isNegativeRecallState(value: unknown): value is NegativeRecallState {
  return (
    typeof value === "string" && (NEGATIVE_RECALL_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Why no claim about the corpus could be made. Each member is a fact
 * about this vault's index, never a guess: none of them is a softer way
 * of saying `not_found`.
 */
export const NEGATIVE_RECALL_UNKNOWN_REASON = Object.freeze({
  /** There is no index, so nothing was searched and nothing can be attested. */
  indexAbsent: "index-absent",
  /**
   * The index exists but is not current: it carries embeddings that no
   * longer match their chunks, it has never recorded a completed run, or
   * the grounding evidence postdates the last run. A search over it may
   * simply not have seen the document.
   */
  indexStale: "index-stale",
  /**
   * The index does not cover every authorized note root; the uncovered
   * roots are named in {@link CoverageReceipt.unindexed_roots}. Part of
   * the corpus the operator authorized was never searched.
   */
  coverageDivergent: "coverage-divergent",
  /**
   * The index facts themselves could not be read, so not even the
   * absent/stale distinction could be drawn. Deliberately NOT
   * `index-absent` - an unreadable index is not a missing one.
   */
  coverageUnavailable: "coverage-unavailable",
  /**
   * The index recorded a completed run but stamped it with an instant no
   * calendar can read. Deliberately NOT `index-stale`: that reason means
   * the index is measurably behind, whereas this one means the
   * measurement is impossible, and every comparison this module makes
   * against the index instant is unsatisfiable while it holds.
   */
  indexInstantUnusable: "index-instant-unusable",
  /**
   * The index records an embedding model and holds fewer vectors than
   * chunks, so that model's run did not finish and part of the corpus is
   * reachable only by keyword while the rest is reachable both ways. No
   * negative over a half-converted index is well-founded.
   *
   * Deliberately NOT raised when no model was recorded at all: running
   * without embeddings is a supported configuration rather than an
   * unfinished job, and refusing it would leave such a vault permanently
   * unable to receive a `not_found`. The vector count and the signature
   * are in the receipt and in its digest either way, so the narrower
   * keyword-only negative is visible to whoever reads it.
   *
   * `staleEmbeddings` cannot report this case: a chunk with no embedding
   * row at all has no stored vector to be stale against.
   */
  embeddingsIncomplete: "embeddings-incomplete",
} as const);

/** Closed union over {@link NEGATIVE_RECALL_UNKNOWN_REASON}. */
export type NegativeRecallUnknownReason =
  (typeof NEGATIVE_RECALL_UNKNOWN_REASON)[keyof typeof NEGATIVE_RECALL_UNKNOWN_REASON];

/** Membership list for {@link NEGATIVE_RECALL_UNKNOWN_REASON}. */
export const NEGATIVE_RECALL_UNKNOWN_REASONS: ReadonlyArray<NegativeRecallUnknownReason> =
  Object.freeze([
    NEGATIVE_RECALL_UNKNOWN_REASON.indexAbsent,
    NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
    NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent,
    NEGATIVE_RECALL_UNKNOWN_REASON.coverageUnavailable,
    NEGATIVE_RECALL_UNKNOWN_REASON.indexInstantUnusable,
    NEGATIVE_RECALL_UNKNOWN_REASON.embeddingsIncomplete,
  ]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isNegativeRecallUnknownReason(
  value: unknown,
): value is NegativeRecallUnknownReason {
  return (
    typeof value === "string" &&
    (NEGATIVE_RECALL_UNKNOWN_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Which stored edge carries the non-occurrence. The values are the
 * frontmatter field names the claim graph projects, so a persisted
 * verdict names the same thing the vault does.
 */
export const RETRACTION_EVIDENCE_KIND = Object.freeze({
  /** The claim's file is marked tombstoned. */
  tombstone: "tombstone",
  /** The claim's validity window is closed and nothing replaced it. */
  validUntil: "valid_until",
  /** The claim was replaced; the successor id rides on the evidence. */
  supersededBy: "superseded_by",
} as const);

/** Closed union over {@link RETRACTION_EVIDENCE_KIND}. */
export type RetractionEvidenceKind =
  (typeof RETRACTION_EVIDENCE_KIND)[keyof typeof RETRACTION_EVIDENCE_KIND];

/** Membership list for {@link RETRACTION_EVIDENCE_KIND}. */
export const RETRACTION_EVIDENCE_KINDS: ReadonlyArray<RetractionEvidenceKind> = Object.freeze([
  RETRACTION_EVIDENCE_KIND.tombstone,
  RETRACTION_EVIDENCE_KIND.validUntil,
  RETRACTION_EVIDENCE_KIND.supersededBy,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isRetractionEvidenceKind(value: unknown): value is RetractionEvidenceKind {
  return (
    typeof value === "string" &&
    (RETRACTION_EVIDENCE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The ordered tuple the coverage digest is taken over.
 *
 * Order is load-bearing: the digest is computed over the field/value
 * PAIRS in this sequence, not over an object whose keys a canonical
 * serializer would sort for us. That makes the constant the encoding
 * itself, so a field appended here changes every digest deliberately and
 * visibly rather than by accident of key ordering.
 *
 * `unindexed_roots` is deliberately absent. The digest attests to what
 * WAS searched; the gap is reported beside it and forces `unknown`
 * anyway, so folding it in would make two receipts over the same searched
 * corpus disagree.
 *
 * `embeddings` was appended after the first draft of this tuple, which
 * changed every digest computed by it. That is deliberate and harmless
 * here because no release has carried a coverage receipt yet, so there is
 * no stored digest for the new encoding to contradict. Any later addition
 * does not get the same freedom: it would have to be introduced as a
 * second encoding rather than a silent recomputation of the first.
 */
export const COVERAGE_DIGEST_FIELDS = Object.freeze([
  "index_path",
  "schema_version",
  "documents",
  "chunks",
  "embeddings",
  "embedding_signature",
  "last_indexed_at",
  "scope",
] as const);

/** Closed union over {@link COVERAGE_DIGEST_FIELDS}. */
export type CoverageDigestField = (typeof COVERAGE_DIGEST_FIELDS)[number];

/**
 * The index facts a coverage receipt is built from - structurally the
 * subset of the search layer's `IndexStatusSnapshot` this module reads,
 * so a real snapshot is passed straight through and a test builds only
 * the fields that matter.
 *
 * Declared here rather than `Pick`ed off that type, because this module
 * is the one the retrieval trail's vocabulary reaches for and the search
 * layer's own type aggregate now names the trail: a type import back into
 * `search/types.ts` would close that loop and fail the import-cycle
 * ratchet. Nothing is lost by declaring it - the tie is still checked
 * where it matters, at the call site that assigns a real snapshot to this
 * type, which stops compiling the moment either side renames a field.
 */
export interface CoverageIndexSnapshot {
  readonly indexPath: string;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly embeddingSignature: string | null;
  readonly lastIndexedAt: string | null;
  readonly staleEmbeddings: number;
}

/** The two universes a negative is judged against. */
export interface CoverageScope {
  /**
   * Note roots the operator authorized, from `resolveNoteRoots`. An
   * empty list is not a defect: `notes.read_paths` defaults to empty,
   * which declares no note space at all, so there is no root the index
   * can fail to cover and the negative is simply not root-scoped.
   */
  readonly authorizedRoots: ReadonlyArray<string>;
  /** Authorized roots the index actually carries documents under. */
  readonly indexedRoots: ReadonlyArray<string>;
}

/** A digest-bound attestation of the corpus a negative was drawn from. */
export interface CoverageReceipt {
  /** SHA-256 over {@link COVERAGE_DIGEST_FIELDS}, lowercase hex. */
  readonly digest: string;
  readonly documents: number;
  readonly chunks: number;
  /**
   * Stored embedding rows. Reported beside `chunks` because the two
   * together, and only together, say how much of the index a semantic
   * query could reach: `embeddings` below `chunks` is a keyword-only or
   * half-embedded corpus, which supports a narrower negative.
   */
  readonly embeddings: number;
  readonly index_path: string;
  readonly schema_version: number | null;
  readonly embedding_signature: string | null;
  readonly last_indexed_at: string | null;
  /**
   * Authorized note roots the index carries AT LEAST ONE document under,
   * sorted and deduplicated. Presence, never exhaustiveness: the index
   * cannot know how many documents the folder holds on disk, so a root
   * listed here is one the index reached, not one it read out. `documents`
   * above is what a reader weighs that against.
   */
  readonly scope: ReadonlyArray<string>;
  /**
   * Authorized roots the index holds no document under at all, sorted and
   * deduplicated - the complement of `scope` over the authorized set.
   */
  readonly unindexed_roots: ReadonlyArray<string>;
}

/** Stored positive evidence that something did not occur. */
export interface RetractionEvidence {
  /** Identifier of the claim the evidence hangs off. */
  readonly subject: string;
  readonly kind: RetractionEvidenceKind;
  /** ISO-8601 instant the retraction took effect. */
  readonly recorded_at: string;
  /** Successor id, present only for {@link RETRACTION_EVIDENCE_KIND.supersededBy}. */
  readonly replaced_by?: string;
}

/** The verdict on one negative recall. */
export interface NegativeRecallVerdict {
  readonly state: NegativeRecallState;
  /**
   * True only when the verdict rests on a receipt over an ADMISSIBLE
   * index, in the sense the module docblock spells out - which is a
   * statement about what the index reports about itself, never a promise
   * that every authored note reached it. Never true alongside `unknown`.
   */
  readonly complete: boolean;
  /** Present whenever a receipt could be built - absent, never null. */
  readonly coverage?: CoverageReceipt;
  /** Machine-independent explanation, built from identifiers and integers. */
  readonly reason: string;
  /** Present exactly when `state` is `unknown`. */
  readonly unknown_reason?: NegativeRecallUnknownReason;
}

/** Everything {@link classifyNegativeRecall} needs to reach a verdict. */
export interface NegativeRecallInput {
  /** Index facts, or `null` when they could not be read at all. */
  readonly snapshot: CoverageIndexSnapshot | null;
  readonly scope: CoverageScope;
  /** Stored non-occurrence evidence, when the caller found any. */
  readonly retraction?: RetractionEvidence | null;
  /**
   * True when the caller CLAIMS non-occurrence rather than merely asking
   * what the corpus supports.
   *
   * This flag GOVERNS the escalation to `did_not_happen`: evidence alone
   * never produces that state, because passing evidence for context is not
   * the same act as claiming the thing did not happen. Both are required.
   *
   * Asserting it without evidence is a programming error and throws. A
   * caller that leaves it off is asking the weaker question and gets the
   * weaker answer - `not_found` over an admissible index, or a named
   * refusal - even when its evidence would have supported more.
   */
  readonly assertDidNotHappen?: boolean;
}

/**
 * Raised when a negative recall is asked to claim more than its evidence
 * supports: a receipt over an index that does not exist, an assertion of
 * non-occurrence with nothing behind it, or evidence carrying an instant
 * that cannot be compared against the receipt.
 */
export class NegativeRecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NegativeRecallError";
  }
}

/** Sorted, deduplicated, blank-free - the canonical form of a root list. */
function normalizeRoots(roots: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([...new Set(roots.filter((root) => root.trim().length > 0))].toSorted());
}

/**
 * Build the digest-bound receipt for one index snapshot and scope.
 *
 * Throws when the snapshot reports that the index does not exist. A
 * receipt over a missing index would be a digest of zeroes attesting to
 * an empty universe, which reads exactly like an exhaustively searched
 * one - the misleading fallback this unit exists to remove. Callers
 * handle that condition through
 * {@link NEGATIVE_RECALL_UNKNOWN_REASON.indexAbsent} instead.
 */
export function buildCoverageReceipt(
  snapshot: CoverageIndexSnapshot,
  scope: CoverageScope,
): CoverageReceipt {
  if (!snapshot.exists) {
    throw new NegativeRecallError(
      `negative recall: refusing to build a coverage receipt over a non-existent index (${snapshot.indexPath})`,
    );
  }
  const searched = normalizeRoots(scope.indexedRoots);
  const searchedSet = new Set(searched);
  const unindexed = normalizeRoots(
    normalizeRoots(scope.authorizedRoots).filter((root) => !searchedSet.has(root)),
  );
  const digested: Readonly<Record<CoverageDigestField, unknown>> = {
    index_path: snapshot.indexPath,
    schema_version: snapshot.schemaVersion,
    documents: snapshot.documents,
    chunks: snapshot.chunks,
    embeddings: snapshot.embeddings,
    embedding_signature: snapshot.embeddingSignature,
    last_indexed_at: snapshot.lastIndexedAt,
    scope: searched,
  };
  return Object.freeze({
    digest: sha256Hex(canonicalJson(COVERAGE_DIGEST_FIELDS.map((f) => [f, digested[f]]))),
    documents: snapshot.documents,
    chunks: snapshot.chunks,
    embeddings: snapshot.embeddings,
    index_path: snapshot.indexPath,
    schema_version: snapshot.schemaVersion,
    embedding_signature: snapshot.embeddingSignature,
    last_indexed_at: snapshot.lastIndexedAt,
    scope: searched,
    unindexed_roots: unindexed,
  });
}

/**
 * Project one claim-graph node into retraction evidence, or `null` when
 * the node carries none that this module can use.
 *
 * `brain_claims` operations `history` and `replaced` already return these
 * nodes, so the evidence path reuses the projection rather than reading
 * frontmatter a second time.
 *
 * One projection limit, stated rather than papered over: {@link ClaimNode}
 * exposes `tombstoned` as a BOOLEAN and does not carry `tombstoned_at`,
 * so a tombstone whose file declares no `valid_until` exposes no instant
 * to compare against the receipt. Such a node returns `null` here, which
 * leaves the caller with NO evidence: over an admissible corpus the
 * verdict is then the ordinary `not_found` (absence of a match, which is
 * all a search actually observed), and an attempt to assert non-occurrence
 * on it is refused by {@link classifyNegativeRecall}. What the null never
 * does is prove non-occurrence - a tombstone whose age is unknown cannot
 * show that the searched index had already seen it.
 *
 * No shipped surface calls this yet; see the deferral in the module
 * docblock. It is the unit-level half of the evidence arm, kept and tested
 * so that wiring it later is a call-site change rather than a design one.
 */
export function retractionEvidenceFromClaim(claim: ClaimNode): RetractionEvidence | null {
  const recordedAt = claim.valid_until;
  if (recordedAt === null || !Number.isFinite(Date.parse(recordedAt))) return null;
  if (claim.superseded_by !== null) {
    return Object.freeze({
      subject: claim.id,
      kind: RETRACTION_EVIDENCE_KIND.supersededBy,
      recorded_at: recordedAt,
      replaced_by: claim.superseded_by,
    });
  }
  return Object.freeze({
    subject: claim.id,
    kind: claim.tombstoned
      ? RETRACTION_EVIDENCE_KIND.tombstone
      : RETRACTION_EVIDENCE_KIND.validUntil,
    recorded_at: recordedAt,
  });
}

/**
 * Decide what a negative from this corpus is entitled to claim.
 *
 * The admissibility rule in one sentence: `not_found` and
 * `did_not_happen` both require a receipt over an ADMISSIBLE index -
 * one that exists, carries a datable completed run, reaches every
 * authorized root, and holds a current embedding for every chunk it
 * holds - and anything short of that is `unknown` with the reason named,
 * never a silent `not_found`.
 *
 * The admissibility checks run widest gap first: nothing searched, then
 * nothing datable, then a root never reached, then vectors that are out
 * of date or do not cover what was reached. A doubly-short index
 * therefore reports the outermost of its shortfalls, which is the one an
 * operator fixes first, and the narrower ones surface on the next pass.
 *
 * Beyond admissibility, the escalation to `did_not_happen` is governed by
 * `assertDidNotHappen`, not by the mere presence of evidence: see
 * {@link NegativeRecallInput.assertDidNotHappen}.
 */
export function classifyNegativeRecall(input: NegativeRecallInput): NegativeRecallVerdict {
  const evidence = input.retraction ?? null;
  if (input.assertDidNotHappen === true && evidence === null) {
    // The advice names `not_found` because that is what the advised input
    // actually yields over an admissible corpus: a search that found
    // nothing observed absence, which is the definition of that state.
    // Promising `unknown` here would send a caller after a WEAKER answer
    // than the one it is about to receive.
    throw new NegativeRecallError(
      `negative recall: cannot assert ${NEGATIVE_RECALL_STATE.didNotHappen} with no retraction evidence; omit the assertion to receive the corpus statement the search supports (${NEGATIVE_RECALL_STATE.notFound} over an admissible index, otherwise a named refusal)`,
    );
  }

  const { snapshot } = input;
  if (snapshot === null) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.coverageUnavailable,
      "index facts could not be read, so nothing is known about the searched corpus",
    );
  }
  if (!snapshot.exists) {
    // The configured index path is deliberately NOT quoted here. Every
    // reason built by this module may be persisted into a continuity
    // record and replicated between devices, and a host filesystem path
    // is not vault content. Callers that need it read it from the index
    // status surface, where it is a structured field rather than prose.
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.indexAbsent,
      "no index exists at the configured path, so nothing was searched",
    );
  }

  const coverage = buildCoverageReceipt(snapshot, input.scope);
  if (snapshot.lastIndexedAt === null) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
      "the index has never recorded a completed run, so its coverage cannot be dated",
      coverage,
    );
  }
  // `lastIndexedAt` is a raw text cell in the index's own state table and
  // this function is exported, so the value reaching here is not
  // guaranteed to be a calendar instant. It is not treated as a caller
  // error, unlike the evidence instant below: it is the STORE's value, so
  // the honest report is a refusal about this vault's index. Validated
  // BEFORE any comparison, because `Date.parse` yields NaN and every
  // comparison against NaN is false - an unguarded fall-through would let
  // an undatable index admit the strongest claim in the module.
  const indexedMs = Date.parse(snapshot.lastIndexedAt);
  if (!Number.isFinite(indexedMs)) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.indexInstantUnusable,
      "the index stamped its last completed run with an instant that cannot be read as a date, so nothing can be dated against it",
      coverage,
    );
  }
  if (coverage.unindexed_roots.length > 0) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent,
      `the index reaches ${coverage.scope.length} of ${coverage.scope.length + coverage.unindexed_roots.length} authorized note root(s); not reached: ${coverage.unindexed_roots.join(", ")}`,
      coverage,
    );
  }
  if (snapshot.staleEmbeddings > 0) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
      `${snapshot.staleEmbeddings} of ${snapshot.chunks} chunk(s) carry an out-of-date embedding`,
      coverage,
    );
  }
  // Vectors that do not cover the chunks are the narrowest admissibility
  // gap and the easiest to mistake for a pass: a chunk with no embedding
  // row is counted by NEITHER `staleEmbeddings` nor the document census,
  // so an index with no embeddings at all clears every check above.
  //
  // But "fewer vectors than chunks" is two different situations, and only
  // one of them is indeterminate. A model was recorded for this index and
  // its run did not finish - so part of the corpus is reachable one way
  // and part another, and no negative over it is well-founded. Versus: no
  // model was ever recorded, which is a supported way to run this system
  // (semantic search needs a key the operator may not have) and a
  // deliberate, coherent configuration. Refusing the latter would leave a
  // keyword-only vault permanently unable to receive this module's main
  // answer, which is how a verdict stops being read. The receipt carries
  // the vector count and the signature and the digest binds both, so a
  // consumer can see the negative was keyword-only and judge for itself.
  const embeddingModelRecorded = snapshot.embeddingSignature !== null;
  if (embeddingModelRecorded && snapshot.embeddings < snapshot.chunks) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.embeddingsIncomplete,
      `the index records embedding model '${snapshot.embeddingSignature}' and holds ${snapshot.embeddings} embedding(s) for ${snapshot.chunks} chunk(s), so its run is unfinished and part of the corpus is unreachable by a semantic query`,
      coverage,
    );
  }

  if (evidence !== null) {
    const recordedMs = Date.parse(evidence.recorded_at);
    if (!Number.isFinite(recordedMs)) {
      throw new NegativeRecallError(
        `negative recall: retraction evidence for ${evidence.subject} carries an unusable instant (${evidence.recorded_at})`,
      );
    }
    // The instant comparison is what makes the evidence load-bearing: an
    // index built before the retraction was recorded never saw it, so a
    // negative drawn from it attests to nothing about the retraction.
    // Checked whether or not the caller asserted anything, because an
    // index that predates known evidence is stale as a matter of fact and
    // its `not_found` would be no better founded than its
    // `did_not_happen`.
    if (recordedMs > indexedMs) {
      return unknownVerdict(
        NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
        `the retraction of ${evidence.subject} was recorded at ${evidence.recorded_at}, after the index was last built at ${snapshot.lastIndexedAt}`,
        coverage,
      );
    }
    // The assertion, not the evidence, is what escalates. A caller may
    // hand over retraction evidence while merely asking what the corpus
    // supports - the recall gate does exactly that with the adequacy
    // verdict - and answering it with the strongest state in the
    // vocabulary would be a claim it never made. Without the assertion
    // the evidence has still done work: it gated the staleness check
    // above, and the `not_found` below is now known to come from an index
    // that had already seen the retraction.
    if (input.assertDidNotHappen === true) {
      return Object.freeze({
        state: NEGATIVE_RECALL_STATE.didNotHappen,
        complete: true,
        coverage,
        reason: `${evidence.subject} carries a ${evidence.kind} edge recorded at ${evidence.recorded_at}, which the index at ${snapshot.lastIndexedAt} already reflects`,
      });
    }
  }

  return Object.freeze({
    state: NEGATIVE_RECALL_STATE.notFound,
    complete: true,
    coverage,
    reason: `no match across ${coverage.documents} document(s) and ${coverage.chunks} chunk(s) indexed at ${snapshot.lastIndexedAt}`,
  });
}

/** Every `unknown` leaves through here, so the shape cannot drift. */
function unknownVerdict(
  reason: NegativeRecallUnknownReason,
  detail: string,
  coverage?: CoverageReceipt,
): NegativeRecallVerdict {
  return Object.freeze({
    state: NEGATIVE_RECALL_STATE.unknown,
    complete: false,
    // Absent rather than null when no receipt could be built, matching
    // the optional-block convention the recall-gate output already uses.
    ...(coverage !== undefined ? { coverage } : {}),
    reason: detail,
    unknown_reason: reason,
  });
}
