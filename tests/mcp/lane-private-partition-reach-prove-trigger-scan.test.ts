/**
 * A write decision taken from the narrowed view (prove-trigger-scan): a
 * `brain_trigger scan` below local reach whose finding a private open
 * trigger for the same cooldown key already holds, dated another day
 * (claim 1).
 *
 * Each test seeds one stale preference (the finding the scan always
 * produces) and a private open trigger for its key, records every lane
 * record of the store, makes the remote call, and compares. The same
 * call through a local server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const SEEDED = new Date("2026-11-20T10:00:00Z");
const KEY = "stale_claim:pref-zqprove-old";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

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

/** A stale preference and a private open trigger for its key, dated `SEEDED`. */
function seed(e: LaneEnv): string {
  writePreference(
    e.vault,
    {
      slug: "zqprove-old",
      topic: "zqprove topic",
      principle: "Keep the zqprove preference stated once.",
      created_at: "2020-01-01T00:00:00Z",
      unconfirmed_until: "2020-01-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      confirmed_at: "2020-01-02T00:00:00Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2020-01-02T00:00:00Z",
    },
    { overwrite: true },
  );
  const { created } = createTriggers(
    e.vault,
    [
      {
        kind: "stale_claim",
        urgency: "medium",
        reason: "zqprove held finding",
        suggestedAction: "re-evidence it",
        sourceArtifacts: ["[[pref-zqprove-old]]"],
        contextSnippets: [REGION],
        cooldownKey: KEY,
      },
    ],
    { now: SEEDED },
  );
  expect(created).toHaveLength(1);
  expect(laneEntryInPrivate(e.vault, created[0]!.path)).toBe(true);
  expect(triggerIds(e, "private")).toEqual([created[0]!.id]);
  expect(triggerIds(e, "shared")).toEqual([]);
  return created[0]!.id;
}

const SCAN = { operation: "scan" };

describe("a scan that meets a private open trigger for its key", () => {
  test("a remote scan that meets a private trigger for its key adds nothing", async () => {
    const e = makeLaneEnv("store", "osb-lane-prove-trigger-scan-");
    lanes.push(e);
    const id = seed(e);
    const path = `Brain/triggers/${id}.md`;
    const before = records(e);

    const remote = await callJson(server(e), "brain_trigger", SCAN);

    const added = records(e).filter((r) => !before.includes(r));
    const privateRewrites = added.map(
      (r) => r.startsWith("private ") && r.includes(`"entry":"${id}"`),
    );
    expect(remote["error"] ?? null).toBeNull();
    expect(remote["candidates"]).toBe(1);
    expect({
      created: remote["created"],
      skipped: remote["skipped"],
      shared: triggerIds(e, "shared"),
      private: triggerIds(e, "private"),
      added: privateRewrites,
      names_private: JSON.stringify(remote).includes(id),
      private_still_held: laneEntryInPrivate(e.vault, join(e.vault, path)),
    }).toEqual({
      created: [],
      skipped: [],
      shared: [],
      private: [id],
      added: [true],
      names_private: false,
      private_still_held: true,
    });
  });

  test("a local scan records the sighting on the private trigger", async () => {
    const e = makeLaneEnv("store", "osb-lane-prove-trigger-scan-local-");
    lanes.push(e);
    const id = seed(e);
    const before = records(e);

    const local = await callJson(localServer(e), "brain_trigger", SCAN);

    const added = records(e).filter((r) => !before.includes(r));
    expect({
      created: local["created"],
      skipped: local["skipped"],
      shared: triggerIds(e, "shared"),
      private: triggerIds(e, "private"),
      added: added.map((r) => r.startsWith("private ") && r.includes(`"entry":"${id}"`)),
    }).toEqual({
      created: [],
      skipped: [{ cooldown_key: KEY, reason: "active" }],
      shared: [],
      private: [id],
      added: [true],
    });
  });
});
