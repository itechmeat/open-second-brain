/**
 * Score-aware tail trim for delivered evidence (t_cb6a5558).
 *
 * The trim runs after the unified tier/budget walk, only when the caller
 * opted in via `tailTrim` AND a query is present to score against. It
 * keeps the pack's top delivered items, keeps any tail item whose
 * query-term overlap is at least TAIL_TRIM_KEEP_FRACTION of the top
 * delivered score (it restates the question's terms), drops the rest
 * whole with `"tail-trim"` skips, and offers the freed budget back to
 * `over-budget` candidates in priority order.
 *
 * Claims pinned here:
 *   1. An absent option, an explicit false, a flag-on pack without a
 *      query, and a flag-on pack with a tokenless query are all
 *      byte-identical to the legacy pack.
 *   2. The trim keeps top-3 head items immune: a head item below the
 *      bar survives while an equal-scoring tail item is dropped.
 *   3. The restatement keep-rule fires exactly at the fraction: a tail
 *      item at >= 0.8 of the top delivered score is kept.
 *   4. Dropped tail items become whole `"tail-trim"` skip entries and
 *      the telemetry gap `tail_trim`; the report counters and the
 *      receipt/telemetry budget metadata carry the trim only when it ran.
 *   5. The rescue re-admits `over-budget` candidates in priority order
 *      within `maxTokens`, retracts their `over-budget` skips, and never
 *      reorders or drops the synthesized attention item.
 *   6. Ranked mode reuses the comparator's relevance scores.
 *   7. The `packingPolicy` branch is untouched: a named policy never
 *      produces the trim report.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import { listAttentionFlows } from "../../../src/core/brain/attention-flows.ts";
import { listContextReceipts } from "../../../src/core/brain/context-receipts.ts";
import { RECALL_CHANNEL, listRecallTelemetry } from "../../../src/core/brain/recall-telemetry.ts";

let vault: string;

/** Five tokens, so the jaccard fractions land on controllable values. */
const QUERY = "alpha beta gamma delta epsilon";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pack-tail-trim-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { principle: string; created_at: string; body?: string },
): void {
  const lines = [
    "---",
    `id: pref-${slug}`,
    "topic: a b",
    `principle: ${fields.principle}`,
    "tier: core",
    `created_at: ${fields.created_at}`,
    "---",
    "",
    fields.body ?? "",
  ];
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

/**
 * Five pages whose `topic` tokenises to nothing and whose principle
 * carries the query verbatim, so substring mode keeps every page and
 * recency alone decides the delivery order. Body extras differentiate
 * the trim scores: pref-a 1.0, pref-b 5/6, pref-c 5/8, pref-d 5/6,
 * pref-e 5/13.
 */
function writeRestatementVault(): void {
  writePref("a", { principle: QUERY, created_at: "2026-05-05T00:00:00Z" });
  writePref("b", { principle: QUERY, created_at: "2026-05-04T00:00:00Z", body: "zeta" });
  writePref("c", {
    principle: QUERY,
    created_at: "2026-05-03T00:00:00Z",
    body: "zeta eta theta",
  });
  writePref("d", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "zeta" });
  writePref("e", {
    principle: QUERY,
    created_at: "2026-05-01T00:00:00Z",
    body: "zeta eta theta iota kappa lambda mu nu",
  });
}

describe("packContext tailTrim byte identity", () => {
  test("an absent option and an explicit false are byte-identical", () => {
    writeRestatementVault();
    const absent = packContext(vault, { maxTokens: 10_000, query: QUERY });
    const off = packContext(vault, { maxTokens: 10_000, query: QUERY, tailTrim: false });
    expect(off.tailTrim).toBeUndefined();
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent));
    // Nothing was trimmed: all five pages delivered in recency order.
    expect(absent.items.map((i) => i.id)).toEqual([
      "pref-a",
      "pref-b",
      "pref-c",
      "pref-d",
      "pref-e",
    ]);
    expect(absent.skipped).toEqual([]);
  });

  test("the flag on without a query is byte-identical - there is nothing to score against", () => {
    writeRestatementVault();
    const baseline = packContext(vault, { maxTokens: 10_000 });
    const noQuery = packContext(vault, { maxTokens: 10_000, tailTrim: true });
    expect(noQuery.tailTrim).toBeUndefined();
    expect(JSON.stringify(noQuery)).toBe(JSON.stringify(baseline));
  });

  test("the flag on with a tokenless query is byte-identical", () => {
    writeRestatementVault();
    // Ranked mode: no substring filter to trip, so the only difference a
    // tokenless query could make is the trim - and a query that
    // tokenises to nothing scores every candidate 0, cannot
    // discriminate, and must not run.
    const baseline = packContext(vault, { maxTokens: 10_000, query: "   ", queryMode: "ranked" });
    const tokenless = packContext(vault, {
      maxTokens: 10_000,
      query: "   ",
      queryMode: "ranked",
      tailTrim: true,
    });
    expect(tokenless.tailTrim).toBeUndefined();
    expect(JSON.stringify(tokenless)).toBe(JSON.stringify(baseline));
  });
});

