/**
 * U2 - typed negative recall with a digest-bound coverage receipt.
 *
 * Every case here is an assertion that one kind of "no" is told apart
 * from another kind of "no". The module under test is pure, so each
 * scenario is a literal index snapshot plus a literal scope; the wiring
 * into `brain_recall_gate` is covered by the MCP tests.
 */

import { describe, expect, test } from "bun:test";

import type { ClaimNode } from "../../../src/core/brain/claim-graph.ts";
import {
  buildCoverageReceipt,
  classifyNegativeRecall,
  COVERAGE_DIGEST_FIELDS,
  isNegativeRecallState,
  isNegativeRecallUnknownReason,
  isRetractionEvidenceKind,
  NEGATIVE_RECALL_STATE,
  NEGATIVE_RECALL_UNKNOWN_REASON,
  NegativeRecallError,
  RETRACTION_EVIDENCE_KIND,
  retractionEvidenceFromClaim,
  type CoverageIndexSnapshot,
  type CoverageScope,
} from "../../../src/core/brain/negative-recall.ts";

const INDEXED_AT = "2026-08-01T00:00:00.000Z";

/**
 * Receipt fields that are deliberately outside the digest: the digest
 * itself, and the gap the digest is explicitly not taken over.
 */
const NON_DIGESTED_RECEIPT_FIELDS = Object.freeze(["digest", "unindexed_roots"] as const);

/** The digest of `snapshot()` under `scope()`, pinned against drift. */
const KNOWN_ANSWER_DIGEST = "c9096179d5a00561535e96af00eca957b4e9c5e16aa3bd302da5c21087c02f01";

function snapshot(overrides: Partial<CoverageIndexSnapshot> = {}): CoverageIndexSnapshot {
  return {
    indexPath: "/vault/.o2b/search.sqlite",
    exists: true,
    schemaVersion: 12,
    documents: 42,
    chunks: 311,
    embeddings: 311,
    embeddingSignature: "openai:text-embedding-3-small:1536",
    lastIndexedAt: INDEXED_AT,
    staleEmbeddings: 0,
    ...overrides,
  };
}

function scope(overrides: Partial<CoverageScope> = {}): CoverageScope {
  return { authorizedRoots: ["notes"], indexedRoots: ["notes"], ...overrides };
}

function claim(overrides: Partial<ClaimNode> = {}): ClaimNode {
  return {
    id: "pref-coolant",
    path: "Brain/preferences/pref-coolant.md",
    topic: "coolant",
    principle: "principle text",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    superseded_by: null,
    contradicts: [],
    provenance: null,
    tombstoned: false,
    ...overrides,
  };
}

