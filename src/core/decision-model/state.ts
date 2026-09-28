/**
 * State builder: turns candidates Open Second Brain's own code produced
 * into the `state` a decision request carries, under the privacy rules.
 *
 *   - Private pages never leave. A candidate whose visibility carries the
 *     reserved `private` token, or whose visibility could not be resolved
 *     at all, is dropped before anything is built. The search index keeps
 *     private page text, so this filter cannot rely on an upstream one.
 *   - `<private>` regions are stripped from every candidate text. A
 *     candidate is a search chunk, and a long region can be split across
 *     chunks, so a chunk may carry private text without either tag. The
 *     caller therefore hands over the page's own private regions, and a
 *     candidate whose stripped text still shares a line with one of them
 *     is withheld. A candidate whose page could not be read is withheld.
 *   - Candidate ids and vault paths never appear: candidates are masked as
 *     `P0..Pn` (or a use-specific prefix) and the mapping stays in memory.
 *   - Each text is clipped to a per-use constant from `questions.ts`.
 *   - A candidate may carry a few short named fields beside its text (the
 *     rerank sends the note title, `status` and `updated`); the passage is
 *     then an object `{ ...fields, text }`, and the fields pass the same
 *     private-region checks as the text. Without fields it stays a string.
 *   - A candidate the caller marks `skip` (nothing useful to judge, e.g. a
 *     chunk holding only frontmatter) is not sent and keeps its position.
 *   - The state is kept within `max_state_tokens` by dropping the
 *     lowest-ranked candidates; when not even one fits, the caller
 *     degrades with `budget`.
 *
 * Redaction of secret-shaped strings happens once, over the whole request
 * body, in the adapter (`redactForEgress`), so it covers question texts
 * too.
 *
 * State text is vault content and may try to steer the answer. That is
 * acceptable only because no decision authorises a write.
 */

import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { PRIVATE_REGION_PLACEHOLDER, stripPrivateRegions } from "../redactor.ts";

/**
 * Conservative characters-per-token estimate. The hosted tokenizer yields
 * noticeably more tokens than common character heuristics, so this errs
 * towards overestimating; refine from recorded `usage.input_tokens`.
 */
export const STATE_CHARS_PER_TOKEN = 2;

/** Room reserved for the longest question beside the state, in tokens. */
export const QUESTION_TOKEN_ALLOWANCE = 256;

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / STATE_CHARS_PER_TOKEN);
}

export interface StateCandidate {
  readonly text: string;
  /**
   * Normalised visibility tokens of the candidate's page, or null when the
   * visibility could not be resolved (such a candidate is never sent).
   */
  readonly visibility: ReadonlyArray<string> | null;
  /**
   * The `<private>` regions of the candidate's whole page (tags included),
   * or null when the page could not be read (such a candidate is never
   * sent). Empty when the page has none.
   */
  readonly privateRegions: ReadonlyArray<string> | null;
  /**
   * Short named fields sent beside the text, already clipped by the
   * caller. Absent: the passage is the bare text string.
   */
  readonly fields?: Readonly<Record<string, string>>;
  /** Not sent at all (nothing to judge); keeps its position. */
  readonly skip?: boolean;
}

/** One masked passage: the bare text, or the text beside its named fields. */
export type StatePassage = string | Readonly<Record<string, string>>;

export interface CandidateStateInput {
  readonly candidates: ReadonlyArray<StateCandidate>;
  /** Mask prefix, e.g. `P` gives `P0`, `P1`, ... */
  readonly prefix: string;
  readonly clipChars: number;
  readonly maxStateTokens: number;
  /**
   * Wrap the masked passages into the full state object. A passage is the
   * bare text, or `{ ...fields, text }` for a candidate that carries
   * fields. Declared as a method so a use whose candidates carry no fields
   * may keep typing its passages as plain strings.
   */
  frame(texts: Readonly<Record<string, StatePassage>>): Readonly<Record<string, unknown>>;
}

