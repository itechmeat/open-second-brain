import { describe, expect, test } from "bun:test";

import {
  findNearDuplicates,
  NEAR_DUPLICATE_CANDIDATE_CAP,
  NEAR_DUPLICATE_MIN_TOKENS,
  NEAR_DUPLICATE_THRESHOLDS,
  READ_ALL_REFS,
  type NearDuplicatePoolEntry,
} from "../../../src/core/brain/near-duplicate.ts";
import { NEAR_DUPLICATE_JACCARD } from "../../../src/core/brain/page-lint.ts";
import { tokenise } from "../../../src/core/brain/similarity.ts";

const BASE = "always run the formatter before every commit in this repository";

function entry(ref: string, text: string, bucket?: string): NearDuplicatePoolEntry {
  return bucket === undefined
    ? { ref, tokens: tokenise(text) }
    : { ref, tokens: tokenise(text), bucket };
}

const probe = { ref: "pref-probe", tokens: tokenise(BASE) };
const opts = { threshold: 0.5, readable: READ_ALL_REFS };
const notHidden = (ref: string) => !ref.startsWith("pref-hidden");

describe("findNearDuplicates", () => {
  test("an unreadable entry never appears in matches or in any scan counter", () => {
    const pool = [
      entry("pref-hidden-match", BASE),
      entry("pref-hidden-short", "tiny"),
      entry("pref-visible", BASE),
    ];
    const all = findNearDuplicates(probe, pool, { ...opts, readable: notHidden, cap: 1 });
    expect(all.matches.map((m) => m.ref)).toEqual(["pref-visible"]);
    expect(all.scan).toEqual({ compared: 1, capped: 0, below_min_tokens: 0 });
  });

  test("an entry under minTokens counts in below_min_tokens and is not scored", () => {
    const pool = [entry("pref-short", "run formatter"), entry("pref-long", BASE)];
    const result = findNearDuplicates(probe, pool, opts);
    expect(result.matches.map((m) => m.ref)).toEqual(["pref-long"]);
    expect(result.scan).toEqual({ compared: 1, capped: 0, below_min_tokens: 1 });
  });

  test("a probe under minTokens scores nothing", () => {
    const short = { ref: "pref-short-probe", tokens: tokenise("run formatter") };
    const result = findNearDuplicates(short, [entry("pref-long", BASE)], opts);
    expect(result.matches).toEqual([]);
    expect(result.scan.compared).toBe(0);
  });

  test("an explicit minTokens overrides the default", () => {
    const pool = [entry("pref-short", "run formatter")];
    const short = { ref: "pref-p", tokens: tokenise("run formatter") };
    const result = findNearDuplicates(short, pool, { ...opts, minTokens: 2 });
    expect(result.matches).toEqual([{ ref: "pref-short", score: 1, method: "lexical" }]);
  });

  test("the cap counts as capped", () => {
    const pool = ["AA-1", "AA-2", "AA-3", "AA-4"].map((ref) => entry(ref, BASE));
    const result = findNearDuplicates(probe, pool, { ...opts, cap: 3 });
    expect(result.matches.map((m) => m.ref)).toEqual(["AA-1", "AA-2", "AA-3"]);
    expect(result.scan).toEqual({ compared: 3, capped: 1, below_min_tokens: 0 });
  });

  test("the probe's own ref is excluded", () => {
    const result = findNearDuplicates(probe, [entry("pref-probe", BASE)], opts);
    expect(result.matches).toEqual([]);
    expect(result.scan).toEqual({ compared: 0, capped: 0, below_min_tokens: 0 });
  });

  test("a bucket option keeps only entries of the same bucket", () => {
    const pool = [entry("pref-a", BASE, "x"), entry("pref-b", BASE, "y"), entry("pref-c", BASE)];
    const result = findNearDuplicates(probe, pool, { ...opts, bucket: "x" });
    expect(result.matches.map((m) => m.ref)).toEqual(["pref-a"]);
    expect(result.scan.compared).toBe(1);
  });

  test("matches below the threshold are compared but not returned", () => {
    const pool = [entry("pref-far", "prefer tabs over spaces in makefiles always")];
    const result = findNearDuplicates(probe, pool, opts);
    expect(result.matches).toEqual([]);
    expect(result.scan.compared).toBe(1);
  });

  test("sorting is deterministic: score descending, then ref", () => {
    const near = `${BASE} today`;
    const pool = [entry("pref-c", near), entry("pref-b", BASE), entry("pref-a", BASE)];
    const forward = findNearDuplicates(probe, pool, opts);
    const reversed = findNearDuplicates(probe, pool.toReversed(), opts);
    expect(forward.matches.map((m) => m.ref)).toEqual(["pref-a", "pref-b", "pref-c"]);
    expect(reversed).toEqual(forward);
    expect(forward.matches[2]!.score).toBe(0.909);
    expect(forward.matches.every((m) => m.method === "lexical")).toBe(true);
  });

  test("multilingual tokens score through the shared tokenise", () => {
    const ru = "всегда запускай форматтер перед каждым коммитом";
    const zh = "提交 之前 总是 运行 格式化 工具";
    const ruProbe = { ref: "pref-ru", tokens: tokenise(ru) };
    const zhProbe = { ref: "pref-zh", tokens: tokenise(zh) };
    const pool = [entry("pref-ru-2", `${ru} проекта`), entry("pref-zh-2", `${zh} 仓库`)];
    expect(findNearDuplicates(ruProbe, pool, opts).matches.map((m) => m.ref)).toEqual([
      "pref-ru-2",
    ]);
    expect(findNearDuplicates(zhProbe, pool, opts).matches.map((m) => m.ref)).toEqual([
      "pref-zh-2",
    ]);
  });

  test("the threshold table and the shared constants hold their pinned values", () => {
    expect(NEAR_DUPLICATE_THRESHOLDS.writeHint).toBe(NEAR_DUPLICATE_JACCARD);
    expect(NEAR_DUPLICATE_THRESHOLDS.retireSiblingLexical).toBe(0.7);
    expect(NEAR_DUPLICATE_THRESHOLDS.retireSiblingEmbedding).toBe(0.92);
    expect(NEAR_DUPLICATE_MIN_TOKENS).toBe(4);
    expect(NEAR_DUPLICATE_CANDIDATE_CAP).toBe(200);
    expect(READ_ALL_REFS("anything")).toBe(true);
  });
});
