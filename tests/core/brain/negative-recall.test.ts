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

function snapshot(overrides: Partial<CoverageIndexSnapshot> = {}): CoverageIndexSnapshot {
  return {
    indexPath: "/vault/.o2b/search.sqlite",
    exists: true,
    schemaVersion: 12,
    documents: 42,
    chunks: 311,
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

  test("every digested field is named in the ordered field tuple", () => {
    // The tuple IS the encoding. A field added to the receipt and
    // forgotten here would silently leave the digest blind to it.
    expect([...COVERAGE_DIGEST_FIELDS]).toEqual([
      "index_path",
      "schema_version",
      "documents",
      "chunks",
      "embedding_signature",
      "last_indexed_at",
      "scope",
    ]);
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
