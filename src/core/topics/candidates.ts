/**
 * The records topic planning groups into topics (design D9; task 3.4):
 * captured signals and the log events a person would read (notes and
 * decisions), each with its text, its project, its session and whether
 * it is private.
 *
 *  - **Project.** The `project` the record names (a signal's frontmatter,
 *    a log event's body), normalised as every scope key is
 *    (`scope-key.ts`); `null` when it names none.
 *  - **Session.** The `session` the record names, else its `session_ref`,
 *    else the device, agent and UTC day that wrote it: records of one
 *    agent on one machine on one day count as one session, so a single
 *    busy session never makes a topic on its own (spec "One busy session
 *    does not make a topic").
 *
 * A signal a `signal-removed` record forgot is left out. Pure.
 */

import { scopeFromFrontmatter } from "../scope-key.ts";
import { LOG_EVENT_KIND, SIGNAL_KIND } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { SIGNAL_REMOVED_KIND } from "../store/fold-signals.ts";
import { parseHlc } from "../store/hlc.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";

/** Log event types whose text a person would read on a topic. */
const READABLE_EVENTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  note: ["text"],
  "decision-record": ["chosen", "decision"],
  "decision-resolved": ["choice"],
});

export interface TopicCandidate {
  readonly id: string;
  readonly text: string;
  /** The project the record names, or `null`. */
  readonly project: string | null;
  readonly session: string;
  /** Physical clock of the record, in ms. */
  readonly at: number;
  readonly private: boolean;
  /** The envelope `topic` the record was written under, or `null`. */
  readonly topic: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fallbackSession(record: StoreRecord, at: number): string {
  return `${record.device}/${record.agent}/${new Date(at).toISOString().slice(0, 10)}`;
}

function candidateOf(record: StoreRecord, isPrivate: boolean): TopicCandidate | null {
  const at = parseHlc(record.hlc)!.physical;
  let text: string | null = null;
  let meta: Record<string, unknown> = {};
  if (record.kind === SIGNAL_KIND) {
    meta = obj(record.body["frontmatter"]);
    text = str(meta["principle"]) ?? str(record.body["raw"]);
  } else if (record.kind === LOG_EVENT_KIND) {
    const type = String(record.body["event_type"]);
    // Own keys only: `constructor` or `toString` must not resolve to Object's.
    if (!Object.hasOwn(READABLE_EVENTS, type)) return null;
    const fields = READABLE_EVENTS[type]!;
    meta = obj(record.body["body"]);
    text = fields.map((f) => str(meta[f])).find((t) => t !== null) ?? null;
  }
  if (text === null) return null;
  const scope = scopeFromFrontmatter(meta);
  return {
    id: record.id,
    text,
    project: scope.project,
    session: scope.session ?? str(meta["session_ref"]) ?? fallbackSession(record, at),
    at,
    private: isPrivate,
    topic: record.topic,
  };
}

/** The candidates among `records`; `privateIds` names those of the `private` partition. */
export function topicCandidates(
  records: ReadonlyArray<StoreRecord>,
  privateIds: ReadonlySet<string>,
): TopicCandidate[] {
  const removed = new Set(
    records.filter((r) => r.kind === SIGNAL_REMOVED_KIND).map((r) => String(r.body["signal"])),
  );
  const out: TopicCandidate[] = [];
  for (const record of records) {
    if (record.kind === SIGNAL_KIND && removed.has(String(record.body["id"]))) continue;
    // A shared record that carries a `<private>` region (a legacy or
    // foreign writer) counts as private: its text must not seed a shared topic.
    const isPrivate = privateIds.has(record.id) || valueCarriesPrivateRegion(record.body);
    const candidate = candidateOf(record, isPrivate);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}

/** Common words of no use for telling subjects apart. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "about after again also always because been before being both could does doing done each " +
    "even every from have having here into just like made make many more most much must never " +
    "only other over same should since some such than that their them then there these they " +
    "this those through under until very want were what when where which while will with " +
    "within without would your"
  ).split(" "),
);

/** The distinct words of `text` that can tell subjects apart, in any script. */
export function subjectTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 4 && !STOPWORDS.has(w)),
  );
}
