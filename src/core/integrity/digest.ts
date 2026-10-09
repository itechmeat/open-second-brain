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
 *
 * ## The persisted-digest doctrine, and the seal built on it
 *
 * {@link sealWithDigest} and {@link digestVerifies} are the one way a
 * structured record is bound to a digest over itself: the seal is
 * `sha256Hex(canonicalJson(body))` of exactly the body given, appended to
 * the copy that carries the `digest` field, and verification recomputes
 * the same value over the body WITHOUT the field. The state-migration
 * manifest sealed this way first; content adoption plans - a dry run the
 * operator approves in one process and a later apply re-checks in
 * another - follow, and every future sealed record joins them rather
 * than growing a private spelling.
 *
 * What belongs in a sealed body follows from who re-checks it. A record
 * whose seal must be reproducible across time - an approval compared
 * against a re-computation - keeps wall-clock fields out of the body and
 * injects its clock at the write instead, so the same content seals to
 * the same digest whenever it is planned. A point-in-time record such as
 * the migration manifest MAY bind its timestamp, because the seal there
 * answers "are these still the bytes that were measured", and when they
 * were measured is part of that answer.
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

/**
 * Bind a JSON body to its digest: the body with a `digest` field
 * appended, whose value is the hash of the body WITHOUT that field.
 *
 * This is the persisted-digest doctrine made callable - the same shape
 * the state-migration manifest has always written. The field is named
 * `digest` on every sealed record, so a reader can strip it by name and
 * re-verify with {@link digestVerifies} without knowing the record
 * otherwise.
 */
export function sealWithDigest<B extends object>(body: B): B & { readonly digest: string } {
  return { ...body, digest: sha256Hex(canonicalJson(body)) };
}

/**
 * Whether `digest` is still the seal of `body`.
 *
 * `body` is the record WITHOUT its `digest` field - the same body
 * {@link sealWithDigest} hashed. A `false` here is never repaired or
 * resynced by a caller: a body that does not verify is a body nobody
 * measured, and the refusal is the feature.
 */
export function digestVerifies(body: unknown, digest: string): boolean {
  return sha256Hex(canonicalJson(body)) === digest;
}
