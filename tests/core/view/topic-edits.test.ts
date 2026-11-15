/**
 * How a changed line of a topic page maps to a human topic record (task
 * 3.2): the generated decorations (list marker, checkbox, done marker,
 * log date and class, "because" tail) are stripped in any view language,
 * and a line this mapping does not own falls back to the generic view
 * correction.
 */
import { describe, expect, test } from "bun:test";

import { topicAddition, topicCorrection } from "../../../src/core/view/topic-edits.ts";

const ID = "01KA0000000000000000000000";
const key = (rest: string) => `t:${ID}:${rest}`;

const bodies = (records: ReturnType<typeof topicCorrection>) =>
  records?.map((r) => [r.kind, r.topic, r.body]);

describe("topicCorrection", () => {
  test("a status line in either language becomes topic-status, a done day kept", () => {
    expect(
      bodies(
        topicCorrection(key("status"), "Status: Active", "Статус: Готова (решена 2026-11-10)"),
      ),
    ).toEqual([
      ["topic-status", ID, { authority: "human", status: "done", resolved: "2026-11-10" }],
    ]);
    expect(bodies(topicCorrection(key("status"), "Status: Active", "Status: on hold"))).toEqual([
      ["topic-status", ID, { authority: "human", status: "on-hold" }],
    ]);
    expect(topicCorrection(key("status"), "Status: Active", "Status: someday")).toBeNull();
  });

  test("a ticked milestone is marked done; its markers never reach the text", () => {
    expect(
      bodies(
        topicCorrection(
          key("m:m1"),
          "- [ ] Migration (looks done, confirm)",
          "- [x] Migration (looks done, confirm)",
        ),
      ),
    ).toEqual([["milestone-done", ID, { authority: "human", milestone: "m1" }]]);
    expect(
      bodies(
        topicCorrection(
          key("m:m1"),
          "- [x] Migration (done 2026-11-02)",
          "- [x] Data migration (done 2026-11-02)",
        ),
      ),
    ).toEqual([["milestone", ID, { authority: "human", item: "m1", text: "Data migration" }]]);
  });

  test("an unticked done milestone undoes the record that completed it", () => {
    const done = "01KA0000000000000000000002";
    expect(
      bodies(
        topicCorrection(
          key(`mx:${done}:m1`),
          "- [x] Migration (done 2026-11-02)",
          "- [ ] Migration",
        ),
      ),
    ).toEqual([["undo", ID, { authority: "human", record: done }]]);
  });

  test("a reworded log line keeps its class and splits off the reason", () => {
    expect(
      bodies(
        topicCorrection(
          key("l:rejected:i9"),
          "- 2026-11-02, rejected approach: One file per writer, because devices churn",
          "- 2026-11-02, rejected approach: One file per process, because process ids churn",
        ),
      ),
    ).toEqual([
      [
        "log-entry",
        ID,
        {
          authority: "human",
          item: "i9",
          text: "One file per process",
          class: "rejected",
          reason: "process ids churn",
        },
      ],
    ]);
  });

  test("a deleted item is its tombstone; a deleted goal proposal undoes the agent's record", () => {
    expect(bodies(topicCorrection(key("d:d1"), "- Keep JSONL", null))).toEqual([
      ["decision", ID, { authority: "human", item: "d1", removed: true }],
    ]);
    const proposal = "01KA0000000000000000000001";
    expect(
      bodies(topicCorrection(key(`gp:${proposal}`), "- Goal proposed by planner: Ship", null)),
    ).toEqual([["undo", ID, { authority: "human", record: proposal }]]);
  });

  test("lines the mapping does not own fall back to the generic correction", () => {
    expect(topicCorrection(key("scope"), "- Project: o2b", "- Project: other")).toBeNull();
    expect(topicCorrection("pref:pref-x", "- a", "- b")).toBeNull();
  });
});

const strip = (records: ReturnType<typeof topicAddition>) =>
  bodies(records)?.map(([kind, topic, body]) => {
    const { item: _item, ...rest } = body as Record<string, unknown>;
    return [kind, topic, rest];
  });

describe("topicAddition", () => {
  test("a line added in an item section is a new item of that section", () => {
    expect(strip(topicAddition(key("h:questions"), "- Who owns the view?"))).toEqual([
      ["open-question", ID, { authority: "human", text: "Who owns the view?" }],
    ]);
    expect(strip(topicAddition(key("l:blocker:i1"), "- Waiting for the owner"))).toEqual([
      ["log-entry", ID, { authority: "human", text: "Waiting for the owner", class: "note" }],
    ]);
    expect(topicAddition(key("goal"), "more goal text")).toBeNull();
  });

  test("the same line added twice (a page and its conflict copy) is one item", () => {
    const one = topicAddition(key("h:milestones"), "- [x] Ship it")!;
    const two = topicAddition(key("m:m9"), "- [x] Ship it")!;
    expect(one.map((r) => r.body["item"] ?? r.body["milestone"])).toEqual(
      two.map((r) => r.body["item"] ?? r.body["milestone"]),
    );
    expect(topicAddition(key("h:decisions"), "- Keep JSONL")![0]!.body["item"]).toBe(
      topicAddition(key("d:d1"), "- Keep JSONL")![0]!.body["item"],
    );
  });
});
