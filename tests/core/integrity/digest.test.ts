/**
 * The one digest encoding.
 *
 * Ten modules carried a byte-identical private SHA-256 helper and two
 * reimplemented canonical JSON serialization independently. Two units of
 * the silence-is-not-an-answer wave persist a digest into a vault that is
 * replicated peer-to-peer, and persisted formats in this project are
 * additive-only - so two encodings shipped in one release could never be
 * reconciled afterwards.
 *
 * These tests pin the encoding rather than describe it: the expected hex
 * values are the ones the absorbed helpers already produced, so a change
 * to this module that would have silently re-keyed existing records fails
 * here instead.
 */

import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256Hex } from "../../../src/core/integrity/digest.ts";

/** Independently recomputed, so the test does not restate the implementation. */
function referenceSha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("sha256Hex", () => {
  test("pins the empty-string digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("agrees with the absorbed helpers, which passed an explicit utf8 encoding", () => {
    // Seven of the ten call sites wrote `.update(text, "utf8")` and three
    // wrote `.update(text)`. For a string argument those are the same call;
    // this asserts it rather than assuming it, because the two spellings are
    // now one function and a divergence would re-key persisted records.
    for (const sample of ["", "a", "schema_version: 1\n", "  leading and trailing  "]) {
      expect(sha256Hex(sample)).toBe(createHash("sha256").update(sample, "utf8").digest("hex"));
      expect(sha256Hex(sample)).toBe(createHash("sha256").update(sample).digest("hex"));
    }
  });

  test("hashes a string and its utf8 bytes identically", () => {
    const text = "one pack, two states";
    expect(sha256Hex(text)).toBe(sha256Hex(new TextEncoder().encode(text)));
  });

  test("is stable over non-Latin text and treats it as opaque bytes", () => {
    // No natural-language handling anywhere in the digest path: the only
    // property asserted is that the same bytes give the same digest and
    // different bytes do not.
    const samples = ["правило оператора", "運用者の規則", "قاعدة المشغل", "règle de l'opérateur"];
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(referenceSha256(sample));
      expect(sha256Hex(sample)).toHaveLength(64);
    }
    expect(new Set(samples.map((s) => sha256Hex(s))).size).toBe(samples.length);
  });

  test("distinguishes inputs that differ only in trailing whitespace", () => {
    expect(sha256Hex("body")).not.toBe(sha256Hex("body\n"));
  });

  test("accepts bytes that are not valid utf8", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(sha256Hex(bytes)).toBe(referenceSha256(bytes));
  });
});

describe("canonicalJson", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("is insensitive to key order and sensitive to content", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(canonicalJson({ x: 1, y: 2 })).not.toBe(canonicalJson({ x: 1, y: 3 }));
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("omits object entries whose value is undefined", () => {
    // This is the semantic the persisted-ledger copy already had, and it is
    // the one that matches how JSON.stringify treats an object entry.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("renders undefined inside an array as null, as JSON does", () => {
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  test("renders a bare undefined as null rather than returning undefined", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
  });

  test("escapes keys and values through JSON.stringify", () => {
    expect(canonicalJson({ 'a"b': "c\nd" })).toBe('{"a\\"b":"c\\nd"}');
  });

  test("agrees with the two absorbed copies on inputs both could reach", () => {
    // The bench-fixture copy rendered an undefined entry as null and the
    // ledger copy omitted it. Every parser feeding the bench copy builds its
    // objects with a conditional spread, so no undefined entry was reachable
    // and the two copies agreed on everything they were ever given.
    const reachable = {
      name: "fixture",
      questions: [{ id: "q1", category: "recall" }],
      notes: [{ path: "a.md", body: "x" }],
    };
    expect(canonicalJson(reachable)).toBe(
      '{"name":"fixture","notes":[{"body":"x","path":"a.md"}],"questions":[{"category":"recall","id":"q1"}]}',
    );
  });

  test("is a stable hash input across key order", () => {
    expect(sha256Hex(canonicalJson({ b: 1, a: 2 }))).toBe(sha256Hex(canonicalJson({ a: 2, b: 1 })));
  });
});
