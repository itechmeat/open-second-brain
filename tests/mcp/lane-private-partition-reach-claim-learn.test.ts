/**
 * A remote learn whose verifier refuses a candidate drawn from private
 * turns: the answer names no proposal of that candidate, while the
 * rejection ledger row for it is held in `private`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { LEDGER_ROW_KIND } from "../../src/core/store/constants.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-claim-learn-");
  return lane;
}

function seedPrivateTurns(vault: string, count: number): void {
  for (let i = 0; i < count; i++) {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-05-03T08:10:00Z",
      sourceRefs: [{ id: "src-zqclaim" }],
      payload: { action: "zqclaimaction", summary: "Run zqclaimaction for batch 3" },
      private: true,
    });
  }
}

/** Ids of the verifier-rejection ledger rows held in `partition`. */
function rejectedIds(e: LaneEnv, partition: "shared" | "private"): string[] {
  return readPartition(join(e.env.storeRoot, partition))
    .flatMap((shard) => shard.all)
    .filter((r) => r.kind === LEDGER_ROW_KIND)
    .map((r) => String((r.body["row"] as Record<string, unknown>)["id"]))
    .filter((id) => id.startsWith("prop-"));
}

const refusedKey = (out: Record<string, unknown>): unknown =>
  out["verifier_rejected"] ?? out["verifierRejected"];

describe("a learn whose verifier refuses a private candidate", () => {
  test("a remote answer names no verifier-refused proposal held in private", async () => {
    const e = env();
    const { vault } = e;
    seedPrivateTurns(vault, 3);
    const out = await callJson(server(e), "brain_skill_proposals", {
      operation: "learn",
      min_support: 3,
    });
    expect(out["error"]).toBeUndefined();
    expect(rejectedIds(e, "private").length).toBeGreaterThan(0);
    expect(rejectedIds(e, "shared")).toEqual([]);
    for (const id of rejectedIds(e, "private")) {
      expect(JSON.stringify(refusedKey(out))).not.toContain(id);
    }
  });

  test("a local answer reports the verifier-refused proposal", async () => {
    const e = env();
    seedPrivateTurns(e.vault, 3);
    const out = await callJson(localServer(e), "brain_skill_proposals", {
      operation: "learn",
      min_support: 3,
    });
    expect(refusedKey(out)).toHaveLength(rejectedIds(e, "private").length);
  });
});
