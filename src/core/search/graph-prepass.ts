/**
 * Graph-index query pre-pass (Retrieval & Ranking Quality, t_59ae326f).
 *
 * A read-planning stage that decides WHICH notes are worth opening, and
 * can answer from index metadata alone. Given a query it:
 *
 *   1. Ranks candidate notes by title / summary term match, wikilink
 *      degree, and (optional) tier weight - the "seeds".
 *   2. Connects the top seeds through MULTI-HOP BFS over the resolved
 *      wikilink graph (the existing `getGraphSnapshot` undirected
 *      adjacency), so a note reachable only via several link hops is
 *      surfaced - the capability the 1-hop link boost in the ranker lacks.
 *   3. Returns a `should_read` shortlist instead of hydrating chunks
 *      blindly.
 *
 * In `index_only` mode it ranks and answers from the index (path, title,
 * degree, link paths) with ZERO note bodies read - only `documentTitles`
 * (a `documents`-table read) is consulted. This complements `recall_gate`
 * (decides IF to recall) and `context_pack` (budget-bounds WHAT is
 * injected) with a WHICH-to-read planner. Pure-stdlib, no new dependency.
 */

import { Store } from "./store.ts";
import { getGraphSnapshot } from "../brain/link-graph/graph-index.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** One entry in the should-read shortlist. */
export interface ShouldReadEntry {
  readonly documentId: number;
  readonly path: string;
  readonly title: string | null;
  readonly degree: number;
  /** Minimum link-hops from any seed (0 = the note is itself a seed). */
  readonly hops: number;
  readonly score: number;
  /** Preview of the note head; null in index_only mode (no body read). */
  readonly summary: string | null;
  /** Explainable contributions, e.g. ["title", "degree", "bfs:2"]. */
  readonly reasons: ReadonlyArray<string>;
}

export interface GraphPrepassResult {
  readonly mode: "should_read" | "index_only";
  readonly shortlist: ReadonlyArray<ShouldReadEntry>;
  /** Count of note bodies hydrated (always 0 in index_only mode). */
  readonly notesRead: number;
}

export interface GraphPrepassOptions {
  /** Answer from index metadata with zero note bodies read. */
  readonly indexOnly?: boolean;
  /** Max seeds carried into BFS (default 10). */
  readonly seedLimit?: number;
  /** BFS hop depth over the wikilink graph (default 2). */
  readonly maxHops?: number;
  /** Per-hop score multiplier in (0, 1] (default 0.5). */
  readonly hopDecay?: number;
  /** Max shortlist entries returned (default 10). */
  readonly shortlistLimit?: number;
  /** Weight of the normalized wikilink degree signal (default 0.15). */
  readonly degreeWeight?: number;
  /** Summary-preview length in characters for should_read mode (default 200). */
  readonly summaryChars?: number;
}

const WORD_RE = /[\p{L}\p{N}]{2,}/gu;

function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.toLowerCase().matchAll(WORD_RE)) out.add(m[0]);
  return [...out];
}

