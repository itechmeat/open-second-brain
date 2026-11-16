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
 * never be returned"): same device and same resolved agent name, the
 * rule `log-catchup` already applies (design D20 item 16).
 */

import { compareCodeUnits } from "../store/compare.ts";
import { stripPrivateRegions } from "../redactor.ts";
import { neutralizeSingleLine } from "../brain/untrusted-source.ts";
import { TOPIC_DECISION_LIMITS } from "../decision-model/questions-topics.ts";

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
 * The records the lane may surface: a neighbour's (never this device and
 * this agent), of the candidate kinds, on stream `topics`, newest first.
 * Uncapped: the caller filters by the session's topics and project first
 * and caps after ({@link capNeighbourCandidates}), so a record that
 * matters here is never pushed out by newer records of other projects.
 */
export function selectNeighbourCandidates(
  rows: ReadonlyArray<NeighbourRecordRow>,
  self: { readonly device: string; readonly agent: string },
): NeighbourRecordRow[] {
  return rows
    .filter(
      (row) =>
        !(row.device === self.device && row.agent === self.agent) &&
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

/** One rendered line (task 4.3 item 7). */
export function renderNeighbourLine(candidate: NeighbourCandidate): string {
  const text =
    candidate.text === null
      ? ""
      : `: ${neutralizeSingleLine(stripPrivateRegions(candidate.text)).slice(0, NEIGHBOUR_TEXT_CLIP)}`;
  return (
    `- ${neutralizeSingleLine(candidate.agent)} on ${neutralizeSingleLine(candidate.device)} ` +
    `recorded a ${candidate.modelDerived === true ? "model-derived " : ""}` +
    `${neutralizeSingleLine(candidate.kind)} on ` +
    `"${neutralizeSingleLine(stripPrivateRegions(candidate.topicTitle))}"${text}. ` +
    `Open it with \`brain_topic\` action \`show\` topic ${candidate.topic}.`
  );
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
 * Render the gated candidates (task 4.3 item 7): at most
 * {@link NEIGHBOUR_LINES_MAX} update lines and {@link NEIGHBOUR_CHARS_MAX}
 * characters for the whole body, the cut line included; candidates cut by the caps, and the `capped` ones the
 * candidate cap removed before the gate, end the block with the cut line
 * (the caller supplies it, naming the old watermark).
 */
export function renderNeighbourBlock(
  candidates: ReadonlyArray<NeighbourCandidate>,
  gate: (candidate: NeighbourCandidate) => boolean,
  cutLine: (dropped: number) => string,
  capped = 0,
): NeighbourBlock {
  const gated = candidates.filter(gate);
  const lines: string[] = [];
  let chars = 0;
  let cut = capped;
  for (const candidate of gated) {
    const line = renderNeighbourLine(candidate);
    if (lines.length >= NEIGHBOUR_LINES_MAX || chars + line.length + 1 > NEIGHBOUR_CHARS_MAX) {
      cut += 1;
      continue;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  // The character cap holds the whole body, the cut line included: lines
  // give way to it from the end, each one then counted in it.
  for (;;) {
    // No line shown: when updates were cut (by the caps or by the
    // candidate cap before the gate), the cut line alone names them,
    // since the watermark moves past them; with nothing cut there is
    // nothing to say.
    if (lines.length === 0) {
      const tail = cut > 0 ? cutLine(cut) : "";
      return { body: tail.length <= NEIGHBOUR_CHARS_MAX ? tail : "", cutCount: cut, gated };
    }
    const tail = cutLine(cut);
    const body = [...lines, ...(tail !== "" ? [tail] : [])].join("\n");
    if (body.length <= NEIGHBOUR_CHARS_MAX) return { body, cutCount: cut, gated };
    lines.pop();
    cut += 1;
  }
}