describe("packContext tailTrim trim and keep rules", () => {
  test("substring mode: the restatement keep-rule fires and the tail drops whole", () => {
    writeRestatementVault();
    const r = packContext(vault, { maxTokens: 10_000, query: QUERY, tailTrim: true });
    // Head (3) immune: pref-a, pref-b, pref-c. Tail: pref-d (5/6 >= 0.8
    // of the 1.0 top score) kept by query terms; pref-e (5/13) dropped.
    expect(r.items.map((i) => i.id)).toEqual(["pref-a", "pref-b", "pref-c", "pref-d"]);
    const drop = r.skipped.find((s) => s.reason === "tail-trim");
    expect(drop).toEqual({ id: "pref-e", tokens: expect.any(Number), reason: "tail-trim" });
    expect(drop!.tokens).toBeGreaterThan(0);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 1,
      rescued: 0,
      tokensSaved: drop!.tokens,
    });
    // The freed budget is visible in the recomputed spend.
    expect(r.tokensUsed).toBe(r.items.reduce((sum, item) => sum + item.tokens, 0));
  });

  test("ranked mode: head immunity beats the bar - an equal-scoring tail item drops", () => {
    // pref-pa scores 1.0; pb/pc/pd score 5/8 each. Ranked order: pa,
    // then the three ties by recency. The head keeps pb and pc even
    // though both sit below the 0.8 bar; pd, the equal-scoring tail
    // item, is dropped - position, not score, shields the head.
    writePref("pa", { principle: QUERY, created_at: "2026-05-04T00:00:00Z" });
    writePref("pb", {
      principle: QUERY,
      created_at: "2026-05-03T00:00:00Z",
      body: "zeta eta theta",
    });
    writePref("pc", {
      principle: QUERY,
      created_at: "2026-05-02T00:00:00Z",
      body: "zeta eta theta",
    });
    writePref("pd", {
      principle: QUERY,
      created_at: "2026-05-01T00:00:00Z",
      body: "zeta eta theta",
    });
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      queryMode: "ranked",
      tailTrim: true,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-pa", "pref-pb", "pref-pc"]);
    expect(r.skipped.map((s) => ({ id: s.id, reason: s.reason }))).toEqual([
      { id: "pref-pd", reason: "tail-trim" },
    ]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 0,
      rescued: 0,
      tokensSaved: r.skipped[0]!.tokens,
    });
  });

  test("ranked mode reuses the comparator scores: a tail item exactly at the fraction is kept", () => {
    // Scores: p1 1.0, p2 5/6, p3 4/5 = exactly the 0.8 fraction,
    // p4 5/6 (older than p2, so it ties into position 3), p5 0. Ranked
    // order: p1, p2, p4 (head), then p3 and p5 in the tail. p3 sits
    // exactly at the fraction and is kept by query terms; p5 drops.
    writePref("p1", { principle: QUERY, created_at: "2026-05-05T00:00:00Z" });
    writePref("p2", { principle: QUERY, created_at: "2026-05-04T00:00:00Z", body: "zeta" });
    writePref("p3", { principle: "alpha beta gamma delta", created_at: "2026-05-03T00:00:00Z" });
    writePref("p4", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "zeta" });
    writePref("p5", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-01T00:00:00Z",
    });
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      queryMode: "ranked",
      tailTrim: true,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-p1", "pref-p2", "pref-p4", "pref-p3"]);
    expect(r.skipped.map((s) => ({ id: s.id, reason: s.reason }))).toEqual([
      { id: "pref-p5", reason: "tail-trim" },
    ]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 1,
      rescued: 0,
      tokensSaved: r.skipped[0]!.tokens,
    });
  });

  test("ranked mode, a real-token query matching nothing: the zero bar keeps every delivered item", () => {
    // The query tokenises (so the trim runs - a tokenless query never
    // would) but shares no token with any page: every score is 0, the top
    // delivered score is 0, and the keep bar is 0 with it. Nothing was
    // dropped, so nothing is rescued and nothing is saved; the tail items
    // sit exactly AT the bar (0 >= 0) and are kept - a query that cannot
    // discriminate must not trim the pack it also could not rank.
    writePref("z1", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-05T00:00:00Z",
    });
    writePref("z2", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-04T00:00:00Z",
      body: "zeta",
    });
    writePref("z3", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-03T00:00:00Z",
      body: "zeta eta theta",
    });
    writePref("z4", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-02T00:00:00Z",
      body: "zeta",
    });
    writePref("z5", {
      principle: "unrelated words about caching systems",
      created_at: "2026-05-01T00:00:00Z",
      body: "zeta eta theta iota kappa lambda mu nu",
    });
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: "omega sigma tau",
      queryMode: "ranked",
      tailTrim: true,
    });
    // All scores 0: the ranked order falls through to recency, and the
    // whole delivered set survives the trim whole.
    expect(r.items.map((i) => i.id)).toEqual([
      "pref-z1",
      "pref-z2",
      "pref-z3",
      "pref-z4",
      "pref-z5",
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.tailTrim).toEqual({ dropped: 0, keptByQueryTerms: 2, rescued: 0, tokensSaved: 0 });
  });

  test("a trim that ran but had no tail still reports, with zero counters", () => {
    writePref("s1", { principle: QUERY, created_at: "2026-05-03T00:00:00Z" });
    writePref("s2", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "zeta" });
    writePref("s3", { principle: QUERY, created_at: "2026-05-01T00:00:00Z", body: "zeta" });
    const r = packContext(vault, { maxTokens: 10_000, query: QUERY, tailTrim: true });
    expect(r.items.map((i) => i.id)).toEqual(["pref-s1", "pref-s2", "pref-s3"]);
    expect(r.tailTrim).toEqual({ dropped: 0, keptByQueryTerms: 0, rescued: 0, tokensSaved: 0 });
  });
});

