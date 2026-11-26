/**
 * The same-topic lookup of a design note on a store-only machine (fifth
 * closure round, finding 3).
 *
 * A note an older release wrote for a topic on a day sits under the
 * Latin-only slug of the topic; a new note of the same topic and day goes
 * to that name, so the exclusive write refuses it. The lookup lists the
 * lane, not the disk folder (a store-only machine has no file there), so
 * below local reach a private note of the topic refuses the call with the
 * fixed answer, and at local reach the write is refused by name.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { commitDesignNote } from "../../src/core/brain/design-note.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const TOPIC = "Тема zqrelease";
const NOW = new Date("2026-11-20T10:00:00Z");

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function payload(): Record<string, unknown> {
  return {
    title: "Zqrelease plan",
    alternatives: [
      { name: "option-a", approach: "a", tradeoffs: "a", recommended: true },
      { name: "option-b", approach: "b", tradeoffs: "b", recommended: false },
    ],
  };
}

/** A private design note for `TOPIC` under the Latin-only slug an older release gave it. */
function seed(): { e: LaneEnv; held: string } {
  const e = makeLaneEnv("store", "osb-lane-round5-design-");
  lanes.push(e);
  const held = join(e.vault, "Brain", "decisions", "design-2026-11-20-zqrelease.md");
  writeLanePage(
    e.vault,
    held,
    {
      schema_version: 1,
      kind: "design-note",
      slug: "zqrelease",
      topic: TOPIC,
      title: "Held plan",
      recommended: "option-a",
      alternative_count: "2",
      agent: "tester",
      created_at: NOW.toISOString(),
    },
    `held body ${REGION}\n`,
    { overwrite: false, vaultForRelativePath: e.vault },
  );
  expect(laneEntryInPrivate(e.vault, held)).toBe(true);
  return { e, held };
}

function attempt(e: LaneEnv): unknown {
  try {
    commitDesignNote(e.vault, TOPIC, payload(), { agent: "tester", now: NOW });
    return null;
  } catch (err) {
    return err;
  }
}

describe("a design note whose topic a private note of the day holds under its old slug", () => {
  test("a remote commit gets the fixed refusal and writes nothing", () => {
    const { e } = seed();
    const before = JSON.stringify(e.laneRecords());
    const thrown = withPrivateWithheld(true, () => attempt(e));
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local commit is refused by the held note's name and writes nothing", () => {
    const { e } = seed();
    const before = JSON.stringify(e.laneRecords());
    const thrown = attempt(e);
    expect(String(thrown)).toContain("design-2026-11-20-zqrelease");
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });
});
