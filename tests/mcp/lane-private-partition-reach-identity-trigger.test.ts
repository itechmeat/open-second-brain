/**
 * A write decision taken from the narrowed view (identity-trigger): an
 * insight pass with `triggers=true` whose finding a private open trigger
 * for the same cooldown key already holds.
 *
 * The trigger store decides "this key already has a trigger" from the
 * caller's fold, which below local reach hides the `private` partition,
 * so a remote pass may enqueue a finding the queue already holds. Each
 * test seeds the private trigger through the trigger store's own writer
 * (dated another day, so the id a new record takes today is free),
 * records every lane record of the store, makes the remote call, and
 * compares. The same call through a local server on a twin store is the
 * control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const NOTE = "Brain/research/zqidentity-idea.md";
const KEY = `orphan_research:${NOTE}`;

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-trigger-");
  lanes.push(lane);
  writeLaneText(
    lane.vault,
    join(lane.vault, NOTE),
    "---\ntitle: Zqidentity idea\ncreated_at: 2026-11-01T00:00:00Z\n---\n\nzqidentity research body\n",
  );
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

/** The live triggers in `partition` by id, from the fold of every partition. */
function triggerIds(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([, value]) =>
        value.lane === "triggers" &&
        fold.privateKeys.has(`${value.lane}/${value.entry}`) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

/** A private open trigger for `KEY`, dated another day. */
function seedOpen(e: LaneEnv): string {
  const { created } = createTriggers(
    e.vault,
    [
      {
        kind: "contradiction",
        urgency: "medium",
        reason: "zqidentity held finding",
        suggestedAction: "review it",
        sourceArtifacts: [NOTE],
        contextSnippets: [REGION],
        cooldownKey: KEY,
      },
    ],
    { now: NOW },
  );
  const id = created[0]!.id;
  expect(laneEntryInPrivate(e.vault, created[0]!.path)).toBe(true);
  expect(id).not.toBe(
    `tr-${createHash("sha256").update(KEY).digest("hex").slice(0, 10)}-${new Date().toISOString().slice(0, 10)}`,
  );
  return id;
}

describe("an insight pass that meets a private open trigger for its key", () => {
  test("a remote idea discovery with triggers that meets a private open trigger for its key queues nothing in shared", async () => {
    const e = env();
    const id = seedOpen(e);
    const ideas = await callJson(localServer(e), "brain_idea_discovery", { cap: 50 });
    expect(
      (ideas["ideas"] as ReadonlyArray<Record<string, unknown>>).some(
        (idea) =>
          idea["kind"] === "orphan_research" &&
          JSON.stringify(idea["source_artifacts"]).includes(NOTE),
      ),
    ).toBe(true);
    const before = records(e);
    const remote = await callJson(server(e), "brain_idea_discovery", { cap: 50, triggers: true });
    // Trigger creation is the machine's own maintenance: it runs on the
    // fold of every partition, so the sighting is recorded on the private
    // twin exactly as a local call records it, and the answer counts none.
    const added = records(e).filter((r) => !before.includes(r));
    expect({
      created: remote["triggers_created"],
      shared: triggerIds(e, "shared"),
      private: triggerIds(e, "private"),
      added_in_private_for_twin: added.map(
        (r) => r.startsWith("private ") && r.includes(`"entry":"${id}"`),
      ),
      names_twin: JSON.stringify(remote).includes(id),
    }).toEqual({
      created: 0,
      shared: [],
      private: [id],
      added_in_private_for_twin: [true],
      names_twin: false,
    });
  });

  test("a local idea discovery with triggers leaves the private open trigger alone", async () => {
    const e = env();
    const id = seedOpen(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_idea_discovery", {
      cap: 50,
      triggers: true,
    });
    // The blocked sighting is recorded on the twin's recurrence ledger: the
    // private trigger is rewritten in place, and no trigger lands in shared.
    const after = records(e);
    const added = after.filter((r) => !before.includes(r));
    expect({
      created: local["triggers_created"],
      shared: triggerIds(e, "shared"),
      private: triggerIds(e, "private"),
      added_in_private_for_twin: added.map(
        (r) => r.startsWith("private ") && r.includes(`"entry":"${id}"`),
      ),
    }).toEqual({ created: 0, shared: [], private: [id], added_in_private_for_twin: [true] });
  });
});
