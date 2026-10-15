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
  RETRIEVAL_TRUST_GATE_NAME,
  classifyRetrievalTrust,
  collectTrustGateRefusals,
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

/** Mixed-signal frontmatter map keyed by the path names the tests use. */
const frontmatter = (path: string): FrontmatterMap =>
  path === "bad.md"
    ? { status: "quarantine", [UNTRUSTED_SOURCE_TAG]: true }
    : path === "tainted.md"
      ? { [ENTITY_CONTAMINATION_FRONTMATTER_KEY]: true }
      : {};

function result(path: string, chunkId = 10): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId,
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
    const adjuster = trustGateAdjuster((path): FrontmatterMap =>
      path === "bad.md" ? { status: "quarantine" } : {},
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

  test("under shadow the classification runs but every candidate is kept", () => {
    const saw: string[] = [];
    const adjuster = trustGateAdjuster((path): FrontmatterMap => {
      saw.push(path);
      return path === "bad.md" ? { status: "quarantine" } : {};
    }, "shadow");
    expect(adjuster.adjust(result("bad.md"))).toEqual({ kind: "keep" });
    expect(adjuster.adjust(result("ok.md"))).toEqual({ kind: "keep" });
    // The classification itself still ran over the candidate.
    expect(saw).toEqual(["bad.md", "ok.md"]);
  });

  test("enforce named explicitly behaves exactly as the default", () => {
    const adjuster = trustGateAdjuster(
      (path): FrontmatterMap => (path === "bad.md" ? { status: "quarantine" } : {}),
      "enforce",
    );
    expect(adjuster.adjust(result("bad.md"))).toEqual({
      kind: "exclude",
      reason: RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine,
    });
  });
});

describe("collectTrustGateRefusals", () => {
  test("records every would-be refusal with all its structural reasons, pool lane", () => {
    const refusals = collectTrustGateRefusals(
      [result("bad.md", 10), result("ok.md", 11), result("tainted.md", 12)],
      frontmatter,
    );
    expect(refusals).toEqual([
      {
        document_id: 1,
        chunk_id: 10,
        path: "bad.md",
        reasons: [
          `${RETRIEVAL_TRUST_GATE_NAME}:${RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine}`,
          `${RETRIEVAL_TRUST_GATE_NAME}:${RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance}`,
        ],
        lane: "pool",
      },
      {
        document_id: 1,
        chunk_id: 12,
        path: "tainted.md",
        reasons: [
          `${RETRIEVAL_TRUST_GATE_NAME}:${RETRIEVAL_TRUST_EXCLUSION_REASON.entityContamination}`,
        ],
        lane: "pool",
      },
    ]);
  });

  test("a clean pool collects nothing", () => {
    expect(collectTrustGateRefusals([result("ok.md")], frontmatter)).toEqual([]);
    expect(collectTrustGateRefusals([], frontmatter)).toEqual([]);
  });
});