export type CandidateStateResult =
  | {
      readonly kind: "ok";
      readonly state: Readonly<Record<string, unknown>>;
      /** Candidate index for each mask position: `included[k]` is `P<k>`. */
      readonly included: ReadonlyArray<number>;
      /**
       * Candidates withheld because their page is private, unresolvable or
       * unreadable, or their text carries part of a private region.
       */
      readonly withheld: ReadonlyArray<number>;
      /** Candidates dropped (lowest-ranked first) to fit the budget. */
      readonly dropped: ReadonlyArray<number>;
      /** Candidates the caller marked `skip`; never sent. */
      readonly skipped: ReadonlyArray<number>;
    }
  | { readonly kind: "budget" }
  | { readonly kind: "empty" };

/** Whether a candidate with these tokens may be sent at all. */
export function mayLeaveMachine(visibility: ReadonlyArray<string> | null): boolean {
  return visibility !== null && !visibility.includes(REMOTE_DENY_VISIBILITY_TOKEN);
}

const ORPHAN_PRIVATE_CLOSE_RE = /<\/private\s*>/i;

/**
 * Whether `text` (already stripped of whole regions) still carries a line
 * of one of the page's private regions: the chunk boundary fell inside a
 * region, so a tag is missing and stripping found nothing to remove. Any
 * non-blank line that occurs inside a region counts, which errs towards
 * withholding a public line that repeats private text.
 */
function carriesPrivateText(text: string, regions: ReadonlyArray<string>): boolean {
  // A close tag left after stripping has no matching open tag in this
  // slice: the slice starts inside a region (a chunk or sentence boundary
  // fell there), so the text before the tag is private, even when a public
  // tail on the same line keeps the line from matching a region.
  if (ORPHAN_PRIVATE_CLOSE_RE.test(text)) return true;
  if (regions.length === 0) return false;
  for (const raw of text.split("\n")) {
    const line = raw.split(PRIVATE_REGION_PLACEHOLDER).join("").trim();
    if (line === "") continue;
    if (regions.some((region) => region.includes(line))) return true;
  }
  return false;
}

export function clip(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
}

export function buildCandidateState(input: CandidateStateInput): CandidateStateResult {
  const withheld: number[] = [];
  const skipped: number[] = [];
  const eligible: Array<{ index: number; passage: StatePassage }> = [];
  input.candidates.forEach((candidate, index) => {
    if (!mayLeaveMachine(candidate.visibility) || candidate.privateRegions === null) {
      withheld.push(index);
      return;
    }
    if (candidate.skip === true) {
      skipped.push(index);
      return;
    }
    const regions = candidate.privateRegions;
    const stripped = stripPrivateRegions(candidate.text);
    if (carriesPrivateText(stripped, regions)) {
      withheld.push(index);
      return;
    }
    const text = clip(stripped, input.clipChars);
    if (candidate.fields === undefined) {
      eligible.push({ index, passage: text });
      return;
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidate.fields)) {
      const cleaned = stripPrivateRegions(value).trim();
      if (cleaned === "") continue;
      // A field that repeats private text withholds the whole candidate,
      // exactly as the text would.
      if (carriesPrivateText(cleaned, regions)) {
        withheld.push(index);
        return;
      }
      fields[key] = cleaned;
    }
    eligible.push({ index, passage: Object.freeze({ ...fields, text }) });
  });
  if (eligible.length === 0) return { kind: "empty" };

  const dropped: number[] = [];
  let kept = eligible;
  for (;;) {
    const texts: Record<string, StatePassage> = {};
    kept.forEach((c, k) => {
      texts[`${input.prefix}${k}`] = c.passage;
    });
    const state = input.frame(texts);
    if (estimateTokens(state) + QUESTION_TOKEN_ALLOWANCE <= input.maxStateTokens) {
      return {
        kind: "ok",
        state,
        included: Object.freeze(kept.map((c) => c.index)),
        withheld: Object.freeze(withheld),
        dropped: Object.freeze(dropped.toReversed()),
        skipped: Object.freeze(skipped),
      };
    }
    if (kept.length <= 1) return { kind: "budget" };
    dropped.push(kept[kept.length - 1]!.index);
    kept = kept.slice(0, -1);
  }
}
