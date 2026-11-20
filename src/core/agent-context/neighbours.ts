/**
 * The neighbour-updates lane (task 4.3, design D5, D10
 * `neighbour_relevant`): before a turn, the records other devices wrote
 * on topics this session works on (or in its project scope) that change
 * what the agent should do. Pure: the hook shell reads the probe, the
 * fold and the hook state, and this module filters, gates, renders and
 * counts. The deterministic gate is "topic this session works on and
 * kind `decision`"; `neighbour_relevant` refines it.
 *
 * Own records are never returned (spec "Records it wrote itself SHALL
 * never be returned"). "Own" is the session: a record stamped with this
 * session, or a record with no session stamp written by this device and
 * resolved agent name (the rule `log-catchup` applies, design D20 item
 * 16). A record another session of the same agent name stamped on this
 * device is a neighbour's (`session-identity.ts`).
 */

import { compareCodeUnits } from "../store/compare.ts";
import { stripPrivateRegions } from "../redactor.ts";
import { neutralizeSingleLine } from "../brain/untrusted-source.ts";
import { TOPIC_DECISION_LIMITS } from "../decision-model/questions-topics.ts";
import { isOwnRecord } from "./session-identity.ts";

/** The record kinds the lane may surface, newest first among themselves. */
export const NEIGHBOUR_KINDS = Object.freeze([
  "decision",
  "open-question",
  "question-resolved",
  "milestone-done",
  "topic-status",
  "log-entry",
] as const);

/**
 * Most candidates one turn considers: the same limit the decision use
 * asks about, so every candidate the hook keeps can be judged.
 */
export const NEIGHBOUR_CANDIDATES_MAX = TOPIC_DECISION_LIMITS.neighbourCandidatesPerTurn;

/** Most lines one injection carries. */
export const NEIGHBOUR_LINES_MAX = 5;

/** Most characters one injection carries. */
export const NEIGHBOUR_CHARS_MAX = 800;

/** Most characters of a record's text in one line. */
export const NEIGHBOUR_TEXT_CLIP = 200;

/**
 * Fewest characters of a record's text a shown line keeps (or all of a
 * shorter text): below it the block shows one line fewer instead.
 */
export const NEIGHBOUR_TEXT_FLOOR = 60;

/** One candidate record, as the hook shell resolves it. */
export interface NeighbourCandidate {
  readonly record: string;
  readonly kind: string;
  readonly topic: string;
  /** The topic title, from the fold. */
  readonly topicTitle: string;
  /** The record's text via its fold item, or null without one. */
  readonly text: string | null;
  /** Newest first among the candidates (ingest sequence, descending). */
  readonly seq: number;
  readonly device: string;
  readonly agent: string;
  /** The log class of a `log-entry` (routine ones never become candidates). */
  readonly logClass?: string;
  /**
   * Whether the record, its topic or its item sits in `private`: the
   * egress guard decides whether its text may reach the provider.
   */
  readonly private: boolean;
  /** Whether the topic title's winning record sits in `private`. */
  readonly titlePrivate: boolean;
  /** A model-authority record (a dream-derived item), named as such. */
  readonly modelDerived?: boolean;
}

/** A record row of the index, as `getRecord` reads it. */
export interface NeighbourRecordRow {
  readonly id: string;
  readonly seq: number;
  readonly stream: string;
  readonly kind: string;
  readonly topic: string | null;
  readonly scope: string | null;
  readonly device: string;
  readonly agent: string;
  readonly partition: string;
  readonly authority: string | null;
}

/**
 * The records the lane may surface: a neighbour's (never this session's
 * own, {@link isOwnRecord} over the session stamps `sessions` maps record
 * ids to), of the candidate kinds, on stream `topics`, newest first.
 * Uncapped: the caller filters by the session's topics and project first
 * and caps after ({@link capNeighbourCandidates}), so a record that
 * matters here is never pushed out by newer records of other projects.
 */