describe("packContext tailTrim rescue", () => {
  test("freed budget is offered to over-budget candidates in priority order within maxTokens", () => {
    // Substring mode keeps every page (the principle carries the query)
    // and recency decides the walk order. Tokens: p1 0, p2 3, p3 3,
    // p4 2, p5 1, p6 1. maxTokens 8: the walk delivers p1-p4 (used 8)
    // and reports p5 and p6 over-budget. The trim drops p4 (score 5/6
    // minus two extras = 5/7 < 0.8), freeing 2 tokens; the rescue then
    // re-admits p5 (5/6 >= 0.8) and p6 (5/6 >= 0.8) in walk order.
    writePref("p1", { principle: QUERY, created_at: "2026-05-06T00:00:00Z" });
    writePref("p2", {
      principle: QUERY,
      created_at: "2026-05-05T00:00:00Z",
      body: "x1 x2 x3 x4",
    });
    writePref("p3", {
      principle: QUERY,
      created_at: "2026-05-04T00:00:00Z",
      body: "y1 y2 y3 y4",
    });
    writePref("p4", { principle: QUERY, created_at: "2026-05-03T00:00:00Z", body: "z1 z2" });
    writePref("p5", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "z1" });
    writePref("p6", { principle: QUERY, created_at: "2026-05-01T00:00:00Z", body: "z1" });
    const r = packContext(vault, { maxTokens: 8, query: QUERY, tailTrim: true });
    // p4 dropped whole, p5 and p6 rescued at the tail in priority order.
    expect(r.items.map((i) => i.id)).toEqual([
      "pref-p1",
      "pref-p2",
      "pref-p3",
      "pref-p5",
      "pref-p6",
    ]);
    expect(r.skipped).toEqual([{ id: "pref-p4", tokens: expect.any(Number), reason: "tail-trim" }]);
    expect(r.tailTrim).toEqual({ dropped: 1, keptByQueryTerms: 0, rescued: 2, tokensSaved: 0 });
    expect(r.tokensUsed).toBeLessThanOrEqual(8);
  });

  test("an over-budget candidate below the restatement bar keeps its over-budget skip", () => {
    writePref("p1", { principle: QUERY, created_at: "2026-05-05T00:00:00Z" });
    writePref("p2", {
      principle: QUERY,
      created_at: "2026-05-04T00:00:00Z",
      body: "x1 x2 x3 x4",
    });
    writePref("p3", {
      principle: QUERY,
      created_at: "2026-05-03T00:00:00Z",
      body: "y1 y2 y3 y4",
    });
    writePref("p4", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "z1 z2" });
    // p5 is older, over-budget at the walk, and below the bar: the
    // rescue must not re-admit it even though it would fit.
    writePref("p5", { principle: QUERY, created_at: "2026-05-01T00:00:00Z", body: "z1 z2" });
    const r = packContext(vault, { maxTokens: 8, query: QUERY, tailTrim: true });
    expect(r.items.map((i) => i.id)).toEqual(["pref-p1", "pref-p2", "pref-p3"]);
    // Skips keep walk order (p5 went over-budget first); the trim's
    // whole-item drop appends after.
    expect(r.skipped.map((s) => ({ id: s.id, reason: s.reason }))).toEqual([
      { id: "pref-p5", reason: "over-budget" },
      { id: "pref-p4", reason: "tail-trim" },
    ]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 0,
      rescued: 0,
      tokensSaved: r.skipped[1]!.tokens,
    });
  });

  test("the rescue never touches the synthesized attention item", () => {
    writeRestatementVault();
    listAttentionFlows(vault); // bootstraps the default flow fixtures
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      tailTrim: true,
      attentionFlowIds: ["open-loops"],
    });
    // The attention block sits at the head, inside the immune keep
    // count, and stays first after the trim. The tail past the head
    // keeps pref-d (5/6 restates the query) and drops pref-c (5/8) and
    // pref-e (5/13) whole.
    expect(r.items[0]!.id).toBe("attention-flows");
    expect(r.items.map((i) => i.id)).toEqual(["attention-flows", "pref-a", "pref-b", "pref-d"]);
    expect(r.skipped.filter((s) => s.id === "attention-flows")).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(["pref-c", "pref-e"]);
    expect(r.tailTrim).toEqual({
      dropped: 2,
      keptByQueryTerms: 1,
      rescued: 0,
      tokensSaved: expect.any(Number),
    });
  });
});

