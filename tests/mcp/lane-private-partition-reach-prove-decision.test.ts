/**
 * A create the caller addresses below local reach (prove-decision): a
 * `brain_decision open` that a private open decision meets, under the same
 * question or on the id the ladder would take first for another question
 * (claim 9).
 *
 * Each test seeds the private open decision through the local server (its
 * context carries a private region), records every lane record of the
 * store, makes the remote call, and compares. The same call through a
 * local server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TITLE = "Zqprove park";
const RENAMED = "Zqprove other park";
const QUESTION = "Which zqprove vendor do we take?";
const OTHER_QUESTION = "Which zqprove vendor do we drop?";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(prefix: string): LaneEnv {
  const lane = makeLaneEnv("store", `osb-lane-prove-decision-${prefix}-`);
  lanes.push(lane);
  return lane;
}

/** Every lane record of both partitions, serialized and sorted: the store's lane bytes. */
function records(e: LaneEnv): string[] {
  return (["shared", "private"] as const)
    .flatMap((partition) =>
      e.laneRecords(partition).map((r) => `${partition} ${JSON.stringify(r)}`),
    )
    .toSorted();
}

/** The open-decision pages `partition` holds whose name starts with `open-`, from the fold of every partition. */
function openIds(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.entry.startsWith("open-") && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

function openArgs(title: string, question: string): Record<string, unknown> {
  return { action: "open", title, question, options: ["nightingale", "lark"] };
}

/** A private open decision for `question`, through the local server; its id. */
async function seedPrivate(e: LaneEnv, title: string, question: string): Promise<string> {
  const local = await callJson(localServer(e), "brain_decision", {
    ...openArgs(title, question),
    context: `zqprove context ${REGION}`,
  });
  expect(local["error"]).toBeUndefined();
  const id = String(local["id"]);
  expect(openIds(e, "private")).toEqual([id]);
  expect(openIds(e, "shared")).toEqual([]);
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${id}.md`))).toBe(true);
  return id;
}

describe("an open decision that meets a private open decision", () => {
  test("a remote open that meets a private open decision for the same question writes nothing", async () => {
    const e = env("same");
    const id = await seedPrivate(e, TITLE, QUESTION);
    const before = records(e);

    const remote = await callJson(server(e), "brain_decision", openArgs(RENAMED, QUESTION));

    expect({
      answer: remote,
      shared: openIds(e, "shared"),
      private: openIds(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${id}.md`)),
    }).toEqual({
      answer: { error: `brain_decision: ${WITHHELD}` },
      shared: [],
      private: [id],
      private_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote open whose first id a private open decision of another question holds takes the next id", async () => {
    const e = env("id");
    const held = await seedPrivate(e, TITLE, QUESTION);
    expect(held).toBe(`open-${titleSlug(TITLE)}`);
    const before = records(e);

    const remote = await callJson(server(e), "brain_decision", openArgs(TITLE, OTHER_QUESTION));

    expect(remote["error"] ?? null).toBeNull();
    expect({
      id: remote["id"],
      shared: openIds(e, "shared"),
      private: openIds(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${held}.md`)),
    }).toEqual({
      id: `${held}-2`,
      shared: [`${held}-2`],
      private: [held],
      private_kept: true,
    });
    expect(records(e).filter((r) => r.startsWith("private "))).toEqual(
      before.filter((r) => r.startsWith("private ")),
    );
  });

  test("a local open of the same question is refused as a duplicate", async () => {
    const e = env("local");
    const id = await seedPrivate(e, TITLE, QUESTION);
    const before = records(e);
    const local = await callJson(
      localServer(e),
      "brain_decision",
      openArgs(RENAMED, QUESTION.toUpperCase()),
    );
    const error = String(local["error"] ?? "");
    expect({
      duplicate: /duplicate|already|open/iu.test(error),
      names_existing: JSON.stringify(local).includes(id),
      same: records(e).length === before.length,
    }).toEqual({ duplicate: true, names_existing: true, same: true });
  });
});
