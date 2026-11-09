/**
 * Create-once lane writes across two processes (task 2.10 WP6): of two
 * writers racing for one entry, exactly one creates it and the other gets
 * the "exists" answer (`EEXIST`) an unswitched machine's exclusive create
 * gives, in every mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readLanePage } from "../../../src/core/store/lane-pages.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const WRITER = join(import.meta.dir, "fixtures", "create-once.ts");

describe.each(LANE_MODES)("create-once race (%s)", (mode) => {
  test("one of two processes creates the entry, the other is told it exists", async () => {
    lane = makeLaneEnv(mode);
    const path = join(lane.vault, "Brain", "write-sessions-race", "ws-1.md");
    // A barrier both writers wait on: each signals it is loaded, and the
    // parent opens the gate only when both are, however slow their cold
    // starts are. A fixed start instant could pass before a slow child
    // even started, and the "race" would run one writer after the other.
    const barrier = join(lane.env.parent, "barrier");
    mkdirSync(barrier, { recursive: true });
    const run = (label: string) =>
      Bun.spawn([process.execPath, WRITER, lane!.vault, path, barrier, label], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    const procs = [run("a"), run("b")];
    const outsP = Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const errsP = Promise.all(procs.map((p) => new Response(p.stderr).text()));
    const deadline = Date.now() + 30_000;
    while (!["a", "b"].every((l) => existsSync(join(barrier, `${l}.ready`)))) {
      if (Date.now() > deadline) throw new Error("the writers never became ready");
      await Bun.sleep(10);
    }
    // Neither writer has written yet: both are waiting at the gate.
    expect(readLanePage(lane.vault, path)).toBeNull();
    writeFileSync(join(barrier, "go"), "");
    const [outs, errs] = await Promise.all([outsP, errsP]);
    await Promise.all(procs.map((p) => p.exited));
    const answers = outs.map((o) => o.trim()).toSorted();
    // The writers' stderr rides along so a crashed writer shows its
    // error in the failure diff, not only as a missing answer.
    expect({ answers, errs }).toEqual({
      answers: ["created", "exists EEXIST"],
      errs: expect.any(Array),
    });
    const winner = readLanePage(lane.vault, path)?.frontmatter["writer"];
    expect(["a", "b"]).toContain(winner as string);
    if (mode !== "legacy") expect(lane.laneRecords()).toHaveLength(1);
  }, 60_000);
});
