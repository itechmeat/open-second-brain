/**
 * Typed-edge relational arm (t_09b7ccea): the fourth RRF arm. Resolves the
 * query's wikilink seeds, fans out over typed edges, and contributes one
 * representative chunk per reached node - with the link types and hop
 * distance it was reached by, for attribution.
 */

import { DEFAULT_RELATION_TYPES, normalizeRelation } from "../../graph/relation-vocab.ts";
import { loadSchemaPack } from "../../brain/schema-pack.ts";
import { rrfKey } from "../../scope-key.ts";
import { relationalFanout } from "../relational-fanout.ts";
import { parseRelationalQuery } from "../relational-query.ts";
import type { Store } from "../store.ts";
import type { ResolvedSearchConfig, SearchOptions } from "../types.ts";

/** Bounded typed-edge fan-out depth for the relational arm (t_09b7ccea). */
const RELATIONAL_MAX_DEPTH = 2;

export interface RelationalReach {
  readonly via: ReadonlyArray<string>;
  readonly hops: number;
}

export interface RelationalArmOutcome {
  readonly rankedChunkIds: number[];
  readonly reachByChunk: Map<number, RelationalReach>;
}

/**
 * The arm engages ONLY in rrf fusion and when enabled (per-call override
 * ahead of the config default). Off / linear fusion leaves the pool and
 * ranking byte-identical.
 */
export function isRelationalArmActive(config: ResolvedSearchConfig, opts: SearchOptions): boolean {
  return config.fusionMode === "rrf" && (opts.relationalArm ?? config.recall.relationalArmEnabled);
}

export function noRelationalArm(): RelationalArmOutcome {
  return { rankedChunkIds: [], reachByChunk: new Map() };
}

/**
 * A bounded depth-2 typed-edge fan-out from the resolved seeds. A
 * non-relational query (no wikilink seed plus schema-vocabulary edge-type
 * token) contributes nothing. Source identity from the shared key module
 * dedups the lane (federation hardening).
 */
export function runRelationalArm(store: Store, vault: string, query: string): RelationalArmOutcome {
  const outcome = noRelationalArm();
  const relQuery = parseRelationalQuery(query, relationalEdgeVocabulary(vault));
  if (relQuery === null) return outcome;
  const seedDocIds = resolveSeedDocumentIds(store, relQuery.seeds);
  if (seedDocIds.length === 0) return outcome;
  const nodes = relationalFanout(store, seedDocIds, {
    maxDepth: RELATIONAL_MAX_DEPTH,
    edgeTypes: relQuery.edgeTypes,
  });
  const reps = store.representativeChunks(nodes.map((n) => n.documentId));
  const seenKeys = new Set<string>();
  for (const node of nodes) {
    const rep = reps.get(node.documentId);
    if (rep === undefined) continue;
    const key = rrfKey({ origin: null, path: rep.path, chunkId: rep.chunkId });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    outcome.rankedChunkIds.push(rep.chunkId);
    outcome.reachByChunk.set(rep.chunkId, { via: node.viaLinkTypes, hops: node.hops });
  }
  return outcome;
}

/**
 * The recognised edge-type vocabulary for the relational parser: the schema
 * pack's declared link types unioned with the default relation vocabulary,
 * all normalized. An unreadable pack falls back to the defaults. This is the
 * only place edge-type vocabulary enters the search path - never a
 * natural-language word list.
 */
function relationalEdgeVocabulary(vault: string): string[] {
  const vocab = new Set<string>(DEFAULT_RELATION_TYPES.map((t) => normalizeRelation(t)));
  try {
    for (const t of loadSchemaPack(vault).link_types) vocab.add(normalizeRelation(t));
  } catch {
    // An unreadable schema pack falls back to the default relation vocabulary.
  }
  return [...vocab];
}

/**
 * Resolve relational-query wikilink seeds to document ids. Tries the exact
 * `<seed>.md` path, then the bare seed, then an UNAMBIGUOUS basename match
 * anywhere in the tree (an ambiguous basename stays unresolved -
 * deterministic inertness beats guessing the wrong page). Deduped.
 */
function resolveSeedDocumentIds(store: Store, seeds: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let titles: Map<number, { readonly path: string; readonly title: string | null }> | null = null;
  for (const seed of seeds) {
    let docId = store.getDocumentIdByPath(`${seed}.md`) ?? store.getDocumentIdByPath(seed);
    if (docId === null) {
      titles ??= store.documentTitles();
      const matches: number[] = [];
      for (const [id, meta] of titles) {
        const base = meta.path.split("/").pop() ?? meta.path;
        if (base === `${seed}.md`) matches.push(id);
      }
      if (matches.length === 1) docId = matches[0]!;
    }
    if (docId !== null && !seen.has(docId)) {
      seen.add(docId);
      out.push(docId);
    }
  }
  return out;
}
