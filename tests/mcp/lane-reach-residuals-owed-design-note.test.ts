/**
 * The design-note fix at local reach (change `lane-reach-residuals`,
 * package 19; owed by 2.0.4, fifth closure round, finding 3).
 *
 * A note an older release wrote for a topic on a day sits under the
 * Latin-only slug of the topic; a new note of the same topic and day goes
 * to that name, so the exclusive write refuses it by name. The same-topic
 * lookup lists the lane, not the disk folder: on a store-only machine,
 * which has no file there, a local commit still finds the shared note and
 * is refused by its name instead of writing a second note of the topic,
 * as on an unswitched vault. A remote commit over the same shared note is
 * refused by name too. Every refused call compares the raw records of
 * both partitions before and after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { commitDesignNote } from "../../src/core/brain/design-note.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv, type LaneMode } from "../core/lanes/fixtures/lane-env.ts";
import { rawRecords } from "./lane-reach-residuals-owed-fixture.ts";

const TOPIC = "Тема zqdesign";
const NOW = new Date("2026-11-20T10:00:00Z");
const HELD = "design-2026-11-20-zqdesign";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0).toReversed()) lane.cleanup();
});

function payload(): Record<string, unknown> {
  return {
    title: "Zqdesign plan",
    alternatives: [
      { name: "option-a", approach: "a", tradeoffs: "a", recommended: true },
      { name: "option-b", approach: "b", tradeoffs: "b", recommended: false },
    ],
  };
}

/** A shared design note for `TOPIC` under the Latin-only slug an older release gave it. */
function seeded(mode: LaneMode): LaneEnv {
  const e = makeLaneEnv(mode, "osb-lane-owed-design-note-");
  lanes.push(e);
  const held = join(e.vault, "Brain", "decisions", `${HELD}.md`);
  writeLanePage(
    e.vault,
    held,
    {
      schema_version: 1,
      kind: "design-note",
      slug: "zqdesign",
      topic: TOPIC,
      title: "Held plan",
      recommended: "option-a",
      alternative_count: "2",
      agent: "tester",
      created_at: NOW.toISOString(),
    },
    "held body\n",
    { overwrite: false, vaultForRelativePath: e.vault },
  );
  expect(laneEntryInPrivate(e.vault, held)).toBe(false);
  // A store-only machine keeps the note as a record only; an unswitched vault keeps the file.
  expect(existsSync(held)).toBe(mode === "legacy");
  return e;
}

function attempt(e: LaneEnv, remote: boolean): unknown {
  return withPrivateWithheld(remote, () => {
    try {
      return commitDesignNote(e.vault, TOPIC, payload(), { agent: "tester", now: NOW });
    } catch (err) {
      return err;
    }
  });
}

describe("a design note whose topic a shared note of the day holds under its old slug", () => {
  for (const mode of ["store", "legacy"] as const) {
    test(`a local commit is refused by the held note's name and writes nothing (${mode})`, () => {
      const e = seeded(mode);
      const before = rawRecords(e);
      const out = attempt(e, false);
      expect(out).toBeInstanceOf(Error);
      expect(String(out)).toContain(HELD);
      expect(rawRecords(e)).toBe(before);
    });
  }

  test("a remote commit is refused by the held note's name too (store)", () => {
    const e = seeded("store");
    const before = rawRecords(e);
    const out = attempt(e, true);
    expect(out).toBeInstanceOf(Error);
    expect(String(out)).toContain(HELD);
    expect(rawRecords(e)).toBe(before);
  });
});
