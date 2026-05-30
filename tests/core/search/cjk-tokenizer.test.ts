import { describe, expect, test } from "bun:test";

import {
  expandTextForCjkFts,
  tokenizeCjkSearchText,
} from "../../../src/core/search/cjk-tokenizer.ts";

describe("tokenizeCjkSearchText", () => {
  test("preserves mixed CJK and Latin token invariants", () => {
    const tokens = tokenizeCjkSearchText("我喜欢apple电脑");

    expect(tokens).toContain("喜欢");
    expect(tokens).toContain("apple");
    expect(tokens).toContain("电脑");
    expect(tokens).toContain("电");
    expect(tokens.indexOf("apple")).toBeLessThan(tokens.indexOf("电脑"));
  });

  test("returns whitespace tokens unchanged when no CJK text is present", () => {
    expect(tokenizeCjkSearchText("quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });
});

describe("expandTextForCjkFts", () => {
  test("keeps original text and adds CJK search tokens", () => {
    const expanded = expandTextForCjkFts("我喜欢苹果派");

    expect(expanded).toContain("我喜欢苹果派");
    expect(expanded).toContain("苹果");
    expect(expanded).toContain("果派");
  });
});