/** Fraction of query terms present in `text` (case-insensitive substring). */
function termMatchFraction(text: string | null, terms: ReadonlyArray<string>): number {
  if (!text || terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

/**
 * Plan a should-read shortlist for a query. Deterministic: ties break by
 * ascending path, so identical index + query yields identical output.
 */
export function planReadShortlist(
  store: Store,
  query: string,
  opts: GraphPrepassOptions = {},
): GraphPrepassResult {
  const indexOnly = opts.indexOnly === true;
  const seedLimit = Math.max(1, Math.floor(opts.seedLimit ?? 10));
  const maxHops = Math.max(0, Math.floor(opts.maxHops ?? 2));
  const hopDecay = opts.hopDecay ?? 0.5;
  const shortlistLimit = Math.max(1, Math.floor(opts.shortlistLimit ?? 10));
  const degreeWeight = opts.degreeWeight ?? 0.15;
  const summaryChars = Math.max(0, Math.floor(opts.summaryChars ?? 200));

  const snapshot = getGraphSnapshot(store);
  const titles = store.documentTitles();
  const terms = queryTerms(query);

  const maxDegree = Math.max(1, ...[...snapshot.degree.values()], 1);

  // ── seed ranking: title match + degree (+ summary match when bodies allowed).
  const seedScore = new Map<number, number>();
  const seedReasons = new Map<number, string[]>();
  // A note becomes a seed only when the query matches its title - degree
  // merely BOOSTS a matched seed, it never seeds an unrelated note. This
  // keeps the pre-pass query-driven (no match -> no seeds -> empty plan)
  // and index-light (title is a `documents`-column read, no body scan).
  for (const [id, meta] of titles) {
    const titleFrac = termMatchFraction(meta.title, terms);
    if (titleFrac <= 0) continue;
    const degree = snapshot.degree.get(id) ?? 0;
    const degreeNorm = (degree / maxDegree) * degreeWeight;
    const reasons = ["title"];
    if (degreeNorm > 0) reasons.push("degree");
    seedScore.set(id, titleFrac + degreeNorm);
    seedReasons.set(id, reasons);
  }

  // In should_read mode, enrich seeds with a summary-match signal from the
  // note head (one representative chunk per candidate seed).
  const summaries = new Map<number, string>();
  if (!indexOnly && seedScore.size > 0) {
    const seedIds = [...seedScore.keys()];
    const reps = store.representativeChunks(seedIds);
    for (const [id, chunk] of reps) {
      const head = chunk.content.slice(0, summaryChars);
      summaries.set(id, head);
      const frac = termMatchFraction(chunk.content, terms);
      if (frac > 0) {
        seedScore.set(id, (seedScore.get(id) ?? 0) + frac * 0.5);
        const r = seedReasons.get(id) ?? [];
        if (!r.includes("summary")) r.push("summary");
        seedReasons.set(id, r);
      }
    }
  }

  const seeds = [...seedScore.entries()]
    .toSorted((a, b) =>
      a[1] !== b[1]
        ? b[1] - a[1]
        : (titles.get(a[0])?.path ?? "") < (titles.get(b[0])?.path ?? "")
          ? -1
          : 1,
    )
    .slice(0, seedLimit);

  // ── multi-hop BFS from the seeds over the undirected wikilink graph.
  // Each node keeps the best (score, hops) it is reached with.
  const best = new Map<number, { score: number; hops: number }>();
  for (const [seedId, sScore] of seeds) {
    best.set(seedId, { score: sScore, hops: 0 });
  }
  for (const [seedId, sScore] of seeds) {
    let frontier: number[] = [seedId];
    const seen = new Set<number>([seedId]);
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: number[] = [];
      const decayed = sScore * hopDecay ** hop;
      for (const node of frontier) {
        for (const nb of snapshot.adjacency.get(node) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          next.push(nb);
          const prev = best.get(nb);
          if (!prev || decayed > prev.score) best.set(nb, { score: decayed, hops: hop });
          else if (decayed > 0 && hop < prev.hops) best.set(nb, { score: prev.score, hops: hop });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  const seedIdSet = new Set(seeds.map(([id]) => id));
  const ranked = [...best.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .toSorted((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : (titles.get(a.id)?.path ?? "") < (titles.get(b.id)?.path ?? "")
          ? -1
          : 1,
    )
    .slice(0, shortlistLimit);

  const shortlist: ShouldReadEntry[] = ranked.map((r) => {
    const meta = titles.get(r.id);
    const reasons = [...(seedReasons.get(r.id) ?? [])];
    if (!seedIdSet.has(r.id) || r.hops > 0) reasons.push(`bfs:${r.hops}`);
    return Object.freeze({
      documentId: r.id,
      path: meta?.path ?? String(r.id),
      title: meta?.title ?? null,
      degree: snapshot.degree.get(r.id) ?? 0,
      hops: r.hops,
      score: r.score,
      summary: indexOnly ? null : (summaries.get(r.id) ?? null),
      reasons: Object.freeze(reasons),
    });
  });

  return Object.freeze({
    mode: indexOnly ? "index_only" : "should_read",
    shortlist: Object.freeze(shortlist),
    notesRead: indexOnly ? 0 : summaries.size,
  });
}

/**
 * Config-level wrapper: open a read store, plan the shortlist, close.
 * The CLI/MCP surface calls this; unit tests call {@link planReadShortlist}
 * directly against an open store.
 */
export async function planRead(
  config: ResolvedSearchConfig,
  query: string,
  opts: GraphPrepassOptions = {},
): Promise<GraphPrepassResult> {
  const store = await Store.open(config, { mode: "read", loadVec: false });
  try {
    return planReadShortlist(store, query, opts);
  } finally {
    await store.close();
  }
}
