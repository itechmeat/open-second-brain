import { test, expect } from "bun:test";
import {
  tokenizeForExpansion,
  deriveExpansionTerms,
  DEFAULT_EXPANSION,
} from "../../../src/core/search/synonyms.ts";

test("tokenizeForExpansion splits on non-letter/digit and lowercases", () => {
  expect(tokenizeForExpansion("Deploy the Gateway-v2, now!")).toEqual([
    "deploy",
    "the",
    "gateway",
    "v2",
    "now",
  ]);
});

test("tokenizeForExpansion treats a CJK run as one structural token (no segmentation)", () => {
  // No language-specific segmenter: a continuous letter run is one token.
  expect(tokenizeForExpansion("配置部署 staging")).toEqual(["配置部署", "staging"]);
});

test("no candidate texts yields no expansion (no-op)", () => {
  expect(deriveExpansionTerms(["backup"], [], DEFAULT_EXPANSION)).toEqual([]);
});

test("query tokens are never returned as expansion terms", () => {
  const out = deriveExpansionTerms(
    ["backup"],
    ["backup schedule schedule", "backup schedule cron"],
    { maxTerms: 5, minLength: 3, minDocFreq: 2 },
  );
  expect(out).not.toContain("backup");
});

test("docFreq counts distinct candidate docs, not raw term frequency", () => {
  // "schedule" appears many times but in a single doc -> docFreq 1.
  const out = deriveExpansionTerms(["backup"], ["backup schedule schedule schedule"], {
    maxTerms: 5,
    minLength: 3,
    minDocFreq: 2,
  });
  expect(out).toEqual([]);
});

test("terms below the doc-frequency threshold are dropped", () => {
  const out = deriveExpansionTerms(
    ["backup"],
    ["backup nightly", "backup nightly", "backup weekly"],
    { maxTerms: 5, minLength: 3, minDocFreq: 2 },
  );
  expect(out).toContain("nightly"); // 2 docs
  expect(out).not.toContain("weekly"); // 1 doc
});

test("short tokens below minLength are excluded", () => {
  const out = deriveExpansionTerms(["backup"], ["backup to s3", "backup to s3"], {
    maxTerms: 5,
    minLength: 3,
    minDocFreq: 2,
  });
  expect(out).not.toContain("to");
  expect(out).not.toContain("s3");
});

test("returns at most maxTerms, ranked by docFreq then alphabetically", () => {
  const docs = [
    "backup alpha bravo charlie",
    "backup alpha bravo",
    "backup alpha",
    "backup bravo charlie",
  ];
  // docFreq: alpha=3, bravo=3, charlie=2. maxTerms=2 -> top two by freq,
  // alpha before bravo on the alphabetical tie-break.
  const out = deriveExpansionTerms(["backup"], docs, {
    maxTerms: 2,
    minLength: 3,
    minDocFreq: 2,
  });
  expect(out).toEqual(["alpha", "bravo"]);
});

test("is deterministic for identical inputs", () => {
  const docs = ["backup alpha bravo", "backup alpha bravo"];
  expect(deriveExpansionTerms(["backup"], docs, DEFAULT_EXPANSION)).toEqual(
    deriveExpansionTerms(["backup"], docs, DEFAULT_EXPANSION),
  );
});