describe("packContext tailTrim telemetry and receipts", () => {
  test("the trim counters ride the receipt budget and the telemetry metadata, and the gap surfaces", () => {
    writeRestatementVault();
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      tailTrim: true,
      receipt: { trigger: "context_pack", host: "tail-trim-test" },
      telemetry: { host: "tail-trim-test", channel: RECALL_CHANNEL.cli },
    });
    expect(r.tailTrim).toBeDefined();
    const telemetryRecords = listRecallTelemetry(vault, { mode: "context_pack" });
    expect(telemetryRecords).toHaveLength(1);
    const metadata = telemetryRecords[0]!.payload["metadata"] as Record<string, unknown>;
    expect(metadata["tail_trim_dropped"]).toBe(1);
    expect(metadata["tail_trim_kept_by_query_terms"]).toBe(1);
    expect(metadata["tail_trim_rescued"]).toBe(0);
    expect(metadata["tail_trim_tokens_saved"]).toBe(r.tailTrim!.tokensSaved);
    expect(telemetryRecords[0]!.payload["gaps"]).toContain("tail_trim");
    const receiptRecords = listContextReceipts(vault);
    expect(receiptRecords).toHaveLength(1);
    const budget = receiptRecords[0]!.payload["budget"] as Record<string, unknown>;
    expect(budget["tail_trim_dropped"]).toBe(1);
    expect(budget["tail_trim_kept_by_query_terms"]).toBe(1);
    expect(budget["tail_trim_rescued"]).toBe(0);
    expect(budget["tail_trim_tokens_saved"]).toBe(r.tailTrim!.tokensSaved);
  });

  test("an untrimmed pack carries no trim counters and no tail_trim gap", () => {
    writeRestatementVault();
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      receipt: { trigger: "context_pack", host: "tail-trim-test" },
      telemetry: { host: "tail-trim-test", channel: RECALL_CHANNEL.cli },
    });
    expect(r.tailTrim).toBeUndefined();
    const telemetryRecords = listRecallTelemetry(vault, { mode: "context_pack" });
    expect(telemetryRecords).toHaveLength(1);
    const metadata = telemetryRecords[0]!.payload["metadata"] as Record<string, unknown>;
    expect("tail_trim_dropped" in metadata).toBe(false);
    expect("tail_trim_tokens_saved" in metadata).toBe(false);
    expect(telemetryRecords[0]!.payload["gaps"]).not.toContain("tail_trim");
    const receiptRecords = listContextReceipts(vault);
    expect(receiptRecords).toHaveLength(1);
    const budget = receiptRecords[0]!.payload["budget"] as Record<string, unknown>;
    expect("tail_trim_dropped" in budget).toBe(false);
  });
});

describe("packContext tailTrim scope", () => {
  test("the packingPolicy branch never produces the trim report", () => {
    writePref("a", { principle: QUERY, created_at: "2026-05-02T00:00:00Z" });
    writeFileSync(
      join(vault, "Brain", "retired", "retired-old.md"),
      [
        "---",
        "id: retired-old",
        "topic: a b",
        `principle: ${QUERY}`,
        "tier: core",
        "created_at: 2026-05-01T00:00:00Z",
        "---",
        "",
        "zeta",
      ].join("\n"),
    );
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      tailTrim: true,
      packingPolicy: "facts_first",
    });
    expect(r.packing).toBeDefined();
    expect(r.tailTrim).toBeUndefined();
  });
});
