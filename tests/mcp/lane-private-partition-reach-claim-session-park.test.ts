/**
 * A remote submit of a review-required session whose target became
 * private after the session was opened: the submit is refused with the
 * fixed answer and no parked session record is written.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { openArtifactSession, submitToSession } from "../../src/core/brain/write-session/engine.ts";
import {
  openPanelSession,
  submitToPanelSession,
} from "../../src/core/brain/write-session/panel.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = "2026-11-20T10:00:00.000Z";
const TARGET = "Brain/notes/zqclaim-adr.md";
const PANEL_TARGET = "Brain/decisions/panels/zqclaim-park.md";
const GOOD = ["---", "kind: note", "---", "", "# Decision record", "", "We adopt it."].join("\n");

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** Every store record of every partition, serialized. */
function snapshot(e: LaneEnv): string {
  return JSON.stringify(
    ["shared", "private"].flatMap((partition) =>
      readPartition(join(e.env.storeRoot, partition)).flatMap((shard) => shard.all),
    ),
  );
}

describe("a remote submit of a review-required session", () => {
  test("a target raised to private after the open refuses the submit before the park", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-session-park-");
    lane = e;
    const opened = withPrivateWithheld(true, () =>
      openArtifactSession(e.vault, {
        agent: "fixture-agent",
        targetPath: TARGET,
        requireReview: true,
        now: NOW,
      }),
    );
    expect(opened.status).toBe("needs-llm-step");
    writeLanePage(e.vault, join(e.vault, TARGET), { kind: "note" }, `# held\n\n${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, join(e.vault, TARGET))).toBe(true);
    const before = snapshot(e);
    let thrown: unknown = null;
    let answered: string | null = null;
    try {
      answered = withPrivateWithheld(true, () =>
        submitToSession(e.vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW }),
      ).status;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(answered).not.toBe("needs-review");
    expect(snapshot(e)).toBe(before);
  });

  test("an invalid artifact for a target held in private refuses without saving the attempt", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-session-park-");
    lane = e;
    const opened = openArtifactSession(e.vault, {
      agent: "fixture-agent",
      targetPath: TARGET,
      requireReview: true,
      now: NOW,
    });
    writeLanePage(e.vault, join(e.vault, TARGET), { kind: "note" }, `# held\n\n${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, join(e.vault, TARGET))).toBe(true);
    const before = snapshot(e);
    let thrown: unknown = null;
    try {
      withPrivateWithheld(true, () =>
        submitToSession(e.vault, { sessionId: opened.session_id, artifact: "", now: NOW }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(snapshot(e)).toBe(before);
  });

  test("a panel synthesis for a target raised to private after the open refuses before the park", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-session-park-");
    lane = e;
    const opened = withPrivateWithheld(true, () =>
      openPanelSession(e.vault, {
        agent: "fixture-agent",
        topic: "zqclaimpark",
        targetPath: PANEL_TARGET,
        requireReview: true,
        personas: ["technical"],
        now: NOW,
      }),
    );
    let current = opened;
    while (current.step !== "synthesis") {
      current = withPrivateWithheld(true, () =>
        submitToPanelSession(e.vault, {
          sessionId: opened.session_id,
          text: "an answer",
          now: NOW,
        }),
      );
    }
    writeLanePage(e.vault, join(e.vault, PANEL_TARGET), { kind: "note" }, `# held\n\n${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, join(e.vault, PANEL_TARGET))).toBe(true);
    const before = snapshot(e);
    let thrown: unknown = null;
    let answered: string | null = null;
    try {
      answered = withPrivateWithheld(true, () =>
        submitToPanelSession(e.vault, {
          sessionId: opened.session_id,
          text: "the synthesis",
          now: NOW,
        }),
      ).status;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(answered).not.toBe("needs-review");
    expect(snapshot(e)).toBe(before);
  });
});
