import { describe, expect, test } from "bun:test";

import {
  expandTextForCjkFts,
  tokenizeCjkSearchText,
} from "../../../src/core/search/cjk-tokenizer.ts";

describe("tokenizeCjkSearchText", () => {
  test("preserves mixed CJK and Latin token order", () => {
    expect(tokenizeCjkSearchText("我喜欢apple电脑")).toEqual([
      "我喜",
      "喜欢",
      "apple",
      "电脑",
      "我",
      "喜",
      "欢",
      "电",
      "脑",
    ]);
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
