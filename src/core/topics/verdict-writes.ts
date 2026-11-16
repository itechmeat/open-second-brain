/**
 * The store records the dream-time uses write in `enforce`, applied
 * under the planning lock (`planUnderLock`), behind the same fence as
 * every other write of the pass (design D10, D20):
 *
 *  - `event_kind` derives one item record per held record - the item id
 *    equal to the record id, which makes a second pass write nothing -
 *    with `authority: "model"`, the `verdict` and the `source` (the
 *    record the item came from);
 *  - `question_resolved` writes a `question-resolved` proposal
 *    (`authority: "model"`), which the fold shows as "looks answered";
 *  - `milestone_done` writes a `milestone-done` proposal, never with
 *    `evidence`, which the fold shows as "looks done, confirm" and
 *    which leaves the milestone open.
 *
 * A verdict whose subject no longer matches the fold read under the
 * lock is ignored, the deterministic result standing; a history note
 * that already has a stored verdict gets no second one. Every record
 * lands in `private` when its subject record, its topic or the item it
 * proposes for is private (a completion or resolution counts for the
 * item's privacy, as the fold reads it); on a machine without `private`
 * it is skipped and counted, as `planUnderLock` already does for its
 * other writes. A proposal for an item a merged topic shows is written
 * under the item's owner, where the fold looks for it.
 *
 * The counts grow as each record lands, so a write that fails part way
 * leaves the report with what landed before it.
 */

import { TOPIC_DECISION_KIND, TOPIC_LOG_KIND, TOPIC_QUESTION_KIND } from "./constants.ts";
import type { TopicCandidate } from "./candidates.ts";
import type { TopicFold } from "./fold.ts";
import type { TopicPlan } from "./plan.ts";
import { TOPIC_TEXT_MAX } from "./records.ts";
import type { TopicVerdicts } from "./verdicts.ts";
import type { StoreRecord } from "../store/envelope.ts";

/** The `append` closure of `planUnderLock`, with its stream argument. */
export type PlanAppend = (
  isPrivate: boolean,
  kind: string,
  topic: string | null,
  body: Record<string, unknown>,
  scope?: string | null,
  stream?: import("../store/constants.ts").StoreStream,
) => string | null;

/** How many records of each use family the pass wrote, counted as each lands. */
export interface VerdictWriteCounts {
  /** Item records derived from `event_kind` verdicts. */
  derived: number;
  /** `question-resolved` proposals from `question_resolved` verdicts. */
  resolutions: number;
  /** `milestone-done` proposals from `milestone_done` verdicts. */
  completions: number;
  /** `history-verdict` records from `human_readable` verdicts that hide a note. */
  hidden: number;
  /** `history-verdict` records from `human_readable` verdicts that keep a note. */
  kept: number;
}

/** The notes a stored `history-verdict` of `shared` already judges (kept or hidden). */
export function judgedHistoryNotes(shared: ReadonlyArray<StoreRecord>): Set<string> {
  const judged = new Set<string>();
  for (const record of shared) {
    if (record.kind === "history-verdict" && typeof record.body["record"] === "string") {
      judged.add(record.body["record"]);
    }
  }
  return judged;
}

/** The `event_kind` option key to the record kind (and log class) it writes. */
const KIND_OF_OPTION: Record<string, { kind: string; logClass?: string }> = {
  decision: { kind: TOPIC_DECISION_KIND },
  open_question: { kind: TOPIC_QUESTION_KIND },
  correction: { kind: TOPIC_LOG_KIND, logClass: "correction" },
  blocker: { kind: TOPIC_LOG_KIND, logClass: "blocker" },
  reframing: { kind: TOPIC_LOG_KIND, logClass: "reframing" },
  rejected: { kind: TOPIC_LOG_KIND, logClass: "rejected" },
};

/**
 * The canonical topic that holds `candidate`, or the plan's route this
 * pass, as the decide pass read it (`holderOf`, then the routes): a
 * record taken out of its topic (an explicit none) may be routed again.
 */
function holdingTopic(fold: TopicFold, plan: TopicPlan, candidate: TopicCandidate): string | null {
  const assigned = fold.assignments.get(candidate.id);
  const held =
    assigned !== undefined
      ? assigned
      : candidate.topic === null
        ? null
        : (fold.canonical(candidate.topic) ?? null);
  if (held !== null) return held;
  return plan.routes.find((route) => route.record === candidate.id)?.topic ?? null;
}

/**
 * Write the records the verdicts decide, with the checks above, adding
 * each record that lands to `counts`.
 */
