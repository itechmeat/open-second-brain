/**
 * Canonicalization kernel - the one place entity identity is computed.
 *
 * Shared by the registry (duplicate refusal, alias resolution), the
 * doctor lints, search alias expansion, and the fact-extraction router,
 * so every consumer compares like with like. Same normalization shape
 * as `extractEntities` in src/core/search/entities.ts: NFC, lowercase,
 * collapsed whitespace.
 */

/** NFC-normalise, trim, collapse whitespace runs, lowercase. */
export function normalizeEntityName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Validate an entity category: a lowercase kebab-ish slug with no path
 * separators, traversal, or whitespace. Lowercases the input so
 * `People` and `people` are the same category.
 */
export function validateEntityCategory(raw: string): string {
  const category = raw.normalize("NFC").trim().toLowerCase();
  if (!category) throw new Error("entity category must not be empty");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(category)) {
    throw new Error(
      `entity category must be a lowercase slug ([a-z0-9-], starting alphanumeric): ${JSON.stringify(raw)}`,
    );
  }
  return category;
}

/**
 * The identity key one canonical entity owns: `<category>:<normalized name>`.
 * Two files claiming the same key are duplicates by definition.
 */
export function entityIdentityKey(category: string, name: string): string {
  return `${validateEntityCategory(category)}:${normalizeEntityName(name)}`;
}
