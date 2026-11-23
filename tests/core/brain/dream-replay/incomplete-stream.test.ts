/**
 * The replay does not guess from a partial read of its own stream: a
 * record whose body is a quarantined pending blob opens no gap by store
 * design, so the pass and the surfaces that fold the stream must treat it
 * as unknown, not as absent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import {
  assertNoWindowsBehind,
  readConfiguredReplay,
} from "../../../../src/core/brain/dream-replay/behind.ts";
import { replayStatus } from "../../../../src/core/brain/dream-replay/status-view.ts";
import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import { dreamReplayCheck } from "../../../../src/core/brain/doctor/dream-replay-check.ts";
import {
  DreamReplayUnreadableError,
  readReplayState,
} from "../../../../src/core/brain/dream-replay/pass.ts";
import {
  DREAM_ADMISSION_KIND,
  DREAM_REPLAY_STREAM,
  DREAM_WINDOW_PLAN_KIND,
} from "../../../../src/core/brain/dream-replay/records.ts";
import { addQuarantine } from "../../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../../src/core/store/shard-quarantine.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../../src/core/store/store-paths.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { dateOf } from "../../../helpers/dream-replay-scenarios.ts";

const opened: DreamReplayFixture[] = [];
afterEach(() => {
  for (const f of opened.splice(0).toReversed()) f.cleanup();
});

/** An open window whose plan record's body is a blob that never arrived, quarantined as pending. */
function quarantinedPlan(): DreamReplayFixture {
  const f = makeDreamReplayFixture();
  opened.push(f);
  f.cover(dateOf(0));
  const day = dateOf(1);
  f.append(DREAM_ADMISSION_KIND, {
    day,
    window: day,
    from: `${day}T00:00:00.000Z`,
    to: `${day}T23:59:59.999Z`,
    positions: [],
    gaps: [],
    late: [],
    clamped: [],
    left_out: [],
    rebased: null,
    admitted_at: `${day}T23:00:00.000Z`,
    run: "fixture",
  });
  f.append(DREAM_WINDOW_PLAN_KIND, {
    day,
    window: day,
    version: 1,
    effects: [],
    frozen: { padding: "x".repeat(40_000) },
    run: "fixture",
  });
  const shared = partitionDir(f.storeRoot, "shared");
  rmSync(join(shared, "blobs"), { recursive: true, force: true });
  const dir = join(shared, DREAM_REPLAY_STREAM, "dev-a");
  const path = join(dir, readdirSync(dir)[0]!);
  const lines = readFileSync(path, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(DREAM_WINDOW_PLAN_KIND));
  expect(index).toBeGreaterThanOrEqual(0);
  const offset = lines.slice(0, index).reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
  addQuarantine(f.storeRoot, {
    partition: "shared",
    shard: relative(shared, path).split("\\").join("/"),
    offset,
    sha256: lineSha256At(path, offset, shared)!,
    kind: "blob-pending",
    reason: "test",
  });
  return f;
}

describe("dream replay: an incomplete read of the stream", () => {
  test("a quarantined pending record stops the pass instead of being folded as absent", () => {
    const f = quarantinedPlan();
    // The plan is not in the records the stream gives: the read skipped it.
    expect(f.replayState().plans.size).toBe(0);
    const store = openStore({ root: f.storeRoot, device: "dev-a" });
    expect(() => readReplayState({ store })).toThrow(DreamReplayUnreadableError);
  });

  test("the surfaces that fold the stream say unknown, not a count", () => {
    const f = quarantinedPlan();
    expect(() => readConfiguredReplay(f.vault, f.configPath)).toThrow(DreamReplayUnreadableError);
    // The staged flow is refused while the replay's state is unknown.
    expect(() =>
      assertNoWindowsBehind(f.vault, new Date(`${dateOf(3)}T12:00:00.000Z`), f.configPath),
    ).toThrow(DreamReplayUnreadableError);
    const status = replayStatus(f.vault, { configPath: f.configPath });
    expect(status.available).toBe(false);
    expect(status.available ? "" : status.message).toContain("unknown");
    const out: DoctorFindings = { issues: [], uncertain: [] };
    const now = new Date(`${dateOf(3)}T12:00:00.000Z`);
    dreamReplayCheck.run({ vault: f.vault, now, configPath: f.configPath } as never, out);
    expect(out.issues.map((issue) => issue.code)).toContain("dream-replay-gap");
    expect(out.uncertain.map((issue) => issue.code)).not.toContain("dream-replay-behind");
  });
});