export function selectNeighbourCandidates(
  rows: ReadonlyArray<NeighbourRecordRow>,
  self: { readonly device: string; readonly agent: string; readonly session: string },
  sessions: ReadonlyMap<string, string>,
): NeighbourRecordRow[] {
  return rows
    .filter(
      (row) =>
        !isOwnRecord(row, sessions.get(row.id), self) &&
        row.stream === "topics" &&
        (NEIGHBOUR_KINDS as ReadonlyArray<string>).includes(row.kind),
    )
    .toSorted((a, b) => b.seq - a.seq || compareCodeUnits(b.id, a.id));
}

/**
 * The newest {@link NEIGHBOUR_CANDIDATES_MAX} of the filtered candidates
 * and how many the cap removed (counted in the cut line).
 */
export function capNeighbourCandidates<T>(candidates: ReadonlyArray<T>): {
  readonly kept: ReadonlyArray<T>;
  readonly capped: number;
} {
  const kept = candidates.slice(0, NEIGHBOUR_CANDIDATES_MAX);
  return { kept, capped: candidates.length - kept.length };
}

/**
 * The deterministic gate (task 4.3 item 6): the topic is one this
 * session works on and the kind is `decision`.
 */
export function deterministicNeighbourGate(
  candidate: { readonly topic: string; readonly kind: string },
  sessionTopics: ReadonlySet<string>,
): boolean {
  return sessionTopics.has(candidate.topic) && candidate.kind === "decision";
}

/**
 * The heading of one topic's updates: the title and the one call that
 * opens the topic, said once for all its lines.
 */
function topicHeading(candidate: NeighbourCandidate): string {
  return (
    `On "${neutralizeSingleLine(stripPrivateRegions(candidate.topicTitle))}" ` +
    `(open it with \`brain_topic\` action \`show\` topic ${candidate.topic}):`
  );
}

/** A line's fixed part: who recorded what, before the text. */
function linePrefix(candidate: NeighbourCandidate): string {
  return (
    `- ${neutralizeSingleLine(candidate.agent)} on ${neutralizeSingleLine(candidate.device)} ` +
    `recorded a ${candidate.modelDerived === true ? "model-derived " : ""}` +
    neutralizeSingleLine(candidate.kind)
  );
}

/** A record's text as one line, before any clip; null without a text. */
function lineText(candidate: NeighbourCandidate): string | null {
  return candidate.text === null ? null : neutralizeSingleLine(stripPrivateRegions(candidate.text));
}

/** `text` cut to `max` characters, an ellipsis marking a cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? "\u2026".slice(0, max) : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * How many characters of text each line gets from `budget`: a line whose
 * text is shorter than an even share keeps all of it and leaves the rest
 * to the others. Null when an even share falls below the floor.
 */
function shareTexts(lengths: ReadonlyArray<number>, budget: number): number[] | null {
  const order = lengths.map((length, i) => ({ length, i })).toSorted((a, b) => a.length - b.length);
  const out = new Array<number>(lengths.length).fill(0);
  let left = budget;
  for (let k = 0; k < order.length; k++) {
    const { length, i } = order[k]!;
    const share = Math.floor(left / (order.length - k));
    const take = Math.min(length, share);
    if (take < Math.min(length, NEIGHBOUR_TEXT_FLOOR)) return null;
    out[i] = take;
    left -= take;
  }
  return out;
}

/**
 * The block of `shown` within the character cap with `tail` as its last
 * line, or null when the lines cannot keep their text floor. Lines are
 * grouped under their topic's heading, in the order the first of each
 * topic comes.
 */
