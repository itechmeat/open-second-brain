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
 *   - lex: the query tokens (deduped, capped), minus any the caller
 *     flags as corpus-common via `commonTokens` (high document frequency,
 *     not a hardcoded stopword list - the FTS lane is implicit AND, so a
 *     ubiquitous token would otherwise kill the match). Language-agnostic.
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
import type { StructuredRecallQueryDocument } from "./types.ts";

/** Default cap on lex include terms. */
export const EXPANSION_MAX_LEX_TERMS = 8;
/** Default cap on matched registry entities woven into vec/hyde. */
export const EXPANSION_MAX_ENTITIES = 3;

export interface ExpandQueryOptions {
  readonly maxLexTerms?: number;
  readonly maxEntities?: number;
  /**
   * Corpus-common tokens to drop from the implicit-AND lex lane. The
   * caller derives these from document frequency (a token present in
   * most documents carries little signal, in ANY language), never from a
   * hardcoded stopword list. Defaults to none.
   */
  readonly commonTokens?: ReadonlySet<string>;
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

  // Language-agnostic by construction: no stopword list. Corpus-common
  // tokens (high document frequency, supplied by the caller) are dropped
  // from the implicit-AND lex lane so one ubiquitous word cannot kill the
  // match - in ANY language, driven by data rather than an English word
  // list. Fall back to all tokens when every token is common, so the lex
  // lane never goes empty.
  const commonTokens = opts.commonTokens ?? new Set<string>();
  const allTokens = [...new Set(tokenizeForExpansion(trimmed))];
  const meaningful = allTokens.filter((t) => !commonTokens.has(t));
  const baseTokens = meaningful.length > 0 ? meaningful : allTokens;
  const lexTerms = baseTokens.slice(0, maxLexTerms);

  const entityNames = matchEntities(vault, baseTokens).slice(0, maxEntities);

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