export function writeVerdictRecords(input: {
  readonly append: PlanAppend;
  readonly fold: TopicFold;
  readonly plan: TopicPlan;
  readonly candidatesById: ReadonlyMap<string, TopicCandidate>;
  readonly verdicts: TopicVerdicts | undefined;
  readonly counts: VerdictWriteCounts;
  /** The notes a stored `history-verdict` already judges, read under the lock. */
  readonly judgedNotes: ReadonlySet<string>;
}): void {
  const { append, fold, plan, candidatesById, verdicts, counts } = input;
  if (verdicts === undefined) return;

  // `event_kind`: one derived item per held record, the item id equal to
  // the record id (a second pass finds the item and writes nothing).
  for (const [recordId, entry] of verdicts.kinds) {
    const mapped = KIND_OF_OPTION[entry.kind];
    if (mapped === undefined) continue;
    const candidate = candidatesById.get(recordId);
    if (candidate === undefined) continue;
    const topic = fold.topics.get(entry.topic);
    if (topic === undefined || topic.mergedInto !== null) continue;
    if (holdingTopic(fold, plan, candidate) !== entry.topic) continue;
    if (topic.items.some((item) => item.id === recordId)) continue;
    // The id still names the item a split moved to another topic.
    if (fold.movedAway(entry.topic, recordId)) continue;
    const body: Record<string, unknown> = {
      authority: "model",
      item: recordId,
      text: candidate.text.slice(0, TOPIC_TEXT_MAX),
      source: recordId,
      verdict: entry.verdict,
    };
    if (mapped.logClass !== undefined) body["class"] = mapped.logClass;
    const written = append(
      candidate.private || topic.private || entry.privateInput,
      mapped.kind,
      entry.topic,
      body,
    );
    if (written !== null) counts.derived += 1;
  }

  // `question_resolved`: one proposal per record, when the question is
  // still open and has no pending proposal. The fold read under the lock
  // does not see this batch's proposals: a question proposed here is
  // taken for the rest of the batch.
  const proposed = new Set<string>();
  for (const [recordId, entry] of verdicts.resolutions) {
    const candidate = candidatesById.get(recordId);
    if (candidate === undefined) continue;
    const topic = fold.topics.get(entry.topic);
    if (topic === undefined || topic.mergedInto !== null) continue;
    if (holdingTopic(fold, plan, candidate) !== entry.topic) continue;
    // By id and owner: a merged topic can show two questions with one id.
    const question = topic.items.find(
      (item) => item.id === entry.question && item.owner === entry.owner,
    );
    if (
      question === undefined ||
      question.kind !== "open-question" ||
      question.resolved !== undefined ||
      question.resolveProposed !== undefined ||
      proposed.has(`${question.owner}:${question.id}`)
    ) {
      continue;
    }
    const written = append(
      candidate.private || topic.private || question.private || entry.privateInput,
      "question-resolved",
      question.owner,
      {
        authority: "model",
        question: entry.question,
        source: recordId,
        verdict: entry.verdict,
      },
    );
    if (written !== null) {
      counts.resolutions += 1;
      proposed.add(`${question.owner}:${question.id}`);
    }
  }

  // `milestone_done`: one proposal per milestone, never with evidence.
  for (const entry of verdicts.completions) {
    const topic = fold.topics.get(entry.topic);
    if (topic === undefined || topic.mergedInto !== null) continue;
    const milestone = topic.items.find(
      (item) => item.id === entry.milestone && item.owner === entry.owner,
    );
    if (
      milestone === undefined ||
      milestone.kind !== "milestone" ||
      milestone.done !== undefined ||
      milestone.doneProposed !== undefined
    ) {
      continue;
    }
    const written = append(
      topic.private || milestone.private || entry.privateInput,
      "milestone-done",
      milestone.owner,
      { authority: "model", milestone: entry.milestone, verdict: entry.verdict },
    );
    if (written !== null) counts.completions += 1;
  }

  // `human_readable`: one `history-verdict` per judged note, on the
  // `log` stream of `shared` - never a topic record, never private: the
  // history pages render from `shared` only. A kept note is stored too
  // (`keep: true`), so it is settled and never asked about again. A note
  // the read under the lock shows already judged (another pass applied
  // first) is skipped: its verdict stands.
  for (const [noteId, verdict] of verdicts.hidden) {
    if (input.judgedNotes.has(noteId)) continue;
    const written = append(
      false,
      "history-verdict",
      null,
      { authority: "model", record: noteId, keep: false, verdict },
      null,
      "log",
    );
    if (written !== null) counts.hidden += 1;
  }
  for (const [noteId, verdict] of verdicts.kept) {
    if (input.judgedNotes.has(noteId)) continue;
    const written = append(
      false,
      "history-verdict",
      null,
      { authority: "model", record: noteId, keep: true, verdict },
      null,
      "log",
    );
    if (written !== null) counts.kept += 1;
  }
}
