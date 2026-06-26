/**
 * Cross-vault union search (Workspace Insight Suite, t_72a22658).
 *
 * Fans one query out over every search origin - the active vault,
 * registered profile vaults, and read-only recall sources - and merges
 * the per-origin outcomes into one result list ordered by score.
 * Every result carries its origin label both as an additive `origin`
 * field and as an `origin:<label>` entry riding the existing
 * `reasons[]` mechanism.
 *
 * Read-only invariants concentrate here:
 *   - non-active origins search with `selfHeal: false`, so a missing
 *     or stale index is NEVER rebuilt inside an external vault;
 *   - non-active origins search with the query cache disabled, so no
 *     cache rows are written into an external index;
 *   - a failing origin (no index, schema mismatch, unreadable store)
 *     contributes a `[label] ...` warning, never an error.
 *
 * Scores merge as-is: every origin runs the same ranking pipeline with
 * the same options, which keeps them comparable enough for a first
 * version; the origin label makes any skew diagnosable per result.
 */

import { resolve } from "node:path";

import { listSearchOrigins } from "../brain/portability/origins.ts";
import { resolveSearchConfig } from "./index.ts";
import { search } from "./search.ts";
import { readActiveSessionFocus } from "./session-focus.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchCard,
  SearchOptions,
  SearchOutcome,
} from "./types.ts";

function labelled(result: BrainSearchResult, label: string): BrainSearchResult {
  return Object.freeze({
    ...result,
    origin: label,
    reasons: Object.freeze([...result.reasons, `origin:${label}`]),
  });
}

/** Cards mirror results: same origin label, same `origin:<label>` reason. */
function labelledCard(card: SearchCard, label: string): SearchCard {
  return Object.freeze({
    ...card,
    origin: label,
    reasons: Object.freeze([...card.reasons, `origin:${label}`]),
  });
}

/** The fields the merge order reads - shared by results and cards. */
interface MergeKey {
  readonly score: number;
  readonly origin?: string;
  readonly path: string;
  readonly chunkId: number;
}

/** Deterministic merge order: score desc, then label, path, chunk id. */
function compareMerged(a: MergeKey, b: MergeKey): number {
  if (a.score !== b.score) return b.score - a.score;
  const al = a.origin ?? "";
  const bl = b.origin ?? "";
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.chunkId - b.chunkId;
}

export async function searchAcrossVaults(
  configPath: string,
  activeVault: string,
  opts: SearchOptions,
  /**
   * Caller-resolved config for the ACTIVE origin (preserves CLI
   * overrides like --db / --keyword-weight in global mode). Non-active
   * origins always resolve fresh: per-vault overrides such as a dbPath
   * would point at the wrong index there.
   */
  activeConfig?: ResolvedSearchConfig,
): Promise<SearchOutcome> {
  const origins = listSearchOrigins(configPath, activeVault);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  // Cards mode (disclosure: "cards") puts each origin's hits on `outcome.cards`
  // and leaves `outcome.results` empty; full mode is the reverse. Merge the
  // collection this mode populates and mirror single-vault return semantics.
  const cardsMode = opts.disclosure === "cards";
  const merged: BrainSearchResult[] = [];
  const mergedCards: SearchCard[] = [];
  const warnings: string[] = [];
  let total = 0;

  // Session focus resolves ONCE in the active-vault context: otherwise
  // each origin would load ITS OWN persisted search-focus state and
  // filter its slice of the union differently.
  let sessionFocus = opts.sessionFocus;
  if (sessionFocus === undefined) {
    try {
      const focusConfig =
        activeConfig ?? resolveSearchConfig({ vault: resolve(activeVault), configPath });
      sessionFocus = readActiveSessionFocus(focusConfig, opts.focusSession, Date.now());
    } catch {
      sessionFocus = null;
    }
  }

  // Normalized-confidence chain-stop policy is an active-origin decision
  // (t_23c1b929): the active vault's resolved config governs whether and
  // when the union short-circuits. External origins resolve fresh and their
  // own knob never gates the union. Resolved once, before the loop.
  const activeRecall = (
    activeConfig ?? resolveSearchConfig({ vault: resolve(activeVault), configPath })
  ).recall;

  let chainStop: SearchOutcome["chainStop"];

  // Origins run sequentially: each opens its own SQLite store, and a
  // handful of local index reads gains nothing from interleaving.
  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i]!;
    const isActive = origin.kind === "active";
    try {
      const base =
        isActive && activeConfig !== undefined
          ? activeConfig
          : resolveSearchConfig({ vault: origin.vault, configPath });
      // Never write cache rows into a read-only external index.
      const config = isActive
        ? base
        : Object.freeze({
            ...base,
            recall: Object.freeze({ ...base.recall, cacheEnabled: false }),
          });
      // eslint-disable-next-line no-await-in-loop -- per-origin stores, sequential by design
      const outcome = await search(config, {
        ...opts,
        sessionFocus,
        limit,
        ...(isActive ? {} : { selfHeal: false }),
      });
      merged.push(...outcome.results.map((result) => labelled(result, origin.label)));
      if (outcome.cards !== undefined) {
        mergedCards.push(...outcome.cards.map((card) => labelledCard(card, origin.label)));
      }
      warnings.push(...outcome.warnings.map((warning) => `[${origin.label}] ${warning}`));
      total += outcome.total;
      // Chain-stop: if this origin answered confidently (its top NORMALIZED
      // [0,1] result score reached the threshold) and origins remain, skip
      // them. Take the MAX score over the origin's results rather than `[0]`:
      // the final result order is not always score-desc (rerank and MMR reorder
      // by relevance/diversity), so the positional first element is not
      // necessarily the score-max. The gate reads the normalized result score,
      // never the raw lane score, so a tiny-corpus origin with a high raw score
      // does not short-circuit. Only recorded when origins were actually
      // skipped, keeping the single-origin and never-triggered paths identical.
      const remaining = origins.slice(i + 1);
      // Gate on whichever collection THIS mode populates: in cards mode results
      // is empty, so reading it would never short-circuit (the latent bug).
      const hits: ReadonlyArray<{ readonly score: number }> = cardsMode
        ? (outcome.cards ?? [])
        : outcome.results;
      const topScore = hits.reduce((max, h) => Math.max(max, h.score), 0);
      if (
        activeRecall.chainStopEnabled &&
        remaining.length > 0 &&
        hits.length > 0 &&
        topScore >= activeRecall.chainStopScore
      ) {
        chainStop = Object.freeze({
          triggered: true as const,
          stoppedAfter: origin.label,
          skipped: Object.freeze(remaining.map((o) => o.label)),
        });
        break;
      }
    } catch (exc) {
      warnings.push(`[${origin.label}] ${(exc as Error).message ?? String(exc)}`);
    }
  }

  merged.sort(compareMerged);
  mergedCards.sort(compareMerged);
  return Object.freeze({
    // Cards mode mirrors single-vault semantics: hits ride `cards`, `results`
    // is empty. Full mode is byte-identical to before (no `cards` key).
    results: cardsMode ? Object.freeze([]) : Object.freeze(merged.slice(0, limit)),
    ...(cardsMode ? { cards: Object.freeze(mergedCards.slice(0, limit)) } : {}),
    warnings: Object.freeze(warnings),
    // Sum of per-origin totals - informational, mirrors single-vault
    // semantics where `total` can exceed the capped result/card length.
    total,
    ...(chainStop ? { chainStop } : {}),
  });
}