describe("coverage receipt", () => {
  test("is deterministic over a fixed snapshot and scope", () => {
    const a = buildCoverageReceipt(snapshot(), scope());
    const b = buildCoverageReceipt(snapshot(), scope());
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toEqual(b);
  });

  test("carries the searched facts verbatim", () => {
    const receipt = buildCoverageReceipt(snapshot(), scope());
    expect(receipt.documents).toBe(42);
    expect(receipt.chunks).toBe(311);
    expect(receipt.index_path).toBe("/vault/.o2b/search.sqlite");
    expect(receipt.schema_version).toBe(12);
    expect(receipt.embedding_signature).toBe("openai:text-embedding-3-small:1536");
    expect(receipt.last_indexed_at).toBe(INDEXED_AT);
    expect(receipt.scope).toEqual(["notes"]);
    expect(receipt.unindexed_roots).toEqual([]);
  });

  test("the digest moves when the document count moves", () => {
    const before = buildCoverageReceipt(snapshot(), scope()).digest;
    const after = buildCoverageReceipt(snapshot({ documents: 43 }), scope()).digest;
    expect(after).not.toBe(before);
  });

  test("the digest moves when the chunk count moves", () => {
    const before = buildCoverageReceipt(snapshot(), scope()).digest;
    const after = buildCoverageReceipt(snapshot({ chunks: 312 }), scope()).digest;
    expect(after).not.toBe(before);
  });

  test("the digest moves when the embedding signature moves", () => {
    const before = buildCoverageReceipt(snapshot(), scope()).digest;
    const after = buildCoverageReceipt(
      snapshot({ embeddingSignature: "openai:text-embedding-3-large:3072" }),
      scope(),
    ).digest;
    expect(after).not.toBe(before);
  });

  test("the digest moves when the searched scope moves", () => {
    const before = buildCoverageReceipt(snapshot(), scope()).digest;
    const after = buildCoverageReceipt(
      snapshot(),
      scope({ authorizedRoots: ["notes", "journal"], indexedRoots: ["notes", "journal"] }),
    ).digest;
    expect(after).not.toBe(before);
  });

  test("the digest is stable under root ordering", () => {
    const one = buildCoverageReceipt(
      snapshot(),
      scope({ authorizedRoots: ["notes", "journal"], indexedRoots: ["notes", "journal"] }),
    );
    const other = buildCoverageReceipt(
      snapshot(),
      scope({ authorizedRoots: ["journal", "notes"], indexedRoots: ["journal", "notes"] }),
    );
    expect(other.digest).toBe(one.digest);
  });

  test("building over a non-existent index throws rather than digesting zeroes", () => {
    expect(() => buildCoverageReceipt(snapshot({ exists: false }), scope())).toThrow(
      NegativeRecallError,
    );
  });

  test("carries the embedding census, so a keyword-only index is visible", () => {
    const receipt = buildCoverageReceipt(snapshot({ embeddings: 0 }), scope());
    expect(receipt.embeddings).toBe(0);
    expect(receipt.chunks).toBe(311);
  });

  test("the digest moves when the embedding census moves", () => {
    const before = buildCoverageReceipt(snapshot(), scope()).digest;
    const after = buildCoverageReceipt(snapshot({ embeddings: 0 }), scope()).digest;
    expect(after).not.toBe(before);
  });

  test("every digested field is named in the ordered field tuple", () => {
    // The tuple IS the encoding, so the assertion has to be made against
    // the RECEIPT rather than against a second copy of the tuple: a field
    // added to the receipt and forgotten in the tuple is exactly the
    // mistake this case exists to catch, and comparing the tuple to a
    // literal transcription of itself cannot catch it.
    const receipt = buildCoverageReceipt(snapshot(), scope());
    const digestable = Object.keys(receipt)
      .filter((key) => !(NON_DIGESTED_RECEIPT_FIELDS as ReadonlyArray<string>).includes(key))
      .toSorted();
    expect(digestable).toEqual([...COVERAGE_DIGEST_FIELDS].toSorted());
  });

  test("the digest is a known answer over a fixed snapshot and scope", () => {
    // Order inside the tuple is load-bearing and no membership assertion
    // can see it, so one frozen hex pins the encoding end to end. A
    // deliberate field or ordering change updates this literal; an
    // accidental one fails here.
    expect(buildCoverageReceipt(snapshot(), scope()).digest).toBe(KNOWN_ANSWER_DIGEST);
  });
});

