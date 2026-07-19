/**
 * Retrieval trust gate (t_5f61130a): the first consumer of kernel 1.
 *
 * The gate classifies a candidate as quarantined DETERMINISTICALLY from
 * three structural / provenance signals already in the codebase - the
 * self-approval guardrail state (preference status `quarantine`), the
 * untrusted-source provenance marker, and the entity-contamination
 * marker - and contributes an exclude-with-reason verdict for each. It
 * reads only controlled-vocabulary frontmatter keys, never note prose,
 * so there is no natural-language word list anywhere.
 */

import { test, expect, describe } from "bun:test";

import {
  RETRIEVAL_TRUST_EXCLUSION_REASON,
  classifyRetrievalTrust,
  trustGateAdjuster,
} from "../../../../src/core/brain/trust/retrieval-gate.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../../../src/core/brain/untrusted-source.ts";
import { ENTITY_CONTAMINATION_FRONTMATTER_KEY } from "../../../../src/core/brain/truth/contamination.ts";
import type { FrontmatterMap } from "../../../../src/core/types.ts";
import type { BrainSearchResult } from "../../../../src/core/search/types.ts";

describe("classifyRetrievalTrust", () => {
  test("clean frontmatter is not quarantined", () => {
    const verdict = classifyRetrievalTrust({ status: "confirmed" });
    expect(verdict.quarantined).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  test("preference status quarantine is quarantined (self-approval guardrail state)", () => {
    const verdict = classifyRetrievalTrust({ status: "quarantine" });
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toEqual([RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine]);
  });

  test("normalized `_status: quarantine` is also detected", () => {
    const verdict = classifyRetrievalTrust({ _status: "quarantine" });
    expect(verdict.quarantined).toBe(true);
  });

  test("untrusted-source provenance marker is quarantined", () => {
    const verdict = classifyRetrievalTrust({ [UNTRUSTED_SOURCE_TAG]: true });
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toEqual([RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance]);
  });

  test("entity-contamination marker is quarantined", () => {
    const verdict = classifyRetrievalTrust({ [ENTITY_CONTAMINATION_FRONTMATTER_KEY]: true });
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toEqual([RETRIEVAL_TRUST_EXCLUSION_REASON.entityContamination]);
  });

  test("multiple signals surface every reason, sorted deterministically", () => {
    const verdict = classifyRetrievalTrust({
      status: "quarantine",
      [UNTRUSTED_SOURCE_TAG]: "true",
      [ENTITY_CONTAMINATION_FRONTMATTER_KEY]: true,
    });
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toEqual([
      RETRIEVAL_TRUST_EXCLUSION_REASON.entityContamination,
      RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine,
      RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance,
    ]);
  });
});

function result(path: string): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 10,
    path,
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 0.5,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([]),
  });
}

describe("trustGateAdjuster", () => {
  test("excludes a quarantined candidate with the joined reason", () => {
    const adjuster = trustGateAdjuster(
      (path): FrontmatterMap => (path === "bad.md" ? { status: "quarantine" } : {}),
    );
    expect(adjuster.adjust(result("bad.md"))).toEqual({
      kind: "exclude",
      reason: RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine,
    });
  });

  test("keeps a clean candidate", () => {
    const adjuster = trustGateAdjuster(() => ({ status: "confirmed" }));
    expect(adjuster.adjust(result("ok.md"))).toEqual({ kind: "keep" });
  });
});
