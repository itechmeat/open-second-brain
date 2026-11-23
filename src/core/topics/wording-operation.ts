/**
 * The wording of a new topic (change `dream-launched-agent`, design D6):
 * the title and goal of a topic a qualifying group becomes, written only
 * by the launched agent. One item per qualifying group, produced with the
 * group's `topic-new` item and coming after it; topic planning applies the
 * answer (`appliedBy: "planning"`) when it creates the topic, and creates
 * no topic without it. The operation is registered beside the closed
 * questions (`decide-operations.ts`), which own the question state.
 */

import { dreamWorkItemBody, type ProduceSpec } from "../brain/dream-queue/queue.ts";
import { dreamWorkInputHash } from "../brain/dream-queue/records.ts";
import type { StorePartition } from "../store/constants.ts";
import type { PlanAskedGroup } from "./plan.ts";
import { TOPIC_TITLE_MAX } from "./records.ts";

export const TOPIC_WORDING_OPERATION = "topic-wording";
/** Longest goal a wording may carry, in characters. */
export const TOPIC_WORDING_GOAL_MAX = 1000;

const ANSWER_SCHEMA = Object.freeze({
  type: "object",
  description: "the topic's title (one line) and its goal (what the work aims at)",
  properties: {
    title: { type: "string", maxLength: TOPIC_TITLE_MAX },
    goal: { type: "string", maxLength: TOPIC_WORDING_GOAL_MAX },
  },
  required: ["title", "goal"],
});

const PROMPT =
  "These records form a new topic of work. Write the topic's title (one line, a few words) " +
  "and its goal (one or two sentences: what the work aims at). Answer with the value " +
  '{ "title": ..., "goal": ... }.';

/** Why `value` is not a wording, or `null`. */
export function wordingRejection(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the answer is an object with a title and a goal";
  }
  const v = value as Record<string, unknown>;
  const title = v["title"];
  const goal = v["goal"];
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/.test(title)) {
    return "the title is a non-empty single line";
  }
  if (title.length > TOPIC_TITLE_MAX)
    return `the title is longer than ${TOPIC_TITLE_MAX} characters`;
  if (typeof goal !== "string" || goal.trim() === "") return "the goal is not empty";
  if (goal.length > TOPIC_WORDING_GOAL_MAX) {
    return `the goal is longer than ${TOPIC_WORDING_GOAL_MAX} characters`;
  }
  return null;
}

/** What a wording item is made of, for one group. */
export interface WordingGroup {
  readonly group: PlanAskedGroup;
  readonly members: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly occurrence: string;
  /** The id of the group's `topic-new` item, when the group still asks it. */
  readonly after: string | null;
}

export const TOPIC_WORDING_PROMPT = PROMPT;

export function wordingInput(members: WordingGroup["members"]): Record<string, unknown> {
  return { members: members.map((m) => ({ id: m.id, text: m.text })) };
}

/** The produce spec of a group's wording item. */
export function wordingProduceSpec(entry: WordingGroup): ProduceSpec {
  const sources: StorePartition[] = entry.group.private ? ["private"] : ["shared"];
  const payload = { ...wordingInput(entry.members), prompt: PROMPT };
  return {
    operation: TOPIC_WORDING_OPERATION,
    subject: entry.group.key,
    occurrence: entry.occurrence,
    input: wordingInput(entry.members),
    prompt_version: "1",
    schema_version: "1",
    answer_schema: ANSWER_SCHEMA,
    after: entry.after === null ? [] : [entry.after],
    resources: entry.members.map((member) => `record:${member.id}`),
    evidence: entry.members.map((m) => m.id).slice(0, 200),
    payload,
    sources,
  };
}

/** The input hash of a group's wording item. */
export function wordingInputHash(members: WordingGroup["members"]): string {
  return dreamWorkInputHash(wordingInput(members));
}

/** The id an item for `spec` has. */
export function itemIdOf(spec: ProduceSpec): string {
  return dreamWorkItemBody(spec).id;
}