describe("classifyNegativeRecall", () => {
  test("zero results over a healthy index is a complete not_found with a digest", () => {
    const verdict = classifyNegativeRecall({ snapshot: snapshot(), scope: scope() });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.notFound);
    expect(verdict.complete).toBe(true);
    expect(verdict.unknown_reason).toBeUndefined();
    expect(verdict.coverage?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no index at all is unknown / index-absent with no coverage", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ exists: false }),
      scope: scope(),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.complete).toBe(false);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexAbsent);
    expect(verdict.coverage).toBeUndefined();
  });

  test("unreadable index facts are unknown / coverage-unavailable, never not_found", () => {
    const verdict = classifyNegativeRecall({ snapshot: null, scope: scope() });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.coverageUnavailable);
    expect(verdict.coverage).toBeUndefined();
  });

  test("stale embeddings are unknown / index-stale with the receipt still attached", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ staleEmbeddings: 7 }),
      scope: scope(),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexStale);
    expect(verdict.coverage?.documents).toBe(42);
    expect(verdict.reason).toContain("7");
  });

  test("an index that never recorded a run is unknown / index-stale", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ lastIndexedAt: null }),
      scope: scope(),
    });
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexStale);
  });

  test("an index instant the store cannot date is unknown / index-instant-unusable", () => {
    // The value is a raw SQLite text cell, so a corrupt one is a fact
    // about the store rather than a caller error - but no comparison
    // against it can succeed, so nothing downstream may be claimed.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ lastIndexedAt: "whenever-o-clock" }),
      scope: scope(),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.complete).toBe(false);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexInstantUnusable);
    expect(verdict.coverage?.last_indexed_at).toBe("whenever-o-clock");
  });

  test("an index whose recorded model never finished embedding is unknown", () => {
    // A model IS recorded here, so its run is unfinished: part of the
    // corpus is reachable by keyword and part both ways, and no negative
    // over a half-converted index is well-founded. `staleEmbeddings`
    // cannot tell this apart - a chunk with no embedding row at all is
    // never counted stale.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ embeddings: 0, staleEmbeddings: 0 }),
      scope: scope(),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.complete).toBe(false);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.embeddingsIncomplete);
    expect(verdict.coverage?.embeddings).toBe(0);
    expect(verdict.reason).toContain("311");
  });

  test("a partially embedded index is unknown too, not a complete not_found", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ embeddings: 310 }),
      scope: scope(),
    });
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.embeddingsIncomplete);
  });

  test("a vault that never configured a model still receives a not_found", () => {
    // Running without embeddings is a supported configuration, not an
    // unfinished job: semantic search needs a key an operator may not
    // have. Refusing it would leave such a vault permanently unable to
    // receive this module's main answer, which is how a verdict stops
    // being read.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ embeddings: 0, staleEmbeddings: 0, embeddingSignature: null }),
      scope: scope(),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.notFound);
    expect(verdict.complete).toBe(true);
  });

  test("the keyword-only negative is visible in the receipt rather than implied", () => {
    // The narrower claim is not hidden by admitting it: the vector count
    // and the absent signature are both on the receipt and both inside the
    // digest, so a consumer can tell a keyword-only negative from a fully
    // embedded one and the digest moves when that changes.
    const keywordOnly = classifyNegativeRecall({
      snapshot: snapshot({ embeddings: 0, staleEmbeddings: 0, embeddingSignature: null }),
      scope: scope(),
    });
    expect(keywordOnly.coverage?.embeddings).toBe(0);
    expect(keywordOnly.coverage?.embedding_signature).toBeNull();

    const fullyEmbedded = classifyNegativeRecall({
      snapshot: snapshot({ embeddings: 311, staleEmbeddings: 0 }),
      scope: scope(),
    });
    expect(fullyEmbedded.state).toBe(NEGATIVE_RECALL_STATE.notFound);
    expect(fullyEmbedded.coverage?.digest).not.toBe(keywordOnly.coverage?.digest);
  });

  test("a configured root the index does not cover is unknown / coverage-divergent", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope({ authorizedRoots: ["notes", "journal"], indexedRoots: ["notes"] }),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.coverageDivergent);
    expect(verdict.coverage?.unindexed_roots).toEqual(["journal"]);
    expect(verdict.coverage?.scope).toEqual(["notes"]);
    expect(verdict.reason).toContain("journal");
  });

  test("an empty authorized set is not a divergence", () => {
    // `notes.read_paths` defaults to empty: the operator has authorized
    // no note folders, so there is no root the index can fail to cover.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope({ authorizedRoots: [], indexedRoots: [] }),
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.notFound);
    expect(verdict.coverage?.scope).toEqual([]);
  });
});

