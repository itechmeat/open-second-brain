/**
 * Persistent query-cache helpers (v0.20.0).
 *
 * The cache stores a serialized {@link SearchOutcome} keyed by a hash of
 * the result-affecting request (the search options + the query plan hash
 * + a fingerprint of the resolved config) and tagged with the corpus
 * generation it was computed under. A row is served only when its
 * generation matches the current one and it is within the TTL; otherwise
 * the caller recomputes. This module owns the key construction and the
 * (de)serialization; the SQLite I/O lives on `Store`.
 *
 * The expansion terms are deliberately NOT part of the key: they are a
 * deterministic function of (query, index content), and any index
 * content change bumps the corpus generation, so the generation gate
 * already covers them.
 */

import type { Store } from "./store.ts";
import type { SearchOptions, SearchOutcome } from "./types.ts";

/** Deterministic FNV-1a 32-bit hash, hex-encoded. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Canonicalise a property filter map: sort values per key, then keys. */
function canonicalProperties(
  props: ReadonlyMap<string, ReadonlyArray<string>> | undefined,
): Array<[string, string[]]> | null {
  if (!props || props.size === 0) return null;
  return [...props.entries()]
    .map(([k, v]) => [k, [...v].toSorted()] as [string, string[]])
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function canonicalStructuredQuery(opts: SearchOptions): unknown {
  const structured = opts.structuredQuery;
  if (!structured) return null;
  return {
    intent: structured.intent,
    lexInclude: [...structured.lex.include],
    lexExclude: [...structured.lex.exclude],
    vec: [...structured.vec],
    hyde: [...structured.hyde],
  };
}

function canonicalSessionFocus(opts: SearchOptions): unknown {
  const focus = opts.sessionFocus;
  if (focus === undefined) return "persisted";
  if (focus === null) return null;
  return {
    query: focus.query,
    pathPrefix: focus.pathPrefix,
    expiresAt: focus.expiresAt,
  };
}

/**
 * Build a stable cache key from the result-affecting request. Every
 * option that can change the result set is folded in, in a canonical
 * (order-independent) form, alongside the plan hash and a fingerprint of
 * the resolved config.
 */
export function buildCacheKey(
  opts: SearchOptions,
  planHash: string,
  configFingerprint: string,
): string {
  const canonical = JSON.stringify({
    q: (opts.query ?? "").trim(),
    limit: opts.limit ?? null,
    semantic: opts.semantic ?? null,
    keywordOnly: opts.keywordOnly ?? false,
    pathPrefix: opts.pathPrefix ?? null,
    keywordWeight: opts.keywordWeight ?? null,
    semanticWeight: opts.semanticWeight ?? null,
    mmrLambda: opts.mmrLambda ?? null,
    maxHops: opts.maxHops ?? null,
    evidencePack: opts.evidencePack === true,
    properties: canonicalProperties(opts.properties),
    visibility: opts.visibility ? [...opts.visibility].toSorted() : null,
    agentScope: opts.agentScope ?? null,
    structuredQuery: canonicalStructuredQuery(opts),
    sessionFocus: canonicalSessionFocus(opts),
    plan: planHash,
    cfg: configFingerprint,
  });
  return fnv1a(canonical);
}

/**
 * Return the cached outcome for `key` when it is present, computed under
 * the current `generation`, and within `ttlMs` of `nowMs`. Otherwise
 * null (the caller recomputes). A corrupt payload also returns null.
 */
export function getCachedOutcome(
  store: Store,
  key: string,
  generation: string,
  ttlMs: number,
  nowMs: number,
): SearchOutcome | null {
  const row = store.queryCacheGet(key);
  if (!row) return null;
  if (row.generation !== generation) return null;
  if (nowMs - row.createdAt > ttlMs) return null;
  try {
    const parsed = JSON.parse(row.payload) as SearchOutcome;
    // Match the fresh-compute path's immutability: freeze the results
    // array and each result so a hit is indistinguishable from a miss.
    for (const r of parsed.results) Object.freeze(r);
    Object.freeze(parsed.results);
    Object.freeze(parsed.warnings);
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

/** Serialize and store an outcome under the current generation. */
export function putCachedOutcome(
  store: Store,
  key: string,
  generation: string,
  outcome: SearchOutcome,
  nowMs: number,
): void {
  store.queryCachePut(key, generation, JSON.stringify(outcome), nowMs);
}
