/**
 * Score-aware tail trim for delivered evidence (t_cb6a5558).
 *
 * The trim runs after the unified tier/budget walk, only when the caller
 * opted in via `tailTrim` AND a query is present to score against. It
 * keeps the pack's top delivered items, keeps any tail item whose
 * query-term COVERAGE - the fraction of the query's tokens the item
 * carries - is at least TAIL_TRIM_KEEP_FRACTION of the top delivered
 * item's (it restates the question's terms), drops the rest whole with
 * `"tail-trim"` skips, and offers the freed budget back to
 * `over-budget` candidates in priority order.
 *
 * Claims pinned here:
 *   1. An absent option, an explicit false, a flag-on pack without a
 *      query, and a flag-on pack with a tokenless query are all
 *      byte-identical to the legacy pack.
 *   2. The trim keeps top-3 head items immune: a head item below the
 *      bar survives while an equal-scoring tail item is dropped.
 *   3. The restatement keep-rule scores query-term coverage, so a long
 *      body carrying every query term is kept whatever its length, and
 *      the rule fires exactly at the fraction: a tail item at 0.8
 *      coverage is kept.
 *   4. Dropped tail items become whole `"tail-trim"` skip entries and
 *      the telemetry gap `tail_trim`; the report counters and the
 *      receipt/telemetry budget metadata carry the trim only when it ran.
 *   5. The rescue re-admits `over-budget` candidates in priority order
 *      within `maxTokens`, retracts their `over-budget` skips, and never
 *      reorders or drops the synthesized attention item.
 *   6. The trim scores coverage in every mode - ranked included - never
 *      the ranked comparator's jaccard, whose union grows with the
 *      page's own length.
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

/** Five tokens, so the ranked-mode jaccard fractions land on controllable values. */
const QUERY = "alpha beta gamma delta epsilon";

/**
 * Four tokens, so a page that fuses the query's last term into a
 * longer token (`delta-off`) passes the substring filter while its
 * coverage - 3 of 4 terms, 0.75 - lands below the 0.8 bar. (With five
 * query terms the same trick misses one term and scores exactly 0.8,
 * which the inclusive bar keeps.)
 */
const PARTIAL_QUERY = "alpha beta gamma delta";

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
 * recency alone decides the delivery order. Every page covers all five
 * query terms - coverage 1.0 each - so the trim has nothing to drop
 * here; the flag-off byte-identity pins use it, and the trim-active
 * tests use {@link writePartialTailVault}, whose pages separate.
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

/**
 * Five pages in recency order whose trim scores separate under
 * query-term coverage ({@link PARTIAL_QUERY}): a, b and c restate the
 * query verbatim; d restates it just as fully and carries a LONG body
 * that repeats every query term - coverage 1.0, where the jaccard
 * kernel the ranked comparator uses scores it 1/3 because the union
 * grows with the page's own vocabulary (the M1 defect: the trim kept
 * the short ones, not the restating ones); e passes the substring
 * filter only by fusing the query's last term into a longer token
 * (`delta-off`), so it covers 3 of the 4 query terms - 0.75, below
 * the bar.
 */
