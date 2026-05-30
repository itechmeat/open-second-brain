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
import { containsCjk, tokenizeCjkSearchText } from "./cjk-tokenizer.ts";

function quoteToken(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

export function buildFtsMatch(rawQuery: string): string {
  const tokens = containsCjk(rawQuery) ? tokenizeCjkSearchText(rawQuery) : rawQuery.split(/\s+/);
  const cleaned = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return "";
  return cleaned.map(quoteToken).join(" ");
}

/**
 * Query-expansion match (v0.20.0): keep the original tokens as an
 * implicit-AND group (the strong signal, still scored highest by bm25
 * because it matches more terms) and OR in each expansion term as an
 * optional broadening alternative:
 *
 *   ("orig1" "orig2") OR "exp1" OR "exp2"
 *
 * With no expansion terms this is byte-identical to {@link buildFtsMatch},
 * so expansion is a true no-op when disabled or empty.
 */
export function buildExpandedFtsMatch(
  rawQuery: string,
  expandedTerms: ReadonlyArray<string>,
): string {
  const base = buildFtsMatch(rawQuery);
  if (base === "" || expandedTerms.length === 0) return base;
  const ors = expandedTerms.map(quoteToken).join(" OR ");
  return `(${base}) OR ${ors}`;
}

export interface RunFtsOptions {
  readonly limit: number;
  readonly pathPrefix?: string | null;
  /**
   * Optional synonym-expansion terms (v0.20.0). When present and
   * non-empty they are OR'd onto the original AND group to broaden
   * recall; absent/empty leaves the query byte-identical.
   */
  readonly expandedTerms?: ReadonlyArray<string>;
}

export function runFtsQuery(store: Store, rawQuery: string, opts: RunFtsOptions): KeywordHit[] {
  const match =
    opts.expandedTerms && opts.expandedTerms.length > 0
      ? buildExpandedFtsMatch(rawQuery, opts.expandedTerms)
      : buildFtsMatch(rawQuery);
  if (match === "") return [];
  return store.keywordTopK(match, opts);
}
