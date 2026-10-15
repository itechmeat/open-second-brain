/**
 * Document-dedup detector (storage lifecycle, Lane 4 task 4.1).
 *
 * Ingest summary pages (kind `brain-source`) that carry near-identical
 * bodies are retirement candidates: one canonical page should survive and
 * the stale copies should be retired with their records. The detector
 * only nominates groups; retirement happens through the hygiene apply
 * plan (action `retire`), which routes to the retirement core.
 *
 * Decisions pinned here:
 *   - canonical is the NEWEST `created_at` (keep-newest);
 *   - a group holding ANY member without `created_at` is ineligible -
 *     the mtime fallback is merge-unstable (GitHub #180), so such a
 *     group is reported for review, never for retirement;
 *   - merge-resolved members leave the pool (the shared predicate);
 *   - scope keys keep folding: identical text in two scopes never groups.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../../../src/core/search/embeddings/contract.ts";
import { DEFAULT_SCAN_IDS, HYGIENE_DETECTOR_IDS } from "../../../src/core/brain/hygiene/types.ts";
import { applyHygienePlan } from "../../../src/core/brain/hygiene/apply.ts";
import { buildHygienePlan } from "../../../src/core/brain/hygiene/plan.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import {
  DOCUMENT_DEDUP_LEXICAL_THRESHOLD,
  detectDocumentDedup,
  detectSemanticDocumentDedup,
} from "../../../src/core/brain/hygiene/detectors/document-dedup.ts";
import { hygieneFindingId } from "../../../src/core/brain/hygiene/detectors/id.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-document-dedup-"));
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const NEAR_A =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const NEAR_B =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";
const UNRELATED = "Use tabs inside makefiles and keep the tab width at two spaces";

interface SourcePageOptions {
  readonly body: string;
  readonly createdAt?: string;
  readonly sourcePath?: string;
  readonly mergedInto?: string;
  readonly kind?: string;
  readonly project?: string;
}

/** Write one ingest summary page; returns its vault-relative path. */
function writeSourcePage(slug: string, opts: SourcePageOptions): string {
  const lines = [
    "---",
    `kind: ${opts.kind ?? "brain-source"}`,
    `source_path: ${opts.sourcePath ?? `imports/${slug}.md`}`,
    `source_hash: ${"a".repeat(64)}`,
  ];
  if (opts.createdAt !== undefined) lines.push(`created_at: ${opts.createdAt}`);
  if (opts.mergedInto !== undefined) lines.push(`merged_into: ${opts.mergedInto}`);
  if (opts.project !== undefined) lines.push(`project: ${opts.project}`);
  lines.push("tags: [brain, brain/source]", "---", "", opts.body, "");
  const abs = join(vault, "Brain", "sources", `src-${slug}.md`);
  writeFileSync(abs, lines.join("\n"), "utf8");
  return `Brain/sources/src-${slug}.md`;
}

function detect(): ReturnType<typeof detectDocumentDedup> {
  return detectDocumentDedup(vault, { now: new Date(0) });
}

