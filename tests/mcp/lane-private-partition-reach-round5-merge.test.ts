/**
 * A preference merge the entity guard refuses on a store without a
 * private entry (fifth closure round, finding 11).
 *
 * Below local reach the guard reads every entity on the fold of every
 * partition. When the entities the caller may read refuse the merge too,
 * the refusal is the guard's own (it names only what the caller reads);
 * the fixed answer is kept for a refusal only a private entity makes.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { BrainMergeError, mergePreferences } from "../../src/core/brain/merge.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function pref(e: LaneEnv, slug: string, principle: string): void {
  writePreference(e.vault, {
    slug,
    topic: "zqrelease review",
    principle,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-01T00:00:00Z",
    evidenced_by: [],
  });
}

function attempt(e: LaneEnv, remote: boolean): unknown {
  return withPrivateWithheld(remote, () => {
    try {
      mergePreferences(e.vault, "pref-zqkeep", "pref-zqdrop", { dryRun: true, now: NOW });
      return null;
    } catch (err) {
      return err;
    }
  });
}

describe("a preference merge the entity guard refuses with no private entry held", () => {
  test("a remote merge gets the guard's own refusal, as a local one does", () => {
    const e = makeLaneEnv("store", "osb-lane-round5-merge-");
    lanes.push(e);
    for (const name of ["Zqmary Somerville", "Zqada Lovelace"]) {
      upsertEntity(e.vault, { category: "people", name, agent: AGENT, now: NOW });
    }
    pref(e, "zqkeep", "Ask Zqmary Somerville before a release.");
    pref(e, "zqdrop", "Ask Zqada Lovelace before a release.");
    expect(e.laneRecords("private")).toEqual([]);
    const local = attempt(e, false);
    expect(local).toBeInstanceOf(BrainMergeError);
    const remote = attempt(e, true);
    expect(remote).toBeInstanceOf(BrainMergeError);
    expect((remote as BrainMergeError).code).toBe("entity-guard");
  });
});
