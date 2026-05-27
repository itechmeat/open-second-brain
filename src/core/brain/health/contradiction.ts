/**
 * Cross-preference contradiction detector (F1).
 *
 * Surfaces pairs of confirmed preferences that are about the same
 * subject but carry an opposite sign of record. "Same subject" is a
 * structural signal - principle token overlap (jaccard) via the shared
 * `similarity.ts` walker - and the polarity comes from `sign.ts`, which
 * derives each preference's sign from its `evidenced_by` signals. There
 * is no negation dictionary and no per-language vocabulary: a rule and
 * its negation share most of their tokens, so a high-overlap pair with
 * opposite signs is the language-agnostic shape of a contradiction.
 *
 * Pure and deterministic: identical input yields identical findings on
 * every Syncthing peer.
 */

import { dominantSignOf } from "../sign.ts";
import { findSimilarPairs, tokenise } from "../similarity.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  type BrainPreferenceStatus,
  type BrainSignalSign,
} from "../types.ts";

/**
 * Narrow projection of {@link BrainPreference} the detector needs. The
 * full preference type satisfies this structurally, so callers pass
 * parsed preferences directly.
 */
export interface PreferenceForContradiction {
  readonly id: string;
  readonly scope?: string;
  readonly status: BrainPreferenceStatus;
  readonly principle: string;
  readonly evidenced_by: ReadonlyArray<string>;
}

export interface ContradictionFinding {
  readonly aId: string;
  readonly bId: string;
  /** Shared scope of the pair (the bucket key); `null` when unscoped. */
  readonly scope: string | null;
  readonly jaccard: number;
  readonly aSign: BrainSignalSign;
  readonly bSign: BrainSignalSign;
}

export interface DetectContradictionsOptions {
  /** Minimum principle jaccard for two preferences to count as the same subject. */
  readonly jaccard: number;
}

/**
 * Detect contradictory confirmed-preference pairs. Preferences are
 * bucketed by scope (so only same-scope rules are compared), paired by
 * principle token similarity at or above `jaccard`, and kept only when
 * the two resolved signs disagree. Preferences whose sign cannot be
 * resolved from evidence are skipped rather than guessed.
 */
export function detectContradictions(
  prefs: ReadonlyArray<PreferenceForContradiction>,
  signSignById: ReadonlyMap<string, BrainSignalSign>,
  opts: DetectContradictionsOptions,
): ContradictionFinding[] {
  const signById = new Map<string, BrainSignalSign>();
  const entries = [];
  for (const p of prefs) {
    if (p.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    const sign = dominantSignOf(p.evidenced_by, signSignById);
    if (sign === "unknown") continue;
    signById.set(p.id, sign);
    entries.push({
      id: p.id,
      bucketKey: p.scope ?? "",
      tokens: tokenise(p.principle),
      source: p,
    });
  }

  const pairs = findSimilarPairs(entries, { threshold: opts.jaccard });
  const out: ContradictionFinding[] = [];
  for (const pair of pairs) {
    const aSign = signById.get(pair.a.id)!;
    const bSign = signById.get(pair.b.id)!;
    if (aSign === bSign) continue;
    out.push({
      aId: pair.a.id,
      bId: pair.b.id,
      scope: pair.a.source.scope ?? null,
      jaccard: pair.jaccard,
      aSign,
      bSign,
    });
  }
  out.sort((x, y) => x.aId.localeCompare(y.aId) || x.bId.localeCompare(y.bId));
  return out;
}
