/**
 * SQL text helpers shared by the per-table modules behind `Store`. One
 * spelling of a placeholder list and one of the instant every table
 * stamps, so the tables cannot drift into two.
 */

/** `?,?,...` placeholder list for a SQL `IN (...)` clause of `items.length` params. */
export function sqlPlaceholders(items: ReadonlyArray<unknown>): string {
  return items.map(() => "?").join(",");
}

/** The instant recorded in every `created_at` / `updated_at` / `indexed_at` column. */
export function nowIso(): string {
  return new Date().toISOString();
}
