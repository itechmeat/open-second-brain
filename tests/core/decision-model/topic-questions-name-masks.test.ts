/**
 * Every question of the topic and agent-context uses names its own
 * masked field, as the existing uses do (`passages.P<k>`, `pairs.A<i>`):
 * a batched request whose questions read alike gives the model no stated
 * link between `kind_4` and `records.R4`.
 */

import { describe, expect, test } from "bun:test";

import {
  EVENT_KIND_QUESTIONS,
  HEAD_SELECT_QUESTIONS,
  HUMAN_READABLE_QUESTIONS,
  MILESTONE_DONE_QUESTIONS,
  NEIGHBOUR_RELEVANT_QUESTIONS,
  QUESTION_RESOLVED_QUESTIONS,
  TOPIC_ROUTE_QUESTIONS,
  TOPIC_SAME_QUESTIONS,
  TOPIC_USE_QUESTION_VERSION,
} from "../../../src/core/decision-model/questions-topics.ts";

const BATCHED: ReadonlyArray<[string, (k: number) => { instructions: unknown }, string]> = [
  ["topic_route", (k) => TOPIC_ROUTE_QUESTIONS.route(k, ["T0", "T1"]), "records.R"],
  ["event_kind", (k) => EVENT_KIND_QUESTIONS.kind(k), "records.R"],
  ["human_readable", (k) => HUMAN_READABLE_QUESTIONS.history(k), "records.R"],
  ["head_select", (k) => HEAD_SELECT_QUESTIONS.relevant(k), "topics.T"],
  ["neighbour_relevant", (k) => NEIGHBOUR_RELEVANT_QUESTIONS.matters(k), "records.R"],
  ["question_resolved", (k) => QUESTION_RESOLVED_QUESTIONS.answers(k, ["Q0"]), "records.R"],
  ["milestone_done", (k) => MILESTONE_DONE_QUESTIONS.done(k), "milestones.M"],
];

describe("topic and agent-context questions name their masked field", () => {
  for (const [use, build, field] of BATCHED) {
    test(`${use}: question k names \`${field}<k>\` and no two questions read alike`, () => {
      const texts = [0, 1, 2, 9].map((k) => String(build(k).instructions));
      [0, 1, 2, 9].forEach((k, i) => expect(texts[i]).toContain(`\`${field}${k}\``));
      expect(new Set(texts).size).toBe(texts.length);
    });
  }

  test("topic_same: pair i names `pairs.A<i>` and `pairs.B<i>`, not the placeholder", () => {
    const text = String(TOPIC_SAME_QUESTIONS.question(3).instructions);
    expect(text).toContain("`pairs.A3`");
    expect(text).toContain("`pairs.B3`");
    expect(text).not.toContain("<i>");
  });

  test("the changed uses carry question version 2", () => {
    for (const use of [
      "topic_route",
      "event_kind",
      "human_readable",
      "topic_same",
      "question_resolved",
      "milestone_done",
      "head_select",
      "neighbour_relevant",
    ] as const) {
      expect(TOPIC_USE_QUESTION_VERSION[use]).toBe(2);
    }
    expect(TOPIC_USE_QUESTION_VERSION.topic_new).toBe(1);
  });
});
