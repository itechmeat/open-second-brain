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
 *   - `not_found`      - the searched corpus was verifiably complete and
 *                        held nothing matching.
 *   - `unknown`        - no honest claim about the corpus could be made,
 *                        with a named reason saying which of the four
 *                        ways that happened.
 *   - `did_not_happen` - stored evidence positively attests the thing did
 *                        not occur, and the searched corpus already
 *                        reflected that evidence.
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
 * every authorized root the index does not cover lands in
 * {@link CoverageReceipt.unindexed_roots} and forces `unknown` with
 * {@link NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent}, so a receipt
 * over the index alone cannot hide the gap either.
 *
 * A root the index carries no document under is reported as uncovered
 * even when the folder is genuinely empty. From the index alone those two
 * cases are indistinguishable, and the conservative reading - refuse to
 * claim completeness - is the one this wave exists to install.
 *
 * ## `did_not_happen` is never inferred from absence
 *
 * Absence of evidence is exactly what `not_found` reports. This state
 * requires POSITIVE stored evidence: a claim that existed and now carries
 * a tombstone, a closed `valid_until`, or a `superseded_by` edge, all of
 * which the claim graph already projects. It additionally requires that
 * the searched index is at least as new as that evidence - an index built
 * before the retraction was recorded has not seen it, and a negative from
 * it says nothing about the retraction. See
 * {@link retractionEvidenceFromClaim} for the one projection limit.
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
import type { IndexStatusSnapshot } from "../search/types.ts";

/** The three answers a negative recall can honestly give. */
export const NEGATIVE_RECALL_STATE = Object.freeze({
  /** The searched corpus was verifiably complete and held no match. */
  notFound: "not_found",
  /** No claim about the corpus could be made; `unknown_reason` says why. */
  unknown: "unknown",
  /** Stored evidence attests non-occurrence; never inferred from absence. */
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
 */
export const COVERAGE_DIGEST_FIELDS = Object.freeze([
  "index_path",
  "schema_version",
  "documents",
  "chunks",
  "embedding_signature",
  "last_indexed_at",
  "scope",
] as const);

/** Closed union over {@link COVERAGE_DIGEST_FIELDS}. */
export type CoverageDigestField = (typeof COVERAGE_DIGEST_FIELDS)[number];

/**
 * The index facts a coverage receipt is built from - structurally a
 * subset of {@link IndexStatusSnapshot}, so a real snapshot is passed
 * straight through and a test builds only the fields that matter.
 */
export type CoverageIndexSnapshot = Pick<
  IndexStatusSnapshot,
  | "indexPath"
  | "exists"
  | "schemaVersion"
  | "documents"
  | "chunks"
  | "embeddingSignature"
  | "lastIndexedAt"
  | "staleEmbeddings"
>;

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
  readonly index_path: string;
  readonly schema_version: number | null;
  readonly embedding_signature: string | null;
  readonly last_indexed_at: string | null;
  /** The searched note roots, sorted and deduplicated. */
  readonly scope: ReadonlyArray<string>;
  /** Authorized roots the index does not cover, sorted and deduplicated. */
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
   * True only when the verdict rests on a receipt over an index that
   * exists, is current, and covers every authorized root. Never true
   * alongside `unknown`.
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
   * what the corpus supports. Asserting it without evidence is a
   * programming error and throws; a caller that merely cannot verify
   * leaves this off and gets the honest `unknown`.
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
    embedding_signature: snapshot.embeddingSignature,
    last_indexed_at: snapshot.lastIndexedAt,
    scope: searched,
  };
  return Object.freeze({
    digest: sha256Hex(canonicalJson(COVERAGE_DIGEST_FIELDS.map((f) => [f, digested[f]]))),
    documents: snapshot.documents,
    chunks: snapshot.chunks,
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
 * to compare against the receipt. Such a node returns `null` here and the
 * caller gets `unknown` - a tombstone whose age is unknown cannot prove
 * that the searched index had already seen it.
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
 * `did_not_happen` both require a receipt over an index that exists, is
 * current, and covers every authorized root; anything short of that is
 * `unknown` with the reason named, never a silent `not_found`.
 */
export function classifyNegativeRecall(input: NegativeRecallInput): NegativeRecallVerdict {
  const evidence = input.retraction ?? null;
  if (input.assertDidNotHappen === true && evidence === null) {
    throw new NegativeRecallError(
      `negative recall: cannot assert ${NEGATIVE_RECALL_STATE.didNotHappen} with no retraction evidence; omit the assertion to receive an honest ${NEGATIVE_RECALL_STATE.unknown}`,
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
  if (snapshot.staleEmbeddings > 0) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
      `${snapshot.staleEmbeddings} of ${snapshot.chunks} chunk(s) carry an out-of-date embedding`,
      coverage,
    );
  }
  if (coverage.unindexed_roots.length > 0) {
    return unknownVerdict(
      NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent,
      `the index covers ${coverage.scope.length} of ${coverage.scope.length + coverage.unindexed_roots.length} authorized note root(s); not covered: ${coverage.unindexed_roots.join(", ")}`,
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
    if (recordedMs > Date.parse(snapshot.lastIndexedAt)) {
      return unknownVerdict(
        NEGATIVE_RECALL_UNKNOWN_REASON.indexStale,
        `the retraction of ${evidence.subject} was recorded at ${evidence.recorded_at}, after the index was last built at ${snapshot.lastIndexedAt}`,
        coverage,
      );
    }
    return Object.freeze({
      state: NEGATIVE_RECALL_STATE.didNotHappen,
      complete: true,
      coverage,
      reason: `${evidence.subject} carries a ${evidence.kind} edge recorded at ${evidence.recorded_at}, which the index at ${snapshot.lastIndexedAt} already reflects`,
    });
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
