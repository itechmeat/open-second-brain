/**
 * Session-entity mining (recall-quality wave, Lane B / t_13a82a31).
 *
 * The miner is the precision-biased inverse of fact extraction: where
 * `extractFacts` strips code spans before matching, mining treats them as
 * the HIGHEST-precision source, because an identifier someone wrapped in
 * backticks is an identifier on purpose. Every family below is a
 * structural shape - no natural-language word list in any language - and
 * every side key is family-scoped and CASE-PRESERVING (NFC + trim only),
 * because symbols and paths are case-sensitive and the entity kernel's
 * lowercase fold is promotion's business, not the ledger's.
 */

import { describe, expect, test } from "bun:test";

import { FAKE_VENDOR_KEY, fakeCredential } from "../../../helpers/fake-credentials.ts";
import { extractFacts } from "../../../../src/core/brain/fact-extract.ts";
import {
  MINED_KEY_MAX_LENGTH,
  SESSION_MINING_FAMILIES,
  isSecretShapedMention,
  mineTurnEntities,
  miningDedupeId,
  miningKey,
} from "../../../../src/core/brain/link-graph/session-mining.ts";

/** Flat list of (family, key) pairs, for order-insensitive assertions. */
function mined(text: string): ReadonlyArray<readonly [string, string]> {
  return mineTurnEntities(text).map((m) => [m.family, m.key] as const);
}

describe("session-mining families", () => {
  test("the family set is exactly the four precision families", () => {
    expect([...SESSION_MINING_FAMILIES].toSorted()).toEqual([
      "path",
      "qualified-ident",
      "symbol",
      "url",
    ]);
  });

  test("symbol: inline code spans yield their identifier-shaped content", () => {
    const out = mined("call `SessionStore` and `foo_bar` from `FTS5`.");
    expect(out).toContainEqual(["symbol", "SessionStore"]);
    expect(out).toContainEqual(["symbol", "foo_bar"]);
    expect(out).toContainEqual(["symbol", "FTS5"]);
  });

  test("symbol: fenced code blocks are harvested token by token", () => {
    const text = ["```ts", "const store = new MyClass();", "load_tree(path);", "```"].join("\n");
    const out = mined(text);
    expect(out).toContainEqual(["symbol", "MyClass"]);
    expect(out).toContainEqual(["symbol", "load_tree"]);
  });

  test("symbol: prose without code spans is never mined as a symbol", () => {
    expect(mined("the SessionStore class and foo_bar live in prose")).toEqual([]);
  });

  test("symbol: a non-identifier code span (prose in backticks) is refused", () => {
    expect(mined("the rule is `keep it simple` today")).toEqual([]);
  });

  test("qualified-ident: dotted and double-colon shapes of two or more segments", () => {
    const out = mined("wire osb.core.SessionStore through my_pkg::loader next");
    expect(out).toContainEqual(["qualified-ident", "osb.core.SessionStore"]);
    expect(out).toContainEqual(["qualified-ident", "my_pkg::loader"]);
  });

  test("qualified-ident: a shape needs a structural cue, plain prose pairs stay out", () => {
    // `alpha.beta` carries no digit, underscore or internal uppercase, so
    // it is indistinguishable from a name - refused. A third segment, a
    // digit, an underscore or a camel hump is the cue.
    expect(mined("read alpha.beta today")).toEqual([]);
    expect(mined("read alpha.beta.gamma today")).toContainEqual([
      "qualified-ident",
      "alpha.beta.gamma",
    ]);
    expect(mined("see Module2.method here")).toContainEqual(["qualified-ident", "Module2.method"]);
  });

  test("qualified-ident: one-letter segments stay out (no e.g / i.e captures)", () => {
    expect(mined("arrive e.g. today, i.e. tomorrow")).toEqual([]);
  });

  test("url: the fact-extract URL family is reproduced exactly on prose", () => {
    const text = "pin https://osb.example/run?dry=1 and http://intra.internal:8080/status";
    const factUrls = extractFacts(text)
      .filter((f) => f.family === "url")
      .map((f) => f.text)
      .toSorted();
    const minedUrls = mined(text)
      .filter(([family]) => family === "url")
      .map(([, key]) => key)
      .toSorted();
    expect(minedUrls).toEqual(factUrls);
    expect(minedUrls.length).toBe(2);
  });

  test("path: both slash directions with an extension", () => {
    const out = mined("edit src/core/store.ts then .\\notes\\idea.md and /usr/local/bin/run.sh");
    expect(out).toContainEqual(["path", "src/core/store.ts"]);
    expect(out).toContainEqual(["path", ".\\notes\\idea.md"]);
    expect(out).toContainEqual(["path", "/usr/local/bin/run.sh"]);
  });

  test("path: a separator without an extension is not a path", () => {
    expect(mined("look in src/core for it")).toEqual([]);
  });

  test("families do not re-read inside each other: a URL is one mention, not three", () => {
    const out = mined("clone https://osb.example/repo.git now");
    expect(out).toEqual([["url", "https://osb.example/repo.git"]]);
  });

  test("code spans own their content: a path in a code span is a symbol, not a path", () => {
    const out = mined("run `src/core/store.ts` first");
    expect(out).toEqual([["symbol", "src/core/store.ts"]]);
  });

  test("mentions are deduped within a turn and deterministic", () => {
    const text = "use `SessionStore` twice `SessionStore` and once more";
    const first = mineTurnEntities(text);
    const second = mineTurnEntities(text);
    expect([...first]).toEqual([...second]);
    expect(first.filter((m) => m.key === "SessionStore").length).toBe(1);
  });

  test("oversized lines are capped, never scanned in full", () => {
    const blob = `x`.repeat(20000);
    const out = mined(`see ${blob}/evil.ts here`);
    expect(out).toEqual([]);
  });
});

