/**
 * A private same-topic panel holds the day at commit (change
 * `lane-reach-residuals`, package 9, design R8): one panel per topic and
 * day holds across both default names, and below local reach that rule is
 * read on the fold of every partition. A private panel of the topic under
 * one default name refuses, with the fixed answer, the commit of a panel
 * session of the same topic and day under the other default name, opened
 * by default or with that name as explicit target; no second panel of the
 * day is written. A local commit is refused by the held name, as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  openPanelSession,
  submitToPanelSession,
} from "../../src/core/brain/write-session/panel.ts";
import { panelDefaultNames } from "../../src/core/brain/write-session/panel-target.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TOPIC = "Тема zqhold";
const DAY = "2026-11-20";
const NOW = `${DAY}T10:00:00.000Z`;
const LATER = `${DAY}T10:05:00.000Z`;
const { fresh: FRESH, legacy: LEGACY_NAMES } = panelDefaultNames(TOPIC, DAY);
const LEGACY = LEGACY_NAMES[0]!;

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-panel-hold-");
  lanes.push(e);
  return e;
}

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** A private panel of `TOPIC` for the day at the vault-relative `rel`. */
function heldPanel(e: LaneEnv, rel: string): void {
  writeLanePage(e.vault, join(e.vault, rel), { topic: TOPIC, created_at: NOW }, `held ${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, join(e.vault, rel))).toBe(true);
}

/** `<name>: <message>` of what `fn` throws, or its answer serialized. */
function outcome(fn: () => unknown): string {
  try {
    return JSON.stringify(fn());
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** Open a one-persona panel session (by default, or at `target`) and answer its persona step. */
function openAndAnswer(e: LaneEnv, remote: boolean, target?: string): string {
  return withPrivateWithheld(remote, () => {
    const opened = openPanelSession(e.vault, {
      agent: "tester",
      topic: TOPIC,
      personas: ["technical"],
      now: NOW,
      ...(target !== undefined ? { targetPath: target } : {}),
    });
    const id = opened.session_id;
    const answered = submitToPanelSession(e.vault, {
      sessionId: id,
      text: "zqhold persona answer",
      now: NOW,
    });
    expect(answered.status).toBe("needs-llm-step");
    return id;
  });
}

/** Submit the synthesis of session `id`. */
function synthesis(e: LaneEnv, remote: boolean, id: string): string {
  return outcome(() =>
    withPrivateWithheld(remote, () =>
      submitToPanelSession(e.vault, { sessionId: id, text: "zqhold synthesis", now: LATER }),
    ),
  );
}

describe("a private same-topic panel holds the day at commit", () => {
  test("a remote commit of a session opened by default is refused with the fixed answer", () => {
    const e = env();
    expect(LEGACY).not.toBe(FRESH);
    const id = openAndAnswer(e, true);
    heldPanel(e, LEGACY);
    const before = rawRecords(e);

    const answer = synthesis(e, true, id);

    expect(answer).toBe(`LaneEntryWithheldError: ${WITHHELD}`);
    expect(rawRecords(e)).toEqual(before);
  });

  test("a remote commit of a session opened at the other default name is refused with the fixed answer", () => {
    const e = env();
    heldPanel(e, FRESH);
    const id = openAndAnswer(e, true, LEGACY);
    const before = rawRecords(e);

    const answer = synthesis(e, true, id);

    expect(answer).toBe(`LaneEntryWithheldError: ${WITHHELD}`);
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local commit of a session opened by default is refused by the held name", () => {
    const e = env();
    const id = openAndAnswer(e, false);
    heldPanel(e, LEGACY);
    const answer = synthesis(e, false, id);
    expect(answer).toContain(`${LEGACY} already exists`);
  });

  test("a local commit of a session opened at the other default name is refused by the held name", () => {
    const e = env();
    heldPanel(e, FRESH);
    const id = openAndAnswer(e, false, LEGACY);
    const answer = synthesis(e, false, id);
    expect(answer).toContain(`${FRESH} already exists`);
  });
});
