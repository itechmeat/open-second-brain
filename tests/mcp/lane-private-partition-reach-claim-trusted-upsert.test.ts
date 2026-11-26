/**
 * A trusted entity upsert below local reach whose name a quarantined
 * record holds in `private`: the upsert answers as a local one does and
 * creates its own canonical record.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { upsertEntity, type UpsertEntityInput } from "../../src/core/brain/entities/registry.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const NAME = "Zqavery Held";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-claim-trusted-upsert-");
  return lane;
}

const trusted = (): UpsertEntityInput => ({
  category: "people",
  name: NAME,
  agent: AGENT,
  now: NOW,
  body: "zqtrusted body\n",
});

/** Seed a quarantined record of `NAME` held in `private`. */
function seedQuarantined(e: LaneEnv): void {
  const { entity } = upsertEntity(e.vault, {
    category: "people",
    name: NAME,
    agent: AGENT,
    now: NOW,
    body: `held ${REGION}\n`,
    untrustedOrigin: true,
  });
  expect(entity.status).toBe("quarantine");
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
}

function attempt(e: LaneEnv, remote: boolean): { created: boolean; status: string } | unknown {
  return withPrivateWithheld(remote, () => {
    try {
      const { entity, created } = upsertEntity(e.vault, trusted());
      return { created, status: entity.status };
    } catch (err) {
      return err;
    }
  });
}

describe("a trusted upsert whose name a private quarantined record holds", () => {
  test("a remote trusted upsert creates its canonical record like a local one", () => {
    const e = env();
    seedQuarantined(e);
    const privateBefore = JSON.stringify(e.laneRecords("private"));
    const out = attempt(e, true);
    expect(out).not.toBeInstanceOf(LaneEntryWithheldError);
    expect(out).toEqual({ created: true, status: "active" });
    expect(JSON.stringify(e.laneRecords("private"))).toBe(privateBefore);
  });

  test("a local trusted upsert creates its canonical record", () => {
    const e = env();
    seedQuarantined(e);
    expect(attempt(e, false)).toEqual({ created: true, status: "active" });
  });
});
