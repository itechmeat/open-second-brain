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
 * A starter, deliberately multilingual negation lexicon.
 *
 * The confirmed-preference detector reads polarity from a structured
 * `signal` field and never inspects text, so it needs no lexicon. Note
 * prose carries no such field, so the stance sign must be derived from
 * the prose itself - and the only language-agnostic structural marker of
 * a reversed stance is a negation particle inserted into an otherwise
 * shared claim.
 *
 * This set is a documented DEFAULT, not a baked-in assumption: callers
 * pass `opts.negationMarkers` to override or extend it for their own
 * languages (mirroring `similarity.ts`, which keeps its stopword set
 * empty rather than bias toward English). It spans several space-
 * delimited scripts; single-glyph CJK negations are out of reach of the
 * whitespace tokeniser and left to a caller-supplied lexicon.
 */
export const DEFAULT_NEGATION_MARKERS: ReadonlySet<string> = new Set([
  // English
  "not",
  "no",
  "never",
  "none",
  "neither",
  "nor",
  "cannot",
  "without",
  // Romance (es / fr / pt / it)
  "non",
  "ne",
  "pas",
  "nunca",
  "sin",
  "sem",
  "senza",
  "sans",
  "não",
  "nao",
  // German
  "nicht",
  "kein",
  "keine",
  "nie",
  "ohne",
  // Russian
  "не",
  "нет",
  "ни",
]);

/**
 * Narrow projection of a permanent note the detector needs. The caller
 * is responsible for restricting the input to permanent notes; the
 * detector operates on whatever prose it is handed.
 */
export interface NoteForContradiction {
  readonly id: string;
  /**
   * Optional subject bucket. When present, only notes sharing a subject
   * are compared (mirrors `scope` in the preference detector); absent
   * notes fall into a single bucket and are paired purely by prose
   * token overlap.
   */
  readonly subject?: string;
  readonly text: string;
}

export interface NoteContradictionFinding {
  readonly aId: string;
  readonly bId: string;
  /** Sorted shared subject tokens, space-joined, for display. */
  readonly subject: string;
  readonly jaccard: number;
  readonly aSign: BrainSignalSign;
  readonly bSign: BrainSignalSign;
  /** The subject-bearing span quoted verbatim from note A. */
  readonly aQuote: string;
  /** The subject-bearing span quoted verbatim from note B. */
  readonly bQuote: string;
  /** Always `ask_user`: contradictions are surfaced, never auto-resolved. */
  readonly action: "ask_user";
}

export interface DetectNoteContradictionsOptions {
  /** Minimum prose jaccard for two notes to count as the same subject. */
  readonly jaccard: number;
  /**
   * Negation markers used to derive each note's stance sign from prose.
   * Defaults to {@link DEFAULT_NEGATION_MARKERS}; pass a custom set to
   * override or extend it for a given language.
   */
  readonly negationMarkers?: ReadonlySet<string>;
}

/**
 * Derive a note's stance sign structurally from its prose: a note whose
 * tokens include any negation marker asserts the negative side of its
 * subject; otherwise it reads as positive. No sentiment analysis and no
 * per-language vocabulary beyond the injected marker set.
 */
export function deriveNoteStance(
  tokens: ReadonlySet<string>,
  negationMarkers: ReadonlySet<string>,
): BrainSignalSign {
  for (const t of tokens) {
    if (negationMarkers.has(t)) return "negative";
  }
  return "positive";
}

/**
 * Split prose into candidate spans on sentence terminators (Latin and
 * CJK) and hard line breaks, then return the span with the greatest
 * overlap with `subjectTokens`. Ties break to the earliest span; a note
 * with no scoring span falls back to its first non-empty span, or the
 * trimmed whole text. Deterministic for a given input.
 */
export function extractSpan(text: string, subjectTokens: ReadonlySet<string>): string {
  const segments = text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return text.trim();
  let best = segments[0]!;
  let bestScore = -1;
  for (const segment of segments) {
    const segTokens = tokenise(segment);
    let score = 0;
    for (const t of subjectTokens) if (segTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = segment;
    }
  }
  return best;
}

/**
 * Detect contradictory note-position pairs over permanent-note prose.
 * Notes are bucketed by `subject` (single bucket when absent), paired by
 * prose token similarity at or above `jaccard`, and kept only when the
 * two stance signs - derived structurally from each note's prose -
 * disagree. Each finding quotes the subject-bearing span from both notes
 * and carries `action: "ask_user"`: the pair is surfaced for the
 * operator to clarify, never auto-resolved.
 */
export function detectNoteContradictions(
  notes: ReadonlyArray<NoteForContradiction>,
  opts: DetectNoteContradictionsOptions,
): NoteContradictionFinding[] {
  const negationMarkers = opts.negationMarkers ?? DEFAULT_NEGATION_MARKERS;
  const signById = new Map<string, BrainSignalSign>();
  const entries = [];
  for (const n of notes) {
    const tokens = tokenise(n.text);
    signById.set(n.id, deriveNoteStance(tokens, negationMarkers));
    entries.push({
      id: n.id,
      bucketKey: n.subject ?? "",
      tokens,
      source: n,
    });
  }

  const pairs = findSimilarPairs(entries, { threshold: opts.jaccard });
  const out: NoteContradictionFinding[] = [];
  for (const pair of pairs) {
    const aSign = signById.get(pair.a.id)!;
    const bSign = signById.get(pair.b.id)!;
    if (aSign === bSign) continue;
    const shared: string[] = [];
    for (const t of pair.a.tokens) if (pair.b.tokens.has(t)) shared.push(t);
    shared.sort();
    const sharedSet = new Set(shared);
    out.push({
      aId: pair.a.id,
      bId: pair.b.id,
      subject: shared.join(" "),
      jaccard: pair.jaccard,
      aSign,
      bSign,
      aQuote: extractSpan(pair.a.source.text, sharedSet),
      bQuote: extractSpan(pair.b.source.text, sharedSet),
      action: "ask_user",
    });
  }
  out.sort((x, y) => x.aId.localeCompare(y.aId) || x.bId.localeCompare(y.bId));
  return out;
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
