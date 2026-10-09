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

import {
  canonicalJson,
  digestVerifies,
  sealWithDigest,
  sha256Hex,
} from "../../../src/core/integrity/digest.ts";

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

describe("sealWithDigest / digestVerifies", () => {
  // The shape every caller of the seal shares: a body of plain JSON
  // values, bound by one digest appended beside it.
  interface ExampleBody {
    readonly name: string;
    readonly entries: ReadonlyArray<{ path: string; bytes: number }>;
    readonly total: number;
  }
  const body: ExampleBody = {
    name: "plan",
    entries: [
      { path: "a.md", bytes: 3 },
      { path: "b.md", bytes: 5 },
    ],
    total: 8,
  };

  test("seal-then-verify round-trips", () => {
    const sealed = sealWithDigest(body);
    expect(sealed.digest).toBe(sha256Hex(canonicalJson(body)));
    expect(digestVerifies(body, sealed.digest)).toBe(true);
  });

  test("the sealed value is the body plus the digest, nothing else moved", () => {
    expect(sealWithDigest(body)).toEqual({ ...body, digest: sha256Hex(canonicalJson(body)) });
  });

  test("the digest is insensitive to key order in the sealed body", () => {
    const reordered = {
      total: body.total,
      entries: body.entries.map((e) => ({ bytes: e.bytes, path: e.path })),
      name: body.name,
    };
    expect(sealWithDigest(body).digest).toBe(sealWithDigest(reordered).digest);
  });

  test("any body mutation fails verification", () => {
    const sealed = sealWithDigest(body);
    const mutations: Array<ExampleBody> = [
      { ...body, name: "plan " },
      { ...body, total: 9 },
      { ...body, entries: [...body.entries, { path: "c.md", bytes: 1 }] },
      {
        ...body,
        entries: [
          { path: "b.md", bytes: 5 },
          { path: "a.md", bytes: 3 },
        ],
      },
      {
        ...body,
        entries: [
          { path: "a.md", bytes: 4 },
          { path: "b.md", bytes: 5 },
        ],
      },
    ];
    const survivors = mutations.filter((candidate) => digestVerifies(candidate, sealed.digest));
    expect(survivors.map((s) => canonicalJson(s)).join("\n")).toBe("");
  });

  test("verification refuses a digest from a different body", () => {
    const other = sealWithDigest({ ...body, total: 9 });
    expect(digestVerifies(body, other.digest)).toBe(false);
  });

  test("the digest is lowercase hex of the declared length", () => {
    const sealed = sealWithDigest(body);
    expect(sealed.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("omits undefined entries from the sealed body exactly as canonicalJson does", () => {
    const withOptional = sealWithDigest({ a: 1, b: undefined });
    expect(withOptional.digest).toBe(sealWithDigest({ a: 1 }).digest);
  });
});