function writePartialTailVault(): void {
  writePref("a", { principle: PARTIAL_QUERY, created_at: "2026-05-05T00:00:00Z" });
  writePref("b", { principle: PARTIAL_QUERY, created_at: "2026-05-04T00:00:00Z", body: "zeta" });
  writePref("c", {
    principle: PARTIAL_QUERY,
    created_at: "2026-05-03T00:00:00Z",
    body: "zeta eta theta",
  });
  writePref("d", {
    principle: PARTIAL_QUERY,
    created_at: "2026-05-02T00:00:00Z",
    body: "zeta eta theta iota kappa lambda mu nu alpha beta gamma delta",
  });
  writePref("e", {
    principle: "alpha beta gamma delta-off",
    created_at: "2026-05-01T00:00:00Z",
    body: "omega",
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
  test("substring mode: a tail item that restates every query term is kept whatever its length", () => {
    writePartialTailVault();
    const r = packContext(vault, { maxTokens: 10_000, query: PARTIAL_QUERY, tailTrim: true });
    // Head (3) immune: pref-a, pref-b, pref-c. The tail keeps pref-d -
    // coverage 1.0, every query term present even though the body is
    // the longest of the set - at the 0.8 bar, and drops pref-e (3 of
    // 4 terms, 0.75) whole. Under the jaccard kernel this trim ran
    // backwards: d's own vocabulary scored it 1/3 while the short,
    // partial e scored 3/5 and survived - the trim kept the short
    // ones, not the restating ones.
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
    // pref-pa covers every query term (1.0); pb/pc/pd cover three of
    // the five (0.6 each). Ranked order: pa, then the three ties by
    // recency. The head keeps pb and pc even though both sit below the
    // 0.8 bar; pd, the equal-scoring tail item, is dropped - position,
    // not score, shields the head.
    writePref("pa", { principle: QUERY, created_at: "2026-05-04T00:00:00Z" });
    writePref("pb", { principle: "alpha beta gamma", created_at: "2026-05-03T00:00:00Z" });
    writePref("pc", { principle: "alpha beta gamma", created_at: "2026-05-02T00:00:00Z" });
    writePref("pd", { principle: "alpha beta gamma", created_at: "2026-05-01T00:00:00Z" });
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

  test("ranked mode: a long body carrying every query term is kept though the comparator ranked it last", () => {
    // The M1 case in the mode with no substring filter: pref-long
    // covers all five query terms inside a long body - coverage 1.0 -
    // but its own vocabulary drags the comparator's jaccard to 5/15,
    // ranking it last of four. The trim's keep rule scores coverage:
    // the long page stays, where the jaccard kernel dropped it.
    writePref("top", { principle: QUERY, created_at: "2026-05-04T00:00:00Z" });
    writePref("mid1", { principle: QUERY, created_at: "2026-05-03T00:00:00Z", body: "zeta" });
    writePref("mid2", { principle: QUERY, created_at: "2026-05-02T00:00:00Z", body: "zeta eta" });
    writePref("long", {
      principle: QUERY,
      created_at: "2026-05-01T00:00:00Z",
      body: "zeta eta theta iota kappa lambda mu nu xi omicron alpha beta gamma delta epsilon",
    });
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: QUERY,
      queryMode: "ranked",
      tailTrim: true,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-top", "pref-mid1", "pref-mid2", "pref-long"]);
    expect(r.skipped).toEqual([]);
    expect(r.tailTrim).toEqual({ dropped: 0, keptByQueryTerms: 1, rescued: 0, tokensSaved: 0 });
  });

  test("ranked mode scores coverage, not the comparator: a tail item exactly at the fraction is kept", () => {
    // Coverage: p1 1.0 (the principle carries the whole query), p2 0.8
    // (four of five terms; the body adds none), p3 0.8, p4 0.8 (its
    // body's `delta` is the fifth term's own token), p5 0. The ranked
    // COMPARATOR still scores jaccard: p1 1.0, p3 0.8, p4 0.8, p2 2/3
    // (its extra body token inflates the union), p5 0 - so the
    // delivery order is p1, p3, p4, p2, p5 and p2 sits in the tail.
    // The trim scores coverage: p2's 0.8 is AT the bar and is kept
    // although its comparator score would have dropped it; p5 drops
    // whole.
    writePref("p1", { principle: QUERY, created_at: "2026-05-05T00:00:00Z" });
    writePref("p2", {
      principle: "alpha beta gamma delta",
      created_at: "2026-05-04T00:00:00Z",
      body: "zeta",
    });
    writePref("p3", { principle: "alpha beta gamma delta", created_at: "2026-05-03T00:00:00Z" });
    writePref("p4", {
      principle: "alpha beta gamma",
      created_at: "2026-05-02T00:00:00Z",
      body: "delta",
    });
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
    expect(r.items.map((i) => i.id)).toEqual(["pref-p1", "pref-p3", "pref-p4", "pref-p2"]);
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

describe("packContext tailTrim counters under the char ceiling and the freed budget", () => {
  test("the char ceiling cutting kept-tail items recounts the trim report", () => {
    // Ranked order (the comparator still scores jaccard): p1 (1.0),
    // p2 (0.8), p3 (5/7), p5 and p6 (2/3 each), p4 (3/7). The walk
    // (maxTokens 8) delivers all six. Coverage: p1 1.0, p2 0.8, p3
    // 1.0, p5 0.8, p6 0.8, p4 0.6 - the trim keeps the head p1-p3
    // immune, keeps p5 and p6 at the bar and drops p4 whole, freeing
    // its 2 tokens with no over-budget candidate to rescue.
    writePref("p1", { principle: QUERY, created_at: "2026-05-06T00:00:00Z" });
    writePref("p2", {
      principle: "alpha beta gamma delta",
      created_at: "2026-05-05T00:00:00Z",
    });
    writePref("p3", { principle: QUERY, created_at: "2026-05-04T00:00:00Z", body: "x1 x2" });
    writePref("p4", {
      principle: "alpha beta gamma",
      created_at: "2026-05-03T00:00:00Z",
      body: "z1 z2",
    });
    writePref("p5", {
      principle: "alpha beta gamma delta",
      created_at: "2026-05-02T00:00:00Z",
      body: "q1",
    });
    writePref("p6", {
      principle: "alpha beta gamma delta",
      created_at: "2026-05-01T00:00:00Z",
      body: "q2",
    });
    // The uncapped pack: p4 dropped whole (freed 2), p5 and p6 kept at
    // the tail - where the char ceiling later cuts from.
    const uncapped = packContext(vault, {
      maxTokens: 8,
      query: QUERY,
      queryMode: "ranked",
      tailTrim: true,
    });
    expect(uncapped.items.map((i) => i.id)).toEqual([
      "pref-p1",
      "pref-p2",
      "pref-p3",
      "pref-p5",
      "pref-p6",
    ]);
    expect(uncapped.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 2,
      rescued: 0,
      tokensSaved: expect.any(Number),
    });
    const headChars = uncapped.items.slice(0, 3).reduce((sum, item) => sum + item.body.length, 0);
    const drop = uncapped.skipped.find((skip) => skip.reason === "tail-trim")!;

    // A char budget that keeps exactly the head: both kept-tail items
    // are cut from the emitted set, and the report must describe what
    // actually shipped - nothing the trim kept by query terms
    // survived.
    const r = packContext(vault, {
      maxTokens: 8,
      query: QUERY,
      queryMode: "ranked",
      tailTrim: true,
      maxTotalChars: headChars,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-p1", "pref-p2", "pref-p3"]);
    expect(r.skipped.map((s) => ({ id: s.id, reason: s.reason }))).toEqual([
      { id: "pref-p4", reason: "tail-trim" },
      { id: "pref-p5", reason: "over-char-budget" },
      { id: "pref-p6", reason: "over-char-budget" },
    ]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 0,
      rescued: 0,
      tokensSaved: drop.tokens,
    });
  });

  test("the rescue spends the freed budget, never the walk's leftover slack", () => {
    // q1..q3 are the immune head; q4's principle fuses the query's
    // last term into a longer token, so it passes the substring filter
    // while covering 3 of the 4 query terms (0.75 < 0.8) and drops
    // whole (the freed budget); q5 and q6 cover every term and clear
    // the rescue bar. The walk cap leaves q5 and q6 over-budget with
    // one token of slack, and the two rescued together would re-spend
    // MORE than the trim freed - the freed budget is the rescue's
    // whole allowance, so only q5 fits and tokensSaved never goes
    // negative.
    const stem = "alpha beta gamma delta";
    writePref("q1", { principle: stem, created_at: "2026-05-06T00:00:00Z", body: "aaa" });
    writePref("q2", { principle: stem, created_at: "2026-05-05T00:00:00Z", body: "aaa" });
    writePref("q3", { principle: stem, created_at: "2026-05-04T00:00:00Z", body: "aaa" });
    writePref("q4", {
      principle: `${stem}-miss`,
      created_at: "2026-05-03T00:00:00Z",
      body: "aaa bbb ccc",
    });
    writePref("q5", { principle: stem, created_at: "2026-05-02T00:00:00Z", body: "aaa bbb" });
    writePref("q6", { principle: stem, created_at: "2026-05-01T00:00:00Z", body: "aaa bbb" });
    const probe = packContext(vault, { maxTokens: 10_000, query: stem, tailTrim: false });
    const tokens = new Map(probe.items.map((item) => [item.id, item.tokens]));
    const freed = tokens.get("pref-q4")!;
    const candidate = tokens.get("pref-q5")!;
    expect(freed).toBe(3);
    expect(candidate).toBe(2);
    // q1..q4 deliver; q5 goes over the cap by exactly its last token.
    const delivered = probe.items.slice(0, 4).reduce((sum, item) => sum + item.tokens, 0);
    const maxTokens = delivered + candidate - 1;

    const r = packContext(vault, { maxTokens, query: stem, tailTrim: true });
    expect(r.items.map((i) => i.id)).toEqual(["pref-q1", "pref-q2", "pref-q3", "pref-q5"]);
    expect(r.skipped.map((s) => ({ id: s.id, reason: s.reason }))).toEqual([
      { id: "pref-q6", reason: "over-budget" },
      { id: "pref-q4", reason: "tail-trim" },
    ]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 0,
      rescued: 1,
      tokensSaved: freed - candidate,
    });
    expect(r.tokensUsed).toBeLessThanOrEqual(maxTokens);
  });
});

describe("packContext tailTrim rescue", () => {
  test("freed budget is offered to over-budget candidates in priority order within maxTokens", () => {
    // Substring mode keeps every page whose principle carries the
    // query and recency decides the walk order. p4's principle fuses
    // the query's last term into a longer token, so it passes the
    // substring filter while covering 3 of the 4 query terms (0.75 <
    // 0.8). Tokens: p1 0, p2 3, p3 3, p4 2, p5 1, p6 1. maxTokens 8:
    // the walk delivers p1-p4 (used 8) and reports p5 and p6
    // over-budget. The trim drops p4 whole, freeing 2 tokens; the
    // rescue then re-admits p5 (1.0 >= 0.8) and p6 (1.0 >= 0.8) in
    // walk order.
    const stem = "alpha beta gamma delta";
    writePref("p1", { principle: stem, created_at: "2026-05-06T00:00:00Z" });
    writePref("p2", { principle: stem, created_at: "2026-05-05T00:00:00Z", body: "x1 x2 x3 x4" });
    writePref("p3", { principle: stem, created_at: "2026-05-04T00:00:00Z", body: "y1 y2 y3 y4" });
    writePref("p4", {
      principle: `${stem}-partial`,
      created_at: "2026-05-03T00:00:00Z",
      body: "z1 z2",
    });
    writePref("p5", { principle: stem, created_at: "2026-05-02T00:00:00Z", body: "z1" });
    writePref("p6", { principle: stem, created_at: "2026-05-01T00:00:00Z", body: "z1" });
    const r = packContext(vault, { maxTokens: 8, query: stem, tailTrim: true });
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
    const stem = "alpha beta gamma delta";
    writePref("p1", { principle: stem, created_at: "2026-05-05T00:00:00Z" });
    writePref("p2", { principle: stem, created_at: "2026-05-04T00:00:00Z", body: "x1 x2 x3 x4" });
    writePref("p3", { principle: stem, created_at: "2026-05-03T00:00:00Z", body: "y1 y2 y3 y4" });
    // p4's fused last term covers 3 of the 4 query terms (0.75 < 0.8):
    // delivered, in the tail, and dropped whole - the freed budget.
    writePref("p4", {
      principle: `${stem}-partial`,
      created_at: "2026-05-02T00:00:00Z",
      body: "z1 z2",
    });
    // p5 is older, over-budget at the walk, and below the bar: the
    // rescue must not re-admit it even though it would fit.
    writePref("p5", {
      principle: `${stem}-partial`,
      created_at: "2026-05-01T00:00:00Z",
      body: "z1 z2",
    });
    const r = packContext(vault, { maxTokens: 8, query: stem, tailTrim: true });
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
    writePartialTailVault();
    listAttentionFlows(vault); // bootstraps the default flow fixtures
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: PARTIAL_QUERY,
      tailTrim: true,
      attentionFlowIds: ["open-loops"],
    });
    // The attention block sits at the head, inside the immune keep
    // count, and stays first after the trim. The tail past the head
    // keeps pref-c and pref-d - both cover every query term, d's long
    // body included - and drops pref-e (0.75) whole.
    expect(r.items[0]!.id).toBe("attention-flows");
    expect(r.items.map((i) => i.id)).toEqual([
      "attention-flows",
      "pref-a",
      "pref-b",
      "pref-c",
      "pref-d",
    ]);
    expect(r.skipped.filter((s) => s.id === "attention-flows")).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(["pref-e"]);
    expect(r.tailTrim).toEqual({
      dropped: 1,
      keptByQueryTerms: 2,
      rescued: 0,
      tokensSaved: expect.any(Number),
    });
  });
});

describe("packContext tailTrim telemetry and receipts", () => {
  test("the trim counters ride the receipt budget and the telemetry metadata, and the gap surfaces", () => {
    writePartialTailVault();
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: PARTIAL_QUERY,
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
