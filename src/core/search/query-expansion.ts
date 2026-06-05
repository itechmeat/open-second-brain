/**
 * Deterministic query expansion producer (link-recall-intelligence,
 * t_2fa95db1).
 *
 * The structured lex/vec/hyde recall document has had a consumer since
 * `structured-query.ts` landed, but the lanes had to be authored
 * upstream by the caller. `expandQuery` is the local producer: pure
 * string work plus one read of the vault's entity registry - no local
 * model, no paid call, identical output for identical input.
 *
 *   - lex: query tokens minus stopwords (the FTS lane is implicit AND,
 *     so one stopword absent from the target note kills the match);
 *     falls back to the raw tokens when everything is a stopword.
 *   - vec: the raw query, plus one entity-context line when registry
 *     entities match a query token - anchors the semantic lane to the
 *     vault's own vocabulary.
 *   - hyde: one template passage shaped like the note that would
 *     answer the query, for embedding retrieval.
 *
 * Expansion is OPT-IN per call (`search(config, {expand: true})`,
 * `o2b brain search --expand`) and never silently active, so cached
 * queries and benchmark runs stay comparable.
 */

import { listEntities } from "../brain/entities/registry.ts";
import { tokenizeForExpansion } from "./synonyms.ts";
import type { StructuredRecallQueryDocument } from "./structured-query.ts";

/** Default cap on lex include terms. */
export const EXPANSION_MAX_LEX_TERMS = 8;
/** Default cap on matched registry entities woven into vec/hyde. */
export const EXPANSION_MAX_ENTITIES = 3;

/**
 * Small closed-class English stopword set. Deliberately conservative:
 * a missed stopword only leaves one extra AND term, while an
 * over-eager list would silently drop signal.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "show",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export interface ExpandQueryOptions {
  readonly maxLexTerms?: number;
  readonly maxEntities?: number;
}

/**
 * Build a structured recall query document from a bare query.
 * Deterministic; reads only the entity registry under `vault`.
 */
export function expandQuery(
  vault: string,
  query: string,
  opts: ExpandQueryOptions = {},
): StructuredRecallQueryDocument {
  const maxLexTerms = Math.max(1, opts.maxLexTerms ?? EXPANSION_MAX_LEX_TERMS);
  const maxEntities = Math.max(0, opts.maxEntities ?? EXPANSION_MAX_ENTITIES);
  const trimmed = query.trim();

  const tokens = [...new Set(tokenizeForExpansion(trimmed))];
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  // Fall back to the raw tokens when the whole query is stopwords -
  // an empty lex lane would turn the FTS lane off entirely.
  const lexTerms = (meaningful.length > 0 ? meaningful : tokens).slice(0, maxLexTerms);

  const entityNames = matchEntities(vault, meaningful.length > 0 ? meaningful : tokens).slice(
    0,
    maxEntities,
  );

  const vec: string[] = [trimmed];
  if (entityNames.length > 0) {
    vec.push(`${trimmed} - related to ${entityNames.join(", ")}`);
  }

  const subject = lexTerms.join(" ");
  const hydeParts = [`A note about ${subject}.`];
  if (entityNames.length > 0) {
    hydeParts.push(`It covers ${entityNames.join(", ")}.`);
  }
  hydeParts.push(`Key decisions, references, and context for ${subject}.`);

  return Object.freeze({
    intent: null,
    lex: Object.freeze({
      include: Object.freeze(lexTerms) as ReadonlyArray<string>,
      exclude: Object.freeze([]) as ReadonlyArray<string>,
    }),
    vec: Object.freeze(vec) as ReadonlyArray<string>,
    hyde: Object.freeze([hydeParts.join(" ")]) as ReadonlyArray<string>,
  });
}

/**
 * Registry entities whose name (or alias) shares a token with the
 * query, sorted by name for determinism. Fail-soft: a vault without a
 * registry simply matches nothing.
 */
function matchEntities(vault: string, queryTokens: ReadonlyArray<string>): string[] {
  if (queryTokens.length === 0) return [];
  const wanted = new Set(queryTokens);
  let names: string[];
  try {
    names = listEntities(vault, { status: "active" })
      .filter((entity) =>
        [entity.name, ...entity.aliases].some((label) =>
          tokenizeForExpansion(label).some((token) => wanted.has(token)),
        ),
      )
      .map((entity) => entity.name);
  } catch {
    return [];
  }
  return [...new Set(names)].toSorted();
}
