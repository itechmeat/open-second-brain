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

import { SearchError } from "./types.ts";

export type PropertyFilterMap = ReadonlyMap<string, ReadonlyArray<string>>;
export type PropertyFrontmatterReader = (path: string) => Record<string, unknown> | null;

// ─────────────────────────────────────────────────────────────────────────────
// Graph-degree cardinality predicates (t_9bee8f0b)
// ─────────────────────────────────────────────────────────────────────────────

/** Degree field a predicate ranges over. */
export type DegreeField = "backlinks" | "outlinks";

/** Comparison operator for a degree predicate. */
export type DegreeOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

/** A parsed `<field><op><count>` graph-degree predicate. */
export interface DegreePredicate {
  readonly field: DegreeField;
  readonly op: DegreeOp;
  /** Non-negative integer count the field is compared against. */
  readonly value: number;
}

/** A note's directed degree: distinct back-links and out-links. */
export interface DegreeLookupResult {
  readonly backlinks: number;
  readonly outlinks: number;
}

/** Resolves a result path to its directed degree counts. */
export type DegreeLookup = (path: string) => DegreeLookupResult;

const DEGREE_FIELDS: ReadonlyArray<DegreeField> = Object.freeze(["backlinks", "outlinks"]);
const DEGREE_OPS: ReadonlyArray<DegreeOp> = Object.freeze(["=", "!=", ">", ">=", "<", "<="]);
// Longer operators first so `>=` is not mis-split as `>` + `=`.
const DEGREE_PREDICATE_RE = /^(backlinks|outlinks)\s*(!=|>=|<=|=|>|<)\s*(\d+)$/;

/**
 * Parse one `<field><op><count>` graph-degree predicate, e.g.
 * `backlinks=0` (orphans) or `outlinks>=5` (hubs). The count must be a
 * non-negative integer. Invalid syntax rejects with a typed
 * `SearchError("INVALID_INPUT")` naming the allowed fields and operators
 * rather than silently ignoring the predicate.
 */
export function parseDegreePredicate(raw: string): DegreePredicate {
  const trimmed = raw.trim();
  const m = DEGREE_PREDICATE_RE.exec(trimmed);
  if (m === null) {
    throw new SearchError(
      "INVALID_INPUT",
      `invalid degree predicate '${raw}'; expected <field><op><count> where ` +
        `field is one of ${DEGREE_FIELDS.join(", ")}, op is one of ${DEGREE_OPS.join(", ")}, ` +
        "and count is a non-negative integer (e.g. backlinks=0, outlinks>=5)",
    );
  }
  return Object.freeze({
    field: m[1] as DegreeField,
    op: m[2] as DegreeOp,
    value: Number(m[3]),
  });
}

function compareDegree(actual: number, op: DegreeOp, value: number): boolean {
  switch (op) {
    case "=":
      return actual === value;
    case "!=":
      return actual !== value;
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
  }
}

/**
 * Drop rows whose backlink/outlink counts do not satisfy every predicate
 * (AND across predicates). The degree lookup is dependency-injected so
 * this helper stays pure; the search orchestrator wires the live graph
 * snapshot. An empty predicate list is a byte-identical pass-through.
 */
export function applyDegreeFilters<T extends { readonly path: string }>(
  results: ReadonlyArray<T>,
  predicates: ReadonlyArray<DegreePredicate>,
  degreeOf: DegreeLookup,
): ReadonlyArray<T> {
  if (predicates.length === 0) return Object.freeze([...results]) as ReadonlyArray<T>;
  const out: T[] = [];
  for (const row of results) {
    const degree = degreeOf(row.path);
    const ok = predicates.every((p) => {
      const actual = p.field === "backlinks" ? degree.backlinks : degree.outlinks;
      return compareDegree(actual, p.op, p.value);
    });
    if (ok) out.push(row);
  }
  return Object.freeze(out) as ReadonlyArray<T>;
}

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

function matchesAll(fm: Record<string, unknown>, filters: PropertyFilterMap): boolean {
  for (const [key, accepted] of filters) {
    if (!Object.prototype.hasOwnProperty.call(fm, key)) return false;
    const value = fm[key];
    if (value === undefined || value === null) return false;
    if (!matchesAny(value, accepted)) return false;
  }
  return true;
}

function matchesAny(value: unknown, accepted: ReadonlyArray<string>): boolean {
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
