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

/** Deterministic merge order: score desc, then label, path, chunk id. */
function compareMerged(a: BrainSearchResult, b: BrainSearchResult): number {
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
  const merged: BrainSearchResult[] = [];
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

  // Origins run sequentially: each opens its own SQLite store, and a
  // handful of local index reads gains nothing from interleaving.
  for (const origin of origins) {
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
      warnings.push(...outcome.warnings.map((warning) => `[${origin.label}] ${warning}`));
      total += outcome.total;
    } catch (exc) {
      warnings.push(`[${origin.label}] ${(exc as Error).message ?? String(exc)}`);
    }
  }

  merged.sort(compareMerged);
  return Object.freeze({
    results: Object.freeze(merged.slice(0, limit)),
    warnings: Object.freeze(warnings),
    // Sum of per-origin totals - informational, mirrors single-vault
    // semantics where `total` can exceed the capped `results` length.
    total,
  });
}