function layoutBlock(shown: ReadonlyArray<NeighbourCandidate>, tail: string): string | null {
  const topics: string[] = [];
  const byTopic = new Map<string, NeighbourCandidate[]>();
  for (const candidate of shown) {
    const group = byTopic.get(candidate.topic);
    if (group === undefined) {
      topics.push(candidate.topic);
      byTopic.set(candidate.topic, [candidate]);
    } else group.push(candidate);
  }
  const ordered = topics.flatMap((topic) => byTopic.get(topic)!);
  const texts = ordered.map(lineText);
  const prefixes = ordered.map(
    (candidate, i) => `${linePrefix(candidate)}${texts[i] === null ? "" : ": "}`,
  );
  const headings = topics.map((topic) => topicHeading(byTopic.get(topic)![0]!));
  const lineCount = headings.length + ordered.length + (tail === "" ? 0 : 1);
  const fixed =
    headings.reduce((n, h) => n + h.length, 0) +
    prefixes.reduce((n, p) => n + p.length, 0) +
    tail.length +
    (lineCount - 1);
  // A line asks for at most the clip; `clip` cuts the whole text, so a
  // text one character over the clip still ends in an ellipsis.
  const lengths = texts.map((t) => (t === null ? 0 : Math.min(t.length, NEIGHBOUR_TEXT_CLIP)));
  const shares = shareTexts(lengths, NEIGHBOUR_CHARS_MAX - fixed);
  if (shares === null) return null;
  const lines: string[] = [];
  let k = 0;
  for (const [g, topic] of topics.entries()) {
    lines.push(headings[g]!);
    for (const _ of byTopic.get(topic)!) {
      const text = texts[k];
      lines.push(
        `${prefixes[k]!}${text === null || text === undefined ? "" : clip(text, shares[k]!)}`,
      );
      k += 1;
    }
  }
  if (tail !== "") lines.push(tail);
  const body = lines.join("\n");
  return body.length <= NEIGHBOUR_CHARS_MAX ? body : null;
}

export interface NeighbourBlock {
  /** The rendered lines joined by newlines, before the fence. */
  readonly body: string;
  /** How many gated candidates the line and character caps cut. */
  readonly cutCount: number;
  /** Every gated candidate, in render order. */
  readonly gated: ReadonlyArray<NeighbourCandidate>;
}

/**
 * Render the gated candidates (task 4.3 item 7): the newest at most
 * {@link NEIGHBOUR_LINES_MAX} as update lines, grouped under one heading
 * per topic that names the call opening it, and {@link NEIGHBOUR_CHARS_MAX}
 * characters for the whole body, the cut line included. What the cap
 * leaves after the headings, the lines' fixed parts and the cut line is
 * shared among the lines' texts (each at most {@link NEIGHBOUR_TEXT_CLIP},
 * an ellipsis marking a cut); a line is given up, newest kept, only when
 * a share would fall below {@link NEIGHBOUR_TEXT_FLOOR}. Candidates the
 * caps cut, and the `capped` ones the candidate cap removed before the
 * gate, end the block with the cut line (the caller supplies it, naming
 * the old watermark).
 */
export function renderNeighbourBlock(
  candidates: ReadonlyArray<NeighbourCandidate>,
  gate: (candidate: NeighbourCandidate) => boolean,
  cutLine: (dropped: number) => string,
  capped = 0,
): NeighbourBlock {
  const gated = candidates.filter(gate);
  for (let n = Math.min(NEIGHBOUR_LINES_MAX, gated.length); n >= 1; n--) {
    const cut = capped + gated.length - n;
    const body = layoutBlock(gated.slice(0, n), cut > 0 ? cutLine(cut) : "");
    if (body !== null) return { body, cutCount: cut, gated };
  }
  // No line shown: when updates were cut (by the caps or by the candidate
  // cap before the gate), the cut line alone names them, since the
  // watermark moves past them; with nothing cut there is nothing to say.
  const cut = capped + gated.length;
  const tail = cut > 0 ? cutLine(cut) : "";
  return { body: tail.length <= NEIGHBOUR_CHARS_MAX ? tail : "", cutCount: cut, gated };
}
