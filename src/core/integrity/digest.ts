/**
 * The one digest encoding.
 *
 * Ten modules across the brain, search and bench trees each carried a
 * private SHA-256 helper with the same body, and three reimplemented
 * canonical JSON serialization independently. That was survivable while
 * every digest stayed inside the process that computed it.
 *
 * It stops being survivable the moment a digest is persisted. The vault
 * is replicated peer-to-peer and persisted formats in this project are
 * additive-only: a record written under one encoding is read back by a
 * peer that may be running an older build, so two encodings shipped in
 * one release could never be reconciled afterwards. Two units of the
 * silence-is-not-an-answer wave persist a digest - a schema-pack seal and
 * a recall coverage receipt - which is why this module exists now rather
 * than as a tidying pass later.
 *
 * The module is deliberately narrow. It hashes bytes and it serializes a
 * value deterministically. It knows nothing about schema packs, coverage
 * receipts, or any other caller, it never truncates - a caller that wants
 * a short form slices its own result and owns that decision - and it
 * never inspects natural language: text is opaque bytes on the way in and
 * hex on the way out.
 */

import { createHash } from "node:crypto";

/**
 * The digest algorithm every persisted hash in this project is written
 * with. Named so that a future migration is one edit and one grep rather
 * than a sweep over call sites.
 */
export const DIGEST_ALGORITHM = "sha256";

/**
 * Lowercase hex SHA-256 of a string or a byte sequence.
 *
 * A string is hashed as UTF-8. The absorbed helpers were split between
 * `.update(text, "utf8")` and `.update(text)`, which are the same call
 * for a string argument; `tests/core/integrity/digest.test.ts` pins that
 * equivalence so the consolidation cannot silently re-key anything.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash(DIGEST_ALGORITHM).update(input).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively, array order kept,
 * object entries whose value is `undefined` omitted.
 *
 * The omission matches what `JSON.stringify` does to an object entry, and
 * it is what the persisted-ledger copy already did. Inside an array
 * `undefined` renders as `null`, again matching `JSON.stringify`, because
 * dropping it would change the array's length and therefore its meaning.
 *
 * The third absorbed copy - the external-fetch cache key - rendered such
 * an entry as `"key":null` instead. Nothing persisted it, and the request
 * it keys goes out through `JSON.stringify`, which drops the entry: the
 * copy was distinguishing two requests that are identical on the wire.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
