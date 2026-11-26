/**
 * A remote bridge dismissal whose dismissal list is held in `private`:
 * the answer does not depend on whether the pair is already dismissed,
 * and the private entry keeps its record.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { callJson, localServer, server } from "./lane-private-partition-reach-writes-fixture.ts";
import {
  raiseBridgeArtifacts,
  seedBridgeIndex,
} from "./lane-private-partition-reach-maintenance-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

describe("a remote dismissal beside a private dismissal list", () => {
  test("a remote dismissal answers the same for a dismissed and an absent pair and keeps the list", async () => {
    const e = makeLaneEnv("store", "osb-lane-claim-bridge-dismiss-");
    lane = e;
    const { privatePair, openPair } = await seedBridgeIndex(e);
    const local = localServer(e);
    await callJson(local, "brain_bridges", {
      operation: "dismiss",
      source: privatePair[0],
      target: privatePair[1],
    });
    await callJson(local, "brain_bridges", { operation: "discover", min_similarity: 0.1 });
    raiseBridgeArtifacts(e.vault);
    const privateBefore = JSON.stringify(e.laneRecords("private"));
    const remote = server(e);
    const absent = await callJson(remote, "brain_bridges", {
      operation: "dismiss",
      source: openPair[0],
      target: openPair[1],
    });
    const dismissedAgain = await callJson(remote, "brain_bridges", {
      operation: "dismiss",
      source: privatePair[0],
      target: privatePair[1],
    });
    expect(JSON.stringify(e.laneRecords("private"))).toBe(privateBefore);
    expect(dismissedAgain).toEqual(absent);
    expect(absent["error"]).toBe("this entry cannot be written at this reach");
    expect(dismissedAgain["error"]).toBe("this entry cannot be written at this reach");
  });
});