describe("did_not_happen is grounded, never inferred", () => {
  const evidence = {
    subject: "pref-coolant",
    kind: RETRACTION_EVIDENCE_KIND.tombstone,
    recorded_at: "2026-07-01T00:00:00.000Z",
  } as const;

  test("asserting it with no evidence at all throws", () => {
    expect(() =>
      classifyNegativeRecall({
        snapshot: snapshot(),
        scope: scope(),
        assertDidNotHappen: true,
      }),
    ).toThrow(NegativeRecallError);
  });

  test("the refusal message names the outcome dropping the assertion really gives", () => {
    // The thrown message is advice a caller acts on, so it has to name the
    // state the advised input actually produces - see the `not_found`
    // assertion below, which is that same input.
    let message = "";
    try {
      classifyNegativeRecall({ snapshot: snapshot(), scope: scope(), assertDidNotHappen: true });
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toContain(NEGATIVE_RECALL_STATE.notFound);
    expect(message).not.toContain(NEGATIVE_RECALL_STATE.unknown);
    const advised = classifyNegativeRecall({ snapshot: snapshot(), scope: scope() });
    expect(advised.state).toBe(NEGATIVE_RECALL_STATE.notFound);
  });

  test("evidence without the assertion is context, never an escalation", () => {
    // A caller that hands over retraction evidence while merely asking
    // what the corpus supports has claimed nothing, so it must not be
    // handed the strongest state in the vocabulary.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope(),
      retraction: evidence,
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.notFound);
    expect(verdict.complete).toBe(true);
  });

  test("an unusable index instant never yields a complete negative", () => {
    // The reviewer's reproduction: `Date.parse` of a corrupt cell is NaN,
    // and every comparison against NaN is false, so an unguarded
    // fall-through admitted the strongest claim in the module over an
    // index nobody could date.
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ lastIndexedAt: "whenever-o-clock" }),
      scope: scope(),
      retraction: evidence,
      assertDidNotHappen: true,
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.complete).toBe(false);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexInstantUnusable);
  });

  test("a tombstoned claim carrying an instant gives did_not_happen with coverage", () => {
    const retraction = retractionEvidenceFromClaim(
      claim({ tombstoned: true, valid_until: "2026-07-01T00:00:00.000Z" }),
    );
    expect(retraction?.kind).toBe(RETRACTION_EVIDENCE_KIND.tombstone);
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope(),
      retraction,
      assertDidNotHappen: true,
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.didNotHappen);
    expect(verdict.complete).toBe(true);
    expect(verdict.coverage?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a superseded claim gives did_not_happen and names the successor edge", () => {
    const retraction = retractionEvidenceFromClaim(
      claim({
        tombstoned: true,
        superseded_by: "pref-coolant-v2",
        valid_until: "2026-07-02T00:00:00.000Z",
      }),
    );
    expect(retraction?.kind).toBe(RETRACTION_EVIDENCE_KIND.supersededBy);
    expect(retraction?.replaced_by).toBe("pref-coolant-v2");
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope(),
      retraction,
      assertDidNotHappen: true,
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.didNotHappen);
  });

  test("a claim closed by valid_until alone is evidence too", () => {
    const retraction = retractionEvidenceFromClaim(
      claim({ valid_until: "2026-06-01T00:00:00.000Z" }),
    );
    expect(retraction?.kind).toBe(RETRACTION_EVIDENCE_KIND.validUntil);
  });

  test("a live claim yields no evidence", () => {
    expect(retractionEvidenceFromClaim(claim())).toBeNull();
  });

  test("a tombstone with no comparable instant yields no evidence", () => {
    // `ClaimNode` projects `tombstoned` as a boolean and does NOT carry
    // `tombstoned_at`, so a tombstone with no `valid_until` exposes no
    // instant to compare against the receipt. That is `unknown`, not a
    // fabricated non-occurrence.
    expect(retractionEvidenceFromClaim(claim({ tombstoned: true }))).toBeNull();
  });

  test("evidence with no coverage degrades to unknown rather than throwing", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot({ exists: false }),
      scope: scope(),
      retraction: evidence,
      assertDidNotHappen: true,
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexAbsent);
  });

  test("a retraction newer than the index the search ran over is unknown / index-stale", () => {
    const verdict = classifyNegativeRecall({
      snapshot: snapshot(),
      scope: scope(),
      retraction: { ...evidence, recorded_at: "2026-09-01T00:00:00.000Z" },
    });
    expect(verdict.state).toBe(NEGATIVE_RECALL_STATE.unknown);
    expect(verdict.unknown_reason).toBe(NEGATIVE_RECALL_UNKNOWN_REASON.indexStale);
  });

  test("evidence carrying an unusable instant is a programming error", () => {
    expect(() =>
      classifyNegativeRecall({
        snapshot: snapshot(),
        scope: scope(),
        retraction: { ...evidence, recorded_at: "not-an-instant" },
      }),
    ).toThrow(NegativeRecallError);
  });
});

describe("vocabulary guards", () => {
  test("the state guard accepts members and rejects a near miss", () => {
    expect(isNegativeRecallState(NEGATIVE_RECALL_STATE.didNotHappen)).toBe(true);
    expect(isNegativeRecallState("did-not-happen")).toBe(false);
    expect(isNegativeRecallState(null)).toBe(false);
  });

  test("the unknown-reason guard accepts members and rejects a near miss", () => {
    expect(isNegativeRecallUnknownReason(NEGATIVE_RECALL_UNKNOWN_REASON.indexStale)).toBe(true);
    expect(isNegativeRecallUnknownReason("index_stale")).toBe(false);
  });

  test("the evidence-kind guard accepts members and rejects a near miss", () => {
    expect(isRetractionEvidenceKind(RETRACTION_EVIDENCE_KIND.supersededBy)).toBe(true);
    expect(isRetractionEvidenceKind("superseded")).toBe(false);
  });
});
