/**
 * The scan figures of a `brain_skill_proposals` learn below local reach
 * (eighth closure round, finding 2): `scanned`, `watermarkFrom` and
 * `watermarkTo` are taken over the continuity records the caller may
 * read, while the learn, its watermark on disk and its ledger rows stay
 * on the fold of every partition.
 *
 * Each test seeds two `shared` continuity records and a later `private`
 * one. A remote learn answers the shared count and the newest shared
 * time; a local learn afterwards shows the watermark on disk passed the
 * private record; a second remote learn starts from the newest shared
 * time. The same learn through a local server on a twin store is the
 * control: it counts and dates every record.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { callJson, localServer, server } from "./lane-private-partition-reach-writes-fixture.ts";

const SHARED_EARLY = "2026-05-03T08:00:00Z";
const SHARED_LATE = "2026-05-03T08:30:00Z";
const HELD_AT = "2026-05-03T09:45:00Z";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** Two shared continuity records and a later private one. */
function seeded(prefix: string): LaneEnv {
  const e = makeLaneEnv("store", `osb-lane-round8-learn-${prefix}-`);
  lanes.push(e);
  for (const [createdAt, action] of [
    [SHARED_EARLY, "zqround8shared-early"],
    [SHARED_LATE, "zqround8shared-late"],
  ] as const) {
    appendContinuityRecord(e.vault, {
      kind: "session_turn",
      createdAt,
      sourceRefs: [{ id: "src-zqround8-shared" }],
      payload: { action, summary: `Run ${action}` },
    });
  }
  appendContinuityRecord(e.vault, {
    kind: "session_turn",
    createdAt: HELD_AT,
    sourceRefs: [{ id: "src-zqround8-held" }],
    payload: { action: "zqround8held", summary: "Run zqround8held" },
    private: true,
  });
  return e;
}

/** The three scan figures of a learn answer. */
function figures(out: Record<string, unknown>): Record<string, unknown> {
  return {
    error: out["error"] ?? null,
    scanned: out["scanned"],
    watermarkFrom: out["watermarkFrom"],
    watermarkTo: out["watermarkTo"],
  };
}

describe("the scan figures of a learn below local reach", () => {
  test("a remote learn counts and dates only the records the caller may read", async () => {
    const e = seeded("remote");

    const remote = await callJson(server(e), "brain_skill_proposals", { operation: "learn" });

    expect(figures(remote)).toEqual({
      error: null,
      scanned: 2,
      watermarkFrom: null,
      watermarkTo: SHARED_LATE,
    });
    expect(JSON.stringify(remote)).not.toContain(HELD_AT);
    // The learn ran on the whole fold: its watermark on disk passed the
    // private record, so a local learn afterwards scans nothing new.
    const local = await callJson(localServer(e), "brain_skill_proposals", { operation: "learn" });
    expect(figures(local)).toEqual({
      error: null,
      scanned: 0,
      watermarkFrom: HELD_AT,
      watermarkTo: HELD_AT,
    });
    // A second remote learn starts from the newest record it may read.
    const again = await callJson(server(e), "brain_skill_proposals", { operation: "learn" });
    expect(figures(again)).toEqual({
      error: null,
      scanned: 0,
      watermarkFrom: SHARED_LATE,
      watermarkTo: SHARED_LATE,
    });
    expect(JSON.stringify(again)).not.toContain(HELD_AT);
  });

  test("a local learn counts and dates every record", async () => {
    const e = seeded("local");

    const local = await callJson(localServer(e), "brain_skill_proposals", { operation: "learn" });

    expect(figures(local)).toEqual({
      error: null,
      scanned: 3,
      watermarkFrom: null,
      watermarkTo: HELD_AT,
    });
  });
});
