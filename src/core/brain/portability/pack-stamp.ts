/**
 * The provenance stamp a knowledge-pack install writes onto every entry it
 * lands (Brain Portability & Interop suite, knowledge packs).
 *
 * One frontmatter key, one value shape: `knowledge_pack: <name>@<digest12>`
 * where `<digest12>` is the first twelve hex characters of the pack's
 * integrity digest. The name is what `knowledge-pack uninstall <name>`
 * keys on; the digest says WHICH build of that pack an entry came from.
 *
 * The stamp is server-side provenance, never caller-supplied: the OKF
 * import strips it with the rest of the machinery keys unless the operator
 * vouched for an own-producer bundle, and the pack installer writes it
 * after that strip. A bundle that forges `knowledge_pack: victim@...` on a
 * page therefore cannot enrol that page in someone else's uninstall.
 *
 * Standalone (no imports) so the search layer can read the stamp without
 * pulling the portability graph into its import closure.
 */

/** Frontmatter key carrying the stamp on installed preferences and pages. */
export const KNOWLEDGE_PACK_FIELD = "knowledge_pack";

/**
 * Frontmatter key carrying a staged page's content fingerprint as the
 * installer wrote it, so uninstall can tell an untouched page from one the
 * operator edited in the review lane. Machinery like the stamp: stripped
 * from any bundle that supplies it, written by the installer only.
 */
export const KNOWLEDGE_PACK_SHA_FIELD = "knowledge_pack_sha";

/**
 * Pack names are lower-case identifiers: they appear in frontmatter, in a
 * CLI argument, and in a snapshot/audit reason, so the alphabet is the
 * intersection of what all three carry verbatim.
 */
export const KNOWLEDGE_PACK_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Hex characters of the integrity digest carried in the stamp. */
export const KNOWLEDGE_PACK_STAMP_DIGEST_CHARS = 12;

const STAMP_RE = /^([a-z0-9][a-z0-9._-]{0,63})@([0-9a-f]{12})$/;

export interface KnowledgePackStamp {
  readonly name: string;
  /** First {@link KNOWLEDGE_PACK_STAMP_DIGEST_CHARS} hex chars of the digest. */
  readonly digest: string;
}

export function isKnowledgePackName(value: string): boolean {
  return KNOWLEDGE_PACK_NAME_RE.test(value);
}

/** Render the stamp for a pack name and its full integrity digest. */
export function formatKnowledgePackStamp(name: string, digest: string): string {
  return `${name}@${digest.slice(0, KNOWLEDGE_PACK_STAMP_DIGEST_CHARS)}`;
}

/** Parse a frontmatter value into a stamp, or `null` when it is not one. */
export function parseKnowledgePackStamp(value: unknown): KnowledgePackStamp | null {
  if (typeof value !== "string") return null;
  const m = STAMP_RE.exec(value.trim());
  return m ? { name: m[1]!, digest: m[2]! } : null;
}
