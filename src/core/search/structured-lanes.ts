/**
 * Structured-recall query document (t_2fa95db1) application helpers: fold
 * an explicit structured query into the keyword / semantic lane inputs,
 * apply its lexical exclusions, and attribute the lanes it activated on
 * each surfaced result. Parsing lives in `structured-query.ts`.
 */

import type { BrainSearchResult, StructuredRecallQueryDocument } from "./types.ts";

export function structuredKeywordQuery(
  query: string,
  structured: StructuredRecallQueryDocument | undefined,
): string {
  if (!structured || structured.lex.include.length === 0) return query;
  return structured.lex.include.join(" ");
}

export function structuredSemanticQuery(
  structured: StructuredRecallQueryDocument | undefined,
): string | null {
  if (!structured) return null;
  const text = [...structured.vec, ...structured.hyde].join("\n\n").trim();
  return text.length > 0 ? text : null;
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export function applyStructuredExclusions(
  results: ReadonlyArray<BrainSearchResult>,
  structured: StructuredRecallQueryDocument | undefined,
): ReadonlyArray<BrainSearchResult> {
  if (!structured || structured.lex.exclude.length === 0) return results;
  return results.filter((result) => {
    const haystack = `${result.path}\n${result.title ?? ""}\n${result.content}`;
    return !structured.lex.exclude.some((term) => includesFolded(haystack, term));
  });
}

export function addStructuredReasons(
  results: ReadonlyArray<BrainSearchResult>,
  structured: StructuredRecallQueryDocument | undefined,
): ReadonlyArray<BrainSearchResult> {
  if (!structured) return results;
  return results.map((result) => {
    const additions: string[] = [];
    if (structured.lex.include.length > 0 && result.keywordScore > 0) {
      additions.push(`lane:lex/fts5 ${result.keywordScore.toFixed(3)}`);
    }
    if (structured.vec.length > 0 && result.semanticScore > 0) {
      additions.push(`lane:vec/semantic ${result.semanticScore.toFixed(3)}`);
    }
    if (structured.hyde.length > 0 && result.semanticScore > 0) {
      additions.push(`lane:hyde/semantic ${result.semanticScore.toFixed(3)}`);
    }
    if (structured.intent !== null) additions.push(`intent:${structured.intent}`);
    if (additions.length === 0) return result;
    return Object.freeze({
      ...result,
      reasons: Object.freeze([...result.reasons, ...additions]),
    });
  });
}
