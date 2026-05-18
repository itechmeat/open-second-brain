/**
 * `findMergeCandidates` — pure-read detector for the `## Merge
 * suggestions` digest section and the upcoming `o2b brain merge`
 * CLI. Pairs of confirmed/quarantine preferences in the same
 * `(topic, scope)` bucket whose `principle` tokens reach jaccard
 * similarity at or above `JACCARD_MERGE_SUGGEST_THRESHOLD`.
 *
 * The bucket-and-pair walk lives in `similarity.ts:findSimilarPairs`
 * and is shared with the `duplicate-preferences` doctor lint —
 * different threshold, same detector body.
 *
 * Callers that already parsed the preferences (digest, doctor)
 * pass them in via `opts.preferences` to avoid a second pass over
 * `Brain/preferences/`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { findSimilarPairs, tokenise } from "./similarity.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  type BrainPreference,
} from "./types.ts";

/** Inclusive lower bound for surfacing a pair to the digest. */
export const JACCARD_MERGE_SUGGEST_THRESHOLD = 0.6;

/**
 * Cap on the size of the rendered list — keeps the digest skimmable.
 * Operators wanting the full picture can call `o2b brain doctor` or
 * the explorer.
 */
export const MERGE_SUGGESTION_LIMIT = 10;

export interface MergeCandidate {
  /** Lexicographically smaller of the two preference ids. */
  readonly a: string;
  readonly b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly principle_a: string;
  readonly principle_b: string;
  /** Jaccard similarity in `[0, 1]`, rounded to two decimal places. */
  readonly jaccard: number;
}

export interface FindMergeCandidatesOptions {
  readonly threshold?: number;
  readonly limit?: number;
  /**
   * Pre-parsed preferences to scan. When set, the detector does not
   * touch the filesystem — useful for callers (digest, doctor) that
   * already walked `Brain/preferences/` for other reasons.
   */
  readonly preferences?: ReadonlyArray<BrainPreference>;
}

export function findMergeCandidates(
  vault: string,
  opts: FindMergeCandidatesOptions = {},
): ReadonlyArray<MergeCandidate> {
  const threshold = opts.threshold ?? JACCARD_MERGE_SUGGEST_THRESHOLD;
  const limit = opts.limit ?? MERGE_SUGGESTION_LIMIT;
  const prefs = opts.preferences ?? readPreferences(vault);

  const entries = [];
  for (const p of prefs) {
    if (
      p.status !== BRAIN_PREFERENCE_STATUS.confirmed
      && p.status !== BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      continue;
    }
    entries.push({
      id: p.id,
      bucketKey: `${p.topic}\x00${p.scope ?? ""}`,
      tokens: tokenise(p.principle),
      source: p,
    });
  }

  const pairs = findSimilarPairs(entries, { threshold });

  const candidates: MergeCandidate[] = pairs.map((pair) => ({
    a: pair.a.id,
    b: pair.b.id,
    topic: pair.a.source.topic,
    scope: pair.a.source.scope ?? null,
    principle_a: pair.a.source.principle,
    principle_b: pair.b.source.principle,
    jaccard: Math.round(pair.jaccard * 100) / 100,
  }));

  candidates.sort((x, y) => {
    const diff = y.jaccard - x.jaccard;
    if (diff !== 0) return diff;
    const da = x.a.localeCompare(y.a);
    if (da !== 0) return da;
    return x.b.localeCompare(y.b);
  });

  return Object.freeze(candidates.slice(0, limit));
}

function readPreferences(vault: string): BrainPreference[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: BrainPreference[] = [];
  for (const f of readdirSync(dirs.preferences, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".md") || !f.name.startsWith("pref-")) continue;
    try {
      out.push(parsePreference(join(dirs.preferences, f.name)));
    } catch {
      // doctor reports corruption; the detector skips silently.
    }
  }
  return out;
}
