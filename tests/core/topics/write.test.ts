/**
 * The topic write path and read (task 3.1): topic events are appended to
 * the writer's own `topics` shard as one store operation, in one
 * partition. A personal topic is private by default and every later event
 * of a private topic stays there; a caller below local reach folds only
 * `shared`. A malformed event or a topic that does not exist is refused
 * with nothing written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { withPrivateWithheld } from "../../../src/core/store/caller-reach.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { StoreWriteError } from "../../../src/core/store/store-write.ts";
import { readTopics } from "../../../src/core/topics/read.ts";
import {
  createTopicEvent,
  TopicWriteError,
  writeTopicEvents,
} from "../../../src/core/topics/write.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function topicRecords(partition: "shared" | "private") {
  return readPartition(join(env!.storeRoot, partition))
    .filter((shard) => shard.stream === "topics")
    .flatMap((shard) => shard.records);
}

describe("writeTopicEvents", () => {
  test("a project topic lands in shared under its id; a personal one in private", () => {
    env = makeStoreEnv("o2b-topics-write-", { legacyTree: false });
    const project = createTopicEvent({ title: "Store", scope: "project:o2b", authority: "human" });
    const personal = createTopicEvent({
      title: "Move flat",
      scope: "personal",
      authority: "human",
    });
    writeTopicEvents([project], { configPath: env.configPath });
    writeTopicEvents([personal], { configPath: env.configPath });
    writeTopicEvents(
      [
        {
          kind: "decision",
          topic: personal.topic,
          authority: "agent",
          body: { text: "Rent first" },
        },
      ],
      { configPath: env.configPath, private: false },
    );
    const shared = topicRecords("shared");
    expect(shared.map((r) => [r.kind, r.topic, r.scope])).toEqual([
      ["topic-create", project.topic, "project:o2b"],
    ]);
    expect(topicRecords("private").map((r) => [r.kind, r.topic])).toEqual([
      ["topic-create", personal.topic],
      ["decision", personal.topic],
    ]);
    const local = readTopics(env.configPath).fold;
    expect([...local.topics.keys()].toSorted()).toEqual([project.topic, personal.topic].toSorted());
    expect(local.topics.get(personal.topic)!.private).toBe(true);
    const remote = withPrivateWithheld(true, () => readTopics(env!.configPath)).fold;
    expect([...remote.topics.keys()]).toEqual([project.topic]);
  });

  test("an event for a topic that does not exist, or with a malformed body, writes nothing", () => {
    env = makeStoreEnv("o2b-topics-write-", { legacyTree: false });
    const made = createTopicEvent({ title: "Store", scope: "project:o2b", authority: "human" });
    const stray = createTopicEvent({
      title: "Never written",
      scope: "project:o2b",
      authority: "agent",
    });
    expect(() =>
      writeTopicEvents(
        [made, { kind: "link", topic: made.topic, authority: "agent", body: { to: stray.topic } }],
        { configPath: env!.configPath },
      ),
    ).toThrow(TopicWriteError);
    expect(() =>
      writeTopicEvents(
        [
          made,
          {
            kind: "topic-status",
            topic: made.topic,
            authority: "agent",
            body: { status: "later" },
          },
        ],
        { configPath: env!.configPath },
      ),
    ).toThrow(/status must be one of/);
    expect(topicRecords("shared")).toEqual([]);
  });

  test("a personal topic on a machine without the private partition is refused", () => {
    env = makeStoreEnv("o2b-topics-write-", { legacyTree: false, partitions: ["shared"] });
    const personal = createTopicEvent({ title: "Health", scope: "personal", authority: "human" });
    let thrown: unknown;
    try {
      writeTopicEvents([personal], { configPath: env.configPath });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StoreWriteError);
    expect((thrown as StoreWriteError).reason).toBe("partition-unavailable");
    expect(topicRecords("shared")).toEqual([]);
  });
});