describe("mining keys", () => {
  test("case is preserved: two casings of one symbol are two keys", () => {
    expect(miningKey("SessionStore")).toBe("SessionStore");
    expect(miningKey("sessionstore")).toBe("sessionstore");
    expect(miningKey("SessionStore")).not.toBe(miningKey("sessionstore"));
  });

  test("keys normalize to NFC and trim, nothing else", () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(miningKey(decomposed)).toBe(miningKey(composed));
    expect(miningKey("  MyClass  ")).toBe("MyClass");
  });

  test("keys are length-capped, not unbounded", () => {
    expect(miningKey("A".repeat(5000)).length).toBeLessThanOrEqual(MINED_KEY_MAX_LENGTH);
  });
});

describe("secret-shaped refusal", () => {
  test("a vendor-prefixed key inside a code span is refused", () => {
    const text = `the key is \`${FAKE_VENDOR_KEY}\` in the config`;
    expect(isSecretShapedMention("symbol", FAKE_VENDOR_KEY)).toBe(true);
    expect(mined(text)).toEqual([]);
  });

  test("a credential URL (user:pass@host) is refused", () => {
    const pass = fakeCredential("hu", "nter2");
    const url = `https://deploy:${pass}@osb.example/repo.git`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`clone ${url} now`)).toEqual([]);
  });

  test("a token query form is refused", () => {
    const tok = fakeCredential("tok", "en-9f8e7d6c5b");
    const url = `https://osb.example/pull?token=${tok}`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`fetch ${url} today`)).toEqual([]);
  });

  test("a plain public URL is not refused", () => {
    expect(isSecretShapedMention("url", "https://osb.example/run?dry=1")).toBe(false);
  });

  test("ordinary identifiers are not refused", () => {
    expect(isSecretShapedMention("symbol", "SessionStore")).toBe(false);
    expect(isSecretShapedMention("symbol", "foo_bar")).toBe(false);
    expect(isSecretShapedMention("path", "src/core/store.ts")).toBe(false);
  });
});

describe("dedupe granularity", () => {
  test("the dedupe id is (family, key, sessionRef) - same key, other session, other id", () => {
    const a = miningDedupeId("symbol", "SessionStore", "s1.jsonl");
    expect(miningDedupeId("symbol", "SessionStore", "s1.jsonl")).toBe(a);
    expect(miningDedupeId("symbol", "SessionStore", "s2.jsonl")).not.toBe(a);
    expect(miningDedupeId("path", "SessionStore", "s1.jsonl")).not.toBe(a);
  });
});
