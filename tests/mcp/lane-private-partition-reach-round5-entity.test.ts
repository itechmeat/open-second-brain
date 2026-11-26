/**
 * An untrusted entity upsert that meets a private claimant of its name
 * (fifth closure round, finding 4).
 *
 * A local untrusted upsert is refused when an archived entity holds the
 * name, and is refused as ambiguous when two quarantined records claim it.
 * Below local reach those claimants are judged on the fold of every
 * partition, so one held in `private` refuses the call with the fixed
 * answer before any write instead of a shared record minted beside it.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  archiveEntity,
  upsertEntity,
  type UpsertEntityInput,
} from "../../src/core/brain/entities/registry.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const NAME = "Zqalice Held";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round5-entity-");
  lanes.push(e);
  return e;
}

const untrusted = (body: string): UpsertEntityInput => ({
  category: "people",
  name: NAME,
  agent: AGENT,
  now: NOW,
  body,
  untrustedOrigin: true,
});

function attempt(e: LaneEnv, remote: boolean): unknown {
  return withPrivateWithheld(remote, () => {
    try {
      upsertEntity(e.vault, untrusted("zqnew body\n"));
      return null;
    } catch (err) {
      return err;
    }
  });
}

describe("an untrusted upsert whose name a private claimant holds", () => {
  test("a remote upsert that meets a private archived entity gets the fixed refusal and writes nothing", () => {
    const e = env();
    const { entity } = upsertEntity(e.vault, {
      category: "people",
      name: NAME,
      agent: AGENT,
      now: NOW,
      body: `held ${REGION}\n`,
    });
    archiveEntity(e.vault, { category: "people", query: NAME }, { now: NOW });
    expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
    const before = JSON.stringify(e.laneRecords());
    expect(attempt(e, true)).toBeInstanceOf(LaneEntryWithheldError);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local upsert that meets the archived entity is refused by its archive", () => {
    const e = env();
    upsertEntity(e.vault, {
      category: "people",
      name: NAME,
      agent: AGENT,
      now: NOW,
      body: `held ${REGION}\n`,
    });
    archiveEntity(e.vault, { category: "people", query: NAME }, { now: NOW });
    expect(String(attempt(e, false))).toContain("archived");
  });

  test("a remote upsert that meets a private and a shared quarantined claimant gets the fixed refusal", () => {
    const e = env();
    const held = upsertEntity(e.vault, untrusted(`held ${REGION}\n`)).entity;
    expect(laneEntryInPrivate(e.vault, held.path)).toBe(true);
    // A second quarantined claimant of the same name, in shared: a record
    // another device minted under its own id.
    const open = held.path.replace(/\.md$/u, "-zqtwin.md");
    const heldText = readLaneText(e.vault, held.path)!;
    writeLaneText(
      e.vault,
      open,
      heldText
        .replace(`entity_id: ${held.id}`, `entity_id: ${held.id}-zqtwin`)
        .replace(/held <private>[^\n]*/u, "open body"),
    );
    expect(laneEntryInPrivate(e.vault, open)).toBe(false);
    const before = JSON.stringify(e.laneRecords());
    expect(String(attempt(e, false))).toContain("claimed by 2");
    expect(attempt(e, true)).toBeInstanceOf(LaneEntryWithheldError);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });
});
