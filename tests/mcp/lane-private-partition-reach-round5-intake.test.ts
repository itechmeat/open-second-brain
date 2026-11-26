/**
 * The create paths a batch of entity upserts would take, predicted before
 * the first write (fifth closure round, finding 5).
 *
 * Below local reach a staged intake judges the review entry every create
 * of the batch would meet before it writes anything. Two new entities of
 * one batch whose names share a slug take two ids (the second the
 * suffixed one), so the prediction tracks the ids the batch allocates
 * across its items instead of answering the first free id twice.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { assertUpsertsAtReach, upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const SAME_KEY = ["Zqfoo?", "Zqfoo."];
const SAME_SLUG = ["Zqfoo & bar", "Zqfoo bar"];

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

const input = (name: string) => ({ category: "people", name, agent: AGENT, now: NOW });

describe("the create paths of a batch of entity upserts", () => {
  for (const [label, names] of [
    ["one identity", SAME_KEY],
    ["two identities of one slug", SAME_SLUG],
  ] as const) {
    test(`below local reach they are the paths the batch's writes take (${label})`, () => {
      const e = makeLaneEnv("store", "osb-lane-round5-intake-");
      lanes.push(e);
      const predicted = withPrivateWithheld(true, () =>
        assertUpsertsAtReach(e.vault, names.map(input)),
      );
      const written = names
        .map((name) => upsertEntity(e.vault, input(name)))
        .filter((res) => res.created)
        .map((res) => res.entity.path);
      expect(written).toHaveLength(names === SAME_KEY ? 1 : 2);
      expect(predicted).toEqual(written);
    });
  }
});
