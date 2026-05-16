/**
 * FTS5 query construction and keyword retrieval.
 *
 * The user-typed query is treated as a bag of phrase tokens joined by
 * implicit AND. Each token is wrapped in double quotes so FTS5's
 * operator words (`AND`, `OR`, `NOT`, `NEAR`) and metacharacters
 * (`*`, `(`, `)`, `:`, `^`) lose their special meaning. Internal `"`
 * is escaped as `""` per the FTS5 grammar.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §7.
 */

import type { KeywordHit, Store } from "./store.ts";

export function buildFtsMatch(rawQuery: string): string {
  const tokens = rawQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export interface RunFtsOptions {
  readonly limit: number;
  readonly pathPrefix?: string | null;
}

export function runFtsQuery(
  store: Store,
  rawQuery: string,
  opts: RunFtsOptions,
): KeywordHit[] {
  const match = buildFtsMatch(rawQuery);
  if (match === "") return [];
  return store.keywordTopK(match, opts);
}
