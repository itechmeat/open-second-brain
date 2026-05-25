/**
 * Property-based post-FTS filter.
 *
 * Drops rows whose source frontmatter does not match a requested
 * `key → values[]` filter map.
 *
 * Semantics:
 *   - Within one key: OR across requested values.
 *   - Across keys: AND.
 *   - Missing key in a row's frontmatter excludes the row.
 *   - Frontmatter array values are matched element-wise: if any
 *     element of the frontmatter array matches any requested value
 *     for that key, the row passes.
 *
 * The reader is dependency-injected so this helper has no I/O of
 * its own; the search orchestrator wires the live `parseFrontmatter`
 * reader, tests can pass an in-memory map.
 */

export type PropertyFilterMap = ReadonlyMap<string, ReadonlyArray<string>>;
export type PropertyFrontmatterReader = (
  path: string,
) => Record<string, unknown> | null;

export function filterByProperties<T extends { readonly path: string }>(
  results: ReadonlyArray<T>,
  filters: PropertyFilterMap,
  read: PropertyFrontmatterReader,
): ReadonlyArray<T> {
  if (filters.size === 0) return Object.freeze([...results]) as ReadonlyArray<T>;

  const out: T[] = [];
  for (const row of results) {
    const fm = read(row.path);
    if (fm === null) continue;
    if (matchesAll(fm, filters)) out.push(row);
  }
  return Object.freeze(out) as ReadonlyArray<T>;
}

function matchesAll(
  fm: Record<string, unknown>,
  filters: PropertyFilterMap,
): boolean {
  for (const [key, accepted] of filters) {
    if (!Object.prototype.hasOwnProperty.call(fm, key)) return false;
    const value = fm[key];
    if (value === undefined || value === null) return false;
    if (!matchesAny(value, accepted)) return false;
  }
  return true;
}

function matchesAny(
  value: unknown,
  accepted: ReadonlyArray<string>,
): boolean {
  const acceptedSet = new Set(accepted);
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== "string") continue;
      if (acceptedSet.has(v)) return true;
    }
    return false;
  }
  if (typeof value === "string") return acceptedSet.has(value);
  // Numeric / boolean frontmatter scalars: compare against the string
  // form so a filter `priority=3` works even when the parser kept the
  // value as a number.
  if (typeof value === "number" || typeof value === "boolean") {
    return acceptedSet.has(String(value));
  }
  return false;
}
