/**
 * `brain_topic` and `osb://topic/{id}` (task 3.5): the contract of the
 * topic tool. A request is stored as a human topic record and an agent's
 * own entry as an agent one; reads answer at the caller's reach, so a
 * caller below local reach never sees a private topic, not in a list, a
 * show, a resource read, nor through the refusal of a write that names
 * it. The server runs a remote call inside the withheld scope; these
 * tests call the handler inside the same scope.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { runTopicAction } from "../../src/core/topics/actions.ts";
import { TOPIC_TOOLS } from "../../src/mcp/brain/topic-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { readResource } from "../../src/mcp/resources.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv;
let ctx: ServerContext;
beforeEach(() => {
  env = makeStoreEnv("o2b-brain-topic-", { legacyTree: false });
  ctx = { vault: env.vault, configPath: env.configPath, repoRoot: null, agentName: "claude" };
});
afterEach(() => env.cleanup());

const handler = TOPIC_TOOLS[0]!.handler;
type Answer = Record<string, unknown>;
const local = async (args: Answer): Promise<Answer> => (await handler(ctx, args)) as Answer;
const remote = async (args: Answer): Promise<Answer> =>
  (await withPrivateWithheld(true, () =>
    handler({ ...ctx, reach: TRANSPORT_REACH.remote }, args),
  )) as Answer;

const ids = (answer: Answer) => (answer["topics"] as Answer[]).map((t) => t["id"]);

async function refusal(call: Promise<unknown>): Promise<MCPError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof MCPError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

function topicRecords(partition: "shared" | "private") {
  return readPartition(join(env.storeRoot, partition))
    .filter((s) => s.stream === "topics")
    .flatMap((s) => s.records);
}

function completionKinds(partition: "shared" | "private"): string[] {
  return topicRecords(partition)
    .map((r) => r.kind)
    .filter((k) => k === "milestone-done" || k === "question-resolved");
}

function decisionTexts(partition: "shared" | "private"): unknown[] {
  return topicRecords(partition)
    .filter((r) => r.kind === "decision")
    .map((r) => r.body["text"]);
}

describe("brain_topic", () => {
  test("an agent's writes carry agent authority unless it names human, and show renders them", async () => {
    const made = await local({
      action: "create",
      title: "Brain store",
      scope: "project:o2b",
      goal: "Move data out",
    });
    const topic = made["topic"] as string;
    await local({
      action: "record",
      topic,
      kind: "log-entry",
      fields: { text: "Sync conflicts on pinned.md", class: "blocker" },
    });
    await local({ action: "status", topic, status: "waiting", authority: "human" });
    expect(topicRecords("shared").map((r) => [r.kind, r.body["authority"], r.agent])).toEqual([
      ["topic-create", "agent", "claude"],
      ["log-entry", "agent", "claude"],
      ["topic-status", "human", "claude"],
    ]);
    const shown = await local({ action: "show", topic });
    expect((shown["topic"] as Answer)["status"]).toBe("waiting");
    expect(shown["page"]).toContain("Status: Waiting");
    expect(shown["page"]).toContain(", blocker: Sync conflicts on pinned.md");
    expect(
      readResource({ vault: env.vault, reach: TRANSPORT_REACH.local }, `osb://topic/${topic}`).text,
    ).toBe(shown["page"] as string);
  });

  test("undo takes back the record it names", async () => {
    const topic = (await local({ action: "create", title: "Docs", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const added = await local({
      action: "record",
      topic,
      kind: "decision",
      fields: { text: "Write the guide" },
    });
    await local({ action: "undo", record: (added["records"] as string[])[0] });
    const shown = await local({ action: "show", topic });
    expect((shown["topic"] as Answer)["items"]).toEqual([]);
  });

  test("below local reach a private topic does not exist: not listed, not shown, not writable", async () => {
    const shared = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const personal = (await local({ action: "create", title: "Health", scope: "personal" }))[
      "topic"
    ] as string;
    expect(topicRecords("private").map((r) => r.topic)).toEqual([personal]);
    expect(ids(await local({ action: "list" })).toSorted()).toEqual([shared, personal].toSorted());
    expect(ids(await remote({ action: "list" }))).toEqual([shared]);

    const missing = "01KA0000000000000000000000";
    const absent = await refusal(remote({ action: "show", topic: missing }));
    const hidden = await refusal(remote({ action: "show", topic: personal }));
    expect(hidden.message).toBe(absent.message.replace(missing, personal));
    const write = await refusal(remote({ action: "rename", topic: personal, title: "Renamed" }));
    expect(write.message).toContain(`no topic with id ${personal}`);
    expect(topicRecords("private").map((r) => r.kind)).toEqual(["topic-create"]);

    // Both answer as a rule-topic slug with nothing recorded under it.
    const resource = (uri: string) => {
      let text: string;
      try {
        text = readResource({ vault: env.vault, reach: TRANSPORT_REACH.remote }, uri).text;
      } catch (err) {
        text = (err as Error).message;
      }
      return text.replaceAll(personal, "<id>").replaceAll(missing, "<id>");
    };
    expect(resource(`osb://topic/${personal}`)).toBe(resource(`osb://topic/${missing}`));
    expect(
      readResource({ vault: env.vault, reach: TRANSPORT_REACH.local }, `osb://topic/${personal}`)
        .text,
    ).toContain("# Health");
  });

  test("a merge on request resolves the merged topic to its target", async () => {
    const a = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const b = (await local({ action: "create", title: "Store again", scope: "project:o2b" }))[
      "topic"
    ] as string;
    await local({ action: "merge", topic: b, into: a });
    const shown = await local({ action: "show", topic: b });
    expect((shown["topic"] as Answer)["id"]).toBe(a);
    expect(shown["page"]).toContain("- Merged from: Store again");
  });

  test("a malformed event is refused with nothing written", async () => {
    const topic = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const err = await refusal(
      local({
        action: "record",
        topic,
        kind: "log-entry",
        fields: { text: "x", class: "chatter" },
      }),
    );
    expect(err.message).toContain("class must be one of");
    expect(topicRecords("shared")).toHaveLength(1);
  });
});

describe("brain_topic authority and item checks", () => {
  test("the user's goal stays when an agent later sets one, which shows as its open question", async () => {
    const topic = runTopicAction(
      { action: "create", title: "Store", scope: "project:o2b", goal: "Ship phase 3" },
      { configPath: env.configPath, humanRequest: true },
    )["topic"] as string;
    await local({ action: "goal", topic, goal: "Ship everything at once" });
    const shown = await local({ action: "show", topic });
    expect((shown["topic"] as Answer)["goal"]).toBe("Ship phase 3");
    expect(shown["page"]).toContain("- Goal proposed by claude: Ship everything at once");
  });

  test("below local reach human authority is refused and nothing is written", async () => {
    const topic = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const err = await refusal(
      remote({ action: "status", topic, status: "done", authority: "human" }),
    );
    expect(err.message).toContain("human authority is refused below local reach");
    expect(topicRecords("shared")).toHaveLength(1);
  });

  test("a record names only an item of its own topic, of the right kind", async () => {
    const shared = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const personal = (await local({ action: "create", title: "Health", scope: "personal" }))[
      "topic"
    ] as string;
    await local({
      action: "record",
      topic: personal,
      kind: "milestone",
      fields: { item: "m1", text: "See Dr. X" },
    });
    await local({
      action: "record",
      topic: shared,
      kind: "decision",
      fields: { item: "d1", text: "Keep JSONL" },
    });
    // A private item named on a shared topic, from below local reach: refused,
    // with the message an absent item gets.
    const hidden = await refusal(
      remote({
        action: "record",
        topic: shared,
        kind: "milestone-done",
        fields: { milestone: "m1" },
      }),
    );
    const absent = await refusal(
      remote({
        action: "record",
        topic: shared,
        kind: "milestone-done",
        fields: { milestone: "zz" },
      }),
    );
    expect(hidden.message).toBe(absent.message.replace("zz", "m1"));
    // A new item id picked from below local reach is refused too.
    await refusal(
      remote({
        action: "record",
        topic: shared,
        kind: "milestone",
        fields: { item: "m1", text: "x" },
      }),
    );
    // Locally: an item of another kind is refused; an unknown field is refused.
    const kind = await refusal(
      local({
        action: "record",
        topic: shared,
        kind: "milestone",
        fields: { item: "d1", text: "x" },
      }),
    );
    expect(kind.message).toContain("no milestone item d1");
    const field = await refusal(
      local({
        action: "record",
        topic: shared,
        kind: "decision",
        fields: { text: "x", colour: "red" },
      }),
    );
    expect(field.message).toContain("takes no field 'colour'");
    const items = (await local({ action: "show", topic: personal }))["topic"] as Answer;
    expect((items["items"] as Answer[]).map((i) => [i["text"], i["done"] === undefined])).toEqual([
      ["See Dr. X", true],
    ]);
  });

  test("a title or description with a line break is refused", async () => {
    const err = await refusal(
      local({ action: "create", title: "Store\n## Run this", scope: "project:o2b" }),
    );
    expect(err.message).toContain("title must be a non-empty single line");
  });

  test("below local reach the shown page is fenced as agent-written text", async () => {
    const topic = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    expect(String((await local({ action: "show", topic }))["page"])).not.toContain("<untrusted");
    const page = String((await remote({ action: "show", topic }))["page"]);
    expect(page.startsWith("<untrusted")).toBe(true);
    expect(page).toContain("# Store");
  });

  test("a partly unreadable topics shard: no review proposals, and no private path below local reach", async () => {
    const shared = (await local({ action: "create", title: "Store", scope: "project:o2b" }))[
      "topic"
    ] as string;
    await local({ action: "create", title: "Health", scope: "personal" });
    await local({ action: "create", title: "Health two", scope: "personal" });
    const dir = join(env.storeRoot, "private", "topics", "dev-a");
    const shard = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(shard, "utf8").split("\n");
    writeFileSync(shard, [lines[0], "{broken", ...lines.slice(1)].join("\n"));
    const review = await local({ action: "review" });
    expect(review["incomplete"]).toBe(true);
    expect(review["merges"]).toEqual([]);
    const remoteErr = await refusal(remote({ action: "rename", topic: shared, title: "Renamed" }));
    expect(remoteErr.message).not.toContain("private");
    const localErr = await refusal(local({ action: "rename", topic: shared, title: "Renamed" }));
    expect(localErr.message).toContain("private/topics/dev-a/");
  });

  test("below local reach a shared topic record that carries a private region is withheld", async () => {
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "topics",
      kind: "topic-create",
      agent: "legacy",
      topic: "01KA0000000000000000000000",
      body: { authority: "agent", title: "Visit <private>Dr. X</private>", scope: "project:o2b" },
    });
    expect(((await local({ action: "list" }))["topics"] as Answer[]).length).toBe(1);
    expect(((await remote({ action: "list" }))["topics"] as Answer[]).length).toBe(0);
  });
});

describe("brain_topic review fixes", () => {
  test("below local reach every topic text of list and show is fenced", async () => {
    const topic = (
      await local({ action: "create", title: "Store", scope: "project:o2b", goal: "Ship" })
    )["topic"] as string;
    await local({ action: "record", topic, kind: "decision", fields: { text: "Keep JSONL" } });
    const head = ((await remote({ action: "list" }))["topics"] as Answer[])[0]!;
    expect(String(head["title"]).startsWith("<untrusted")).toBe(true);
    expect(String(head["goal"]).startsWith("<untrusted")).toBe(true);
    expect(String(head["scope"]).startsWith("<untrusted")).toBe(true);
    expect(String(head["scope"])).toContain("project:o2b");
    const detail = (await remote({ action: "show", topic }))["topic"] as Answer;
    expect(String(detail["scope"]).startsWith("<untrusted")).toBe(true);
    const item = (detail["items"] as Answer[])[0]!;
    expect(String(item["text"]).startsWith("<untrusted")).toBe(true);
    const plain = ((await local({ action: "list" }))["topics"] as Answer[])[0]!;
    expect(plain["title"]).toBe("Store");
    expect(plain["scope"]).toBe("project:o2b");
  });

  test("after a merge an item id two topics share is ambiguous until its owner is named", async () => {
    const a = (await local({ action: "create", title: "A", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const b = (await local({ action: "create", title: "B", scope: "project:o2b" }))[
      "topic"
    ] as string;
    await local({
      action: "record",
      topic: a,
      kind: "milestone",
      fields: { item: "m1", text: "A one" },
    });
    await local({
      action: "record",
      topic: b,
      kind: "milestone",
      fields: { item: "m1", text: "B one" },
    });
    await local({ action: "merge", topic: a, into: b });
    const err = await refusal(
      local({
        action: "record",
        topic: b,
        kind: "milestone-done",
        fields: { milestone: "m1" },
        authority: "human",
      }),
    );
    expect(err.message).toContain("on more than one merged topic");
    await local({
      action: "record",
      topic: b,
      kind: "milestone-done",
      fields: { milestone: "m1" },
      owner: a,
      authority: "human",
    });
    const items = ((await local({ action: "show", topic: b }))["topic"] as Answer)[
      "items"
    ] as Answer[];
    expect(items.map((i) => [i["text"], i["done"] !== undefined]).toSorted()).toEqual([
      ["A one", true],
      ["B one", false],
    ]);
  });

  test("a split from a topic moves an item of a topic merged into it; an unknown item is refused", async () => {
    const made = async (title: string) =>
      (await local({ action: "create", title, scope: "project:o2b" }))["topic"] as string;
    const a = await made("A");
    const b = await made("B");
    const c = await made("C");
    await local({
      action: "record",
      topic: a,
      kind: "decision",
      fields: { item: "d1", text: "From A" },
    });
    await local({ action: "merge", topic: a, into: b, authority: "human" });
    const answer = await local({ action: "split", topic: b, into: c, items: ["d1"] });
    expect(answer["topic"]).toBe(b);
    const texts = async (topic: string) =>
      (((await local({ action: "show", topic }))["topic"] as Answer)["items"] as Answer[]).map(
        (i) => i["text"],
      );
    expect(await texts(c)).toEqual(["From A"]);
    expect(await texts(b)).toEqual([]);
    const err = await refusal(local({ action: "split", topic: b, into: c, items: ["d9"] }));
    expect(err.message).toContain("no item d9");
  });

  test("editing a private item of a shared topic keeps the new text private", async () => {
    const topic = (await local({ action: "create", title: "Shared", scope: "project:o2b" }))[
      "topic"
    ] as string;
    await local({
      action: "record",
      topic,
      kind: "decision",
      fields: { item: "d1", text: "Private first" },
      private: true,
    });
    await local({
      action: "record",
      topic,
      kind: "decision",
      fields: { item: "d1", text: "Private reworded" },
    });
    expect(decisionTexts("shared")).toEqual([]);
    expect(decisionTexts("private")).toEqual(["Private first", "Private reworded"]);
  });

  test("a private or removed flag that is not a boolean is refused and nothing is written", async () => {
    const err = await refusal(
      local({ action: "create", title: "Clinic", scope: "project:o2b", private: "true" }),
    );
    expect(err.message).toContain("'private' must be a boolean");
    expect(topicRecords("shared")).toEqual([]);
    expect(topicRecords("private")).toEqual([]);
    const made = async (title: string) =>
      (await local({ action: "create", title, scope: "project:o2b" }))["topic"] as string;
    const a = await made("A");
    const b = await made("B");
    const linked = await refusal(local({ action: "link", topic: a, to: b, removed: "true" }));
    expect(linked.message).toContain("'removed' must be a boolean");
    expect(topicRecords("shared").map((r) => r.kind)).toEqual(["topic-create", "topic-create"]);
  });

  test("a split of a merged topic's item together with a record of the named topic is written", async () => {
    const made = async (title: string) =>
      (await local({ action: "create", title, scope: "project:o2b" }))["topic"] as string;
    const a = await made("A");
    const b = await made("B");
    const c = await made("C");
    await local({
      action: "record",
      topic: a,
      kind: "decision",
      fields: { item: "d1", text: "From A" },
    });
    await local({ action: "merge", topic: a, into: b });
    const record = "01KA0000000000000000000009";
    await local({ action: "split", topic: b, into: c, items: ["d1"], records: [record] });
    const shown = ((await local({ action: "show", topic: c }))["topic"] as Answer)[
      "items"
    ] as Answer[];
    expect(shown.map((i) => i["text"])).toEqual(["From A"]);
    const splits = topicRecords("shared").filter((r) => r.kind === "split");
    expect(
      splits.map((r) => [r.topic, r.body["items"] ?? null, r.body["records"] ?? null]),
    ).toEqual([
      [b, null, [record]],
      [a, ["d1"], null],
    ]);
  });

  test("after a private resolution or completion, a later one without the flag stays private", async () => {
    const topic = (await local({ action: "create", title: "Shared", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const record = (kind: string, fields: Answer, extra: Answer = {}) =>
      local({ action: "record", topic, kind, fields, authority: "human", ...extra });
    await record("open-question", { item: "q1", text: "Shared question" });
    await record("milestone", { item: "m1", text: "Shared step" });
    await record(
      "question-resolved",
      { question: "q1", answer: "Private answer" },
      { private: true },
    );
    await record(
      "milestone-done",
      { milestone: "m1", evidence: "Private proof" },
      { private: true },
    );
    await record("question-resolved", { question: "q1", answer: "Revised answer" });
    await record("milestone-done", { milestone: "m1", evidence: "Revised proof" });
    expect(completionKinds("shared")).toEqual([]);
    expect(completionKinds("private")).toEqual([
      "question-resolved",
      "milestone-done",
      "question-resolved",
      "milestone-done",
    ]);
  });

  test("a removed item's id can be recorded again on its topic", async () => {
    const topic = (await local({ action: "create", title: "Reuse", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const record = (fields: Answer) => local({ action: "record", topic, kind: "decision", fields });
    await record({ item: "d1", text: "First take" });
    await record({ item: "d1", removed: true });
    await record({ item: "d1", text: "Second take" });
    const items = ((await local({ action: "show", topic }))["topic"] as Answer)[
      "items"
    ] as Answer[];
    expect(items.map((i) => [i["id"], i["text"]])).toEqual([["d1", "Second take"]]);
  });

  test("completing or resolving an item that has a private record writes to private", async () => {
    const topic = (await local({ action: "create", title: "Shared", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const record = (kind: string, fields: Answer, extra: Answer = {}) =>
      local({ action: "record", topic, kind, fields, ...extra });
    await record("milestone", { item: "m1", text: "Private step" }, { private: true });
    await record("open-question", { item: "q1", text: "Private question" }, { private: true });
    await record("milestone-done", { milestone: "m1" }, { authority: "human" });
    await record("question-resolved", { question: "q1", answer: "Yes" }, { authority: "human" });
    expect(completionKinds("shared")).toEqual([]);
    expect(completionKinds("private")).toEqual(["milestone-done", "question-resolved"]);
  });

  test("an item id a split moved away is not taken again for a new item of the old topic", async () => {
    const made = async (title: string) =>
      (await local({ action: "create", title, scope: "project:o2b" }))["topic"] as string;
    const a = await made("A");
    const b = await made("B");
    await local({
      action: "record",
      topic: a,
      kind: "milestone",
      fields: { item: "m1", text: "Moved one" },
    });
    await local({ action: "split", topic: a, into: b, items: ["m1"] });
    const err = await refusal(
      local({
        action: "record",
        topic: a,
        kind: "milestone",
        fields: { item: "m1", text: "New one" },
      }),
    );
    expect(err.message).toContain("moved to another topic");
    const items = ((await local({ action: "show", topic: b }))["topic"] as Answer)[
      "items"
    ] as Answer[];
    expect(items.map((i) => i["text"])).toEqual(["Moved one"]);
  });

  test("undoing the undo of a private topic's create stays in the private partition", async () => {
    const made = await local({ action: "create", title: "Health", scope: "personal" });
    const undo = await local({ action: "undo", record: (made["records"] as string[])[0] });
    await local({ action: "undo", record: (undo["records"] as string[])[0] });
    expect(topicRecords("shared")).toEqual([]);
    expect(topicRecords("private").map((r) => r.kind)).toEqual(["topic-create", "undo", "undo"]);
    expect(ids(await local({ action: "list" }))).toEqual([made["topic"]]);
  });

  test("an owner that holds no such item, or is not this topic or one merged into it, is refused", async () => {
    const a = (await local({ action: "create", title: "A", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const b = (await local({ action: "create", title: "B", scope: "project:o2b" }))[
      "topic"
    ] as string;
    const c = (await local({ action: "create", title: "C", scope: "project:o2b" }))[
      "topic"
    ] as string;
    await local({
      action: "record",
      topic: a,
      kind: "decision",
      fields: { item: "shared1", text: "From A" },
    });
    await local({
      action: "record",
      topic: b,
      kind: "decision",
      fields: { item: "shared1", text: "From B" },
    });
    await local({ action: "merge", topic: b, into: a });
    const before = topicRecords("shared").length;
    const typo = await refusal(
      local({
        action: "record",
        topic: a,
        kind: "decision",
        owner: "01KA0000000000000000000000",
        fields: { item: "shared1", text: "edited" },
      }),
    );
    expect(typo.message).toContain("is not this topic or a topic merged into it");
    const unrelated = await refusal(
      local({
        action: "record",
        topic: a,
        kind: "decision",
        owner: c,
        fields: { item: "shared1", text: "edited" },
      }),
    );
    expect(unrelated.message).toBe(typo.message.replace("01KA0000000000000000000000", c));
    const missing = await refusal(
      local({
        action: "record",
        topic: a,
        kind: "decision",
        owner: b,
        fields: { item: "other", text: "edited" },
      }),
    );
    expect(missing.message).toContain(`no decision item other on topic ${a}`);
    const noItem = await refusal(
      local({ action: "record", topic: a, kind: "decision", owner: c, fields: { text: "new" } }),
    );
    expect(noItem.message).toBe(unrelated.message);
    expect(topicRecords("shared")).toHaveLength(before);
    const items = ((await local({ action: "show", topic: a }))["topic"] as Answer)[
      "items"
    ] as Answer[];
    expect(items.map((i) => i["text"]).toSorted()).toEqual(["From A", "From B"]);
  });

  test("undoing the undo of a topic's create brings the topic back", async () => {
    const made = await local({ action: "create", title: "Store", scope: "project:o2b" });
    const topic = made["topic"] as string;
    const undo = await local({ action: "undo", record: (made["records"] as string[])[0] });
    expect(((await local({ action: "list" }))["topics"] as Answer[]).length).toBe(0);
    await local({ action: "undo", record: (undo["records"] as string[])[0] });
    expect(((await local({ action: "list" }))["topics"] as Answer[]).map((t) => t["id"])).toEqual([
      topic,
    ]);
  });
});
