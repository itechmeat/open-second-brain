/**
 * An untrusted entity upsert below local reach of a name two quarantined
 * records hold as an alias in `private`: the upsert is refused as the
 * local one is, and writes nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { upsertEntity, type UpsertEntityInput } from "../../src/core/brain/entities/registry.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const ALIAS = "Zqavery";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-claim-alias-ambiguity-");
  return lane;
}

/** Two quarantined records held in `private`, each claiming `ALIAS`. */
function seedTwoClaimants(e: LaneEnv): string[] {
  const paths: string[] = [];
  for (const name of ["Zqavery One", "Zqavery Two"]) {
    const { entity } = upsertEntity(e.vault, {
      category: "people",
      name,
      aliases: [ALIAS],
      agent: AGENT,
      now: NOW,
      body: `held ${REGION}\n`,
      untrustedOrigin: true,
    });
    expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
    paths.push(entity.path);
  }
  return paths;
}

const byAlias = (): UpsertEntityInput => ({
  category: "people",
  name: ALIAS,
  agent: AGENT,
  now: NOW,
  body: "zqnew body\n",
  untrustedOrigin: true,
});

function attempt(e: LaneEnv, remote: boolean): unknown {
  return withPrivateWithheld(remote, () => {
    try {
      upsertEntity(e.vault, byAlias());
      return null;
    } catch (err) {
      return err;
    }
  });
}

describe("an untrusted upsert of a name two private quarantined records claim", () => {
  test("a remote upsert of the alias is refused and writes nothing", () => {
    const e = env();
    seedTwoClaimants(e);
    const before = e.laneRecords().length;
    const out = attempt(e, true);
    const quarantineRecords = e.laneRecords().length;
    expect(out).not.toBeNull();
    expect(quarantineRecords).toBe(before);
    expect(String(out)).not.toContain(REGION);
  });

  test("a local upsert of the alias is refused as ambiguous", () => {
    const e = env();
    seedTwoClaimants(e);
    const before = JSON.stringify(e.laneRecords());
    expect(String(attempt(e, false))).toContain("Zqavery");
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });
});