describe("detectDocumentDedup", () => {
  test("groups near-duplicate summary pages and keeps the newest created_at canonical", () => {
    const older = writeSourcePage("older", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    const newer = writeSourcePage("newer", { body: NEAR_B, createdAt: "2026-02-01T00:00:00Z" });
    writeSourcePage("unrelated", { body: UNRELATED, createdAt: "2026-03-01T00:00:00Z" });

    const findings = detect();
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.detector).toBe("document-dedup");
    expect(finding.severity).toBe("warning");
    expect(finding.proposed_action).toBe("retire");
    expect(finding.targets).toEqual([older, newer].toSorted());
    expect(finding.id).toBe(hygieneFindingId("document-dedup", [older, newer]));
    expect(finding.evidence["method"]).toBe("lexical");
    expect(finding.evidence["threshold"]).toBe(DOCUMENT_DEDUP_LEXICAL_THRESHOLD);
    expect(finding.evidence["canonical"]).toBe(newer);
  });

  test("a created_at tie breaks on the id ascending", () => {
    const alpha = writeSourcePage("alpha", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    const beta = writeSourcePage("beta", { body: NEAR_B, createdAt: "2026-01-01T00:00:00Z" });
    const findings = detect();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence["canonical"]).toBe([alpha, beta].toSorted()[0]);
  });

  test("a group holding any member without created_at is ineligible for retirement", () => {
    const stamped = writeSourcePage("stamped", {
      body: NEAR_A,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const unstamped = writeSourcePage("unstamped", { body: NEAR_B });

    const findings = detect();
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.proposed_action).toBe("review");
    expect(finding.evidence["ineligible"]).toBe(true);
    expect(String(finding.evidence["reason"])).toContain("created_at");
    expect(finding.evidence["members_without_created_at"]).toEqual([unstamped]);
    expect(finding.evidence["canonical"]).toBeUndefined();
    expect(finding.targets).toEqual([stamped, unstamped].toSorted());
  });

  test("a member a merge already resolved leaves the pool", () => {
    writeSourcePage("live", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("resolved", {
      body: NEAR_B,
      createdAt: "2026-02-01T00:00:00Z",
      mergedInto: "pref-elsewhere",
    });
    expect(detect()).toHaveLength(0);
  });

  test("identical text in two scopes never groups", () => {
    writeSourcePage("alpha", {
      body: NEAR_A,
      createdAt: "2026-01-01T00:00:00Z",
      project: "alpha",
    });
    writeSourcePage("beta", {
      body: NEAR_B,
      createdAt: "2026-01-02T00:00:00Z",
      project: "beta",
    });
    expect(detect()).toHaveLength(0);
  });

  test("a pair below the lexical threshold is not nominated", () => {
    writeSourcePage("one", {
      body: "Collect the latency metrics before optimizing the render loop",
      createdAt: "2026-01-01T00:00:00Z",
    });
    writeSourcePage("two", {
      body: "Collect the garbage after every render pass and keep the loop quiet",
      createdAt: "2026-01-02T00:00:00Z",
    });
    expect(detect()).toHaveLength(0);
  });

  test("pages that are not ingest summaries are ignored", () => {
    writeSourcePage("pref", {
      body: NEAR_A,
      createdAt: "2026-01-01T00:00:00Z",
      kind: "brain-preference",
    });
    writeSourcePage("other", {
      body: NEAR_B,
      createdAt: "2026-01-02T00:00:00Z",
      kind: "brain-preference",
    });
    expect(detect()).toHaveLength(0);
  });

  test("pages too short to compare safely are skipped", () => {
    writeSourcePage("tiny-a", { body: "Use tabs", createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("tiny-b", { body: "Use tabs", createdAt: "2026-01-02T00:00:00Z" });
    expect(detect()).toHaveLength(0);
  });

  test("a member the caller cannot read is treated as absent", () => {
    writeSourcePage("visible", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    const hidden = writeSourcePage("hidden", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });
    const findings = detectDocumentDedup(vault, {
      now: new Date(0),
      readable: (rel) => rel !== hidden,
    });
    expect(findings).toHaveLength(0);
  });

  test("findings come out in a deterministic order across runs", () => {
    writeSourcePage("r-one", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("r-two", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });
    writeSourcePage("r-three", {
      body: "Watch the commit queue and rebase the patch series before review",
      createdAt: "2026-01-03T00:00:00Z",
    });
    writeSourcePage("r-four", {
      body: "Watch the commit queue and rebase the patch series before merge",
      createdAt: "2026-01-04T00:00:00Z",
    });
    const first = detect().map((f) => f.id);
    const second = detect().map((f) => f.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  // Token sets of ten with a one-word slide: A~B and B~C clear the
  // lexical threshold while A~C (two slides apart) sits under it.
  const CHAIN_A = Array.from({ length: 10 }, (_, i) => `kw${String(i + 1).padStart(2, "0")}`).join(
    " ",
  );
  const CHAIN_B = Array.from({ length: 10 }, (_, i) => `kw${String(i + 2).padStart(2, "0")}`).join(
    " ",
  );
  const CHAIN_C = Array.from({ length: 10 }, (_, i) => `kw${String(i + 3).padStart(2, "0")}`).join(
    " ",
  );

  /**
   * The A-B-C chain: (A,B) and (B,C) pair above the threshold, (A,C)
   * does not, so the union-find still forms ONE component. Keep-newest
   * picks C - which is NOT directly similar to A - and the transitive
   * gate decides what may retire.
   */
  function seedChain(): { a: string; b: string; c: string } {
    const a = writeSourcePage("chain-a", { body: CHAIN_A, createdAt: "2026-01-01T00:00:00Z" });
    const b = writeSourcePage("chain-b", { body: CHAIN_B, createdAt: "2026-01-02T00:00:00Z" });
    const c = writeSourcePage("chain-c", { body: CHAIN_C, createdAt: "2026-01-03T00:00:00Z" });
    return { a, b, c };
  }

  test("a member with no direct pair to the canonical is never a retire target", () => {
    seedChain();

    const findings = detect();
    expect(findings).toHaveLength(2);
    const retire = findings.find((f) => f.proposed_action === "retire")!;
    const review = findings.find((f) => f.proposed_action === "review")!;

    // Only the copy DIRECTLY similar to the canonical C is retirable.
    const { b, c } = { b: "Brain/sources/src-chain-b.md", c: "Brain/sources/src-chain-c.md" };
    expect(retire.targets).toEqual([b, c].toSorted());
    expect(retire.evidence["canonical"]).toBe(c);
    // The transitive member lands in review with the reason in evidence.
    expect(review.targets).toEqual(["Brain/sources/src-chain-a.md", c].toSorted());
    expect(review.evidence["ineligible"]).toBe(true);
    expect(String(review.evidence["reason"])).toContain("transitive");
    expect(review.evidence["members_without_direct_pair"]).toEqual([
      "Brain/sources/src-chain-a.md",
    ]);
  });

  test("every member with a direct pair still retires through the pipeline", () => {
    const { a, b } = seedChain();
    const report = runHygieneScan(vault, { detectors: ["document-dedup"], now: new Date(0) });
    const retire = report.findings.find((f) => f.proposed_action === "retire")!;
    const plan = buildHygienePlan(report, { ids: [retire.id] });
    expect(plan.selected).toHaveLength(1);
    expect(plan.excluded_review).toEqual([]);

    // The finding is derelived by the applier from the same evidence
    // shape a scan produced: applying it must remove ONLY the copy
    // directly similar to the canonical (B) and leave the transitive
    // member (A) on disk.
    return applyHygienePlan(vault, plan, { agent: "tester", now: new Date(0) }).then((result) => {
      expect(result.errors).toEqual([]);
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]!.detail).toContain("retired 1 near-duplicate cop");
      expect(existsSync(join(vault, a))).toBe(true);
      expect(existsSync(join(vault, b))).toBe(false);
    });
  });
});

describe("document-dedup registration", () => {
  test("the detector is registered and opt-in", () => {
    expect(HYGIENE_DETECTOR_IDS).toContain("document-dedup");
    expect(DEFAULT_SCAN_IDS).not.toContain("document-dedup");
  });

  test("the default sweep does not run it; an explicit subset does", () => {
    writeSourcePage("scan-a", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("scan-b", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });

    const defaultSweep = runHygieneScan(vault, { now: new Date(0) });
    expect(defaultSweep.counts["document-dedup"]).toBeUndefined();

    const explicit = runHygieneScan(vault, {
      detectors: ["document-dedup"],
      now: new Date(0),
    });
    expect(explicit.errors).toHaveLength(0);
    expect(explicit.counts["document-dedup"]).toBe(1);
    expect(explicit.findings[0]!.proposed_action).toBe("retire");
  });
});

describe("detectSemanticDocumentDedup", () => {
  function fixedVectorProvider(vectors: Readonly<Record<string, number[]>>): EmbeddingProvider {
    return {
      name: "fixed",
      model: "fixed-test",
      dimension: 3,
      embed: (texts) => Promise.resolve(texts.map((text) => vectors[text] ?? [0, 0, 1])),
      ping: () => Promise.resolve({ ok: true as const, dimension: 3 }),
    };
  }

  test("groups by embedding cosine at the embedding threshold", async () => {
    const older = writeSourcePage("emb-old", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    const newer = writeSourcePage("emb-new", { body: NEAR_B, createdAt: "2026-02-01T00:00:00Z" });
    const provider = fixedVectorProvider({
      [NEAR_A]: [1, 0, 0],
      [NEAR_B]: [0.999, 0.0447, 0],
      [UNRELATED]: [0, 1, 0],
    });
    const result = await detectSemanticDocumentDedup(vault, { provider });
    expect(result.method).toBe("embedding");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.targets).toEqual([older, newer].toSorted());
    expect(finding.proposed_action).toBe("retire");
    expect(finding.evidence["method"]).toBe("embedding");
    expect(finding.evidence["model"]).toBe("fixed-test");
    expect(finding.evidence["canonical"]).toBe(newer);
  });

  test("falls back to the lexical layer, labeled, when the provider fails", async () => {
    writeSourcePage("lex-a", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("lex-b", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });
    const broken: EmbeddingProvider = {
      name: "broken",
      model: "broken",
      dimension: 3,
      embed: () => Promise.reject(new Error("provider down")),
      ping: () => Promise.resolve({ ok: false as const, reason: "down" }),
    };
    const result = await detectSemanticDocumentDedup(vault, { provider: broken });
    expect(result.method).toBe("lexical");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence["method"]).toBe("lexical");
  });

  test("no usable provider means the lexical layer", async () => {
    const result = await detectSemanticDocumentDedup(vault, { provider: null });
    expect(result.method).toBe("lexical");
    expect(result.findings).toHaveLength(0);
  });

  test("a page the caller cannot read is scored and named by no semantic pair", async () => {
    writeSourcePage("emb-vis-1", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("emb-vis-2", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });
    const hidden = writeSourcePage("emb-hidden", {
      body: NEAR_A,
      createdAt: "2026-01-03T00:00:00Z",
    });
    const provider = fixedVectorProvider({
      [NEAR_A]: [1, 0, 0],
      [NEAR_B]: [0.999, 0.0447, 0],
    });

    const result = await detectSemanticDocumentDedup(vault, {
      provider,
      readable: (rel) => rel !== hidden,
    });

    expect(result.method).toBe("embedding");
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result.findings)).not.toContain(hidden);
  });

  test("records across different scope keys never pair, semantically either", async () => {
    writeSourcePage("scope-alpha", {
      body: NEAR_A,
      createdAt: "2026-01-01T00:00:00Z",
      project: "alpha",
    });
    writeSourcePage("scope-beta", {
      body: NEAR_B,
      createdAt: "2026-01-02T00:00:00Z",
      project: "beta",
    });
    const provider = fixedVectorProvider({
      [NEAR_A]: [1, 0, 0],
      [NEAR_B]: [1, 0, 0],
    });

    const result = await detectSemanticDocumentDedup(vault, { provider });

    expect(result.method).toBe("embedding");
    expect(result.findings).toHaveLength(0);
  });

  test("a provider returning inconsistent vector dimensions falls back, labeled", async () => {
    writeSourcePage("rag-a", { body: NEAR_A, createdAt: "2026-01-01T00:00:00Z" });
    writeSourcePage("rag-b", { body: NEAR_B, createdAt: "2026-01-02T00:00:00Z" });
    // Dimension mismatch inside one embed call: the vectors-length check
    // models this for a count mismatch; a shape mismatch is the same
    // broken-provider answer.
    const ragged: EmbeddingProvider = {
      name: "ragged",
      model: "ragged",
      dimension: 3,
      embed: (texts) => Promise.resolve(texts.map((_, i) => (i === 0 ? [1, 0] : [1, 0, 0]))),
      ping: () => Promise.resolve({ ok: true as const, dimension: 3 }),
    };

    const result = await detectSemanticDocumentDedup(vault, { provider: ragged });

    expect(result.method).toBe("lexical");
    // The fallback still finds the lexical pair - it just never calls
    // the fabricated cosine score semantic.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence["method"]).toBe("lexical");
  });
});
