/**
 * Dream run-id collision resolution (#161, spine A).
 *
 * `dream` derives its run id from the injected clock, so two passes in the
 * same second want the same archive name. The resolver walks `-2`, `-3`, …
 * until a name is free in BOTH the snapshot directory and the workrun
 * directory. It used to walk without a bound: a directory that answered
 * "taken" for every candidate - a stale `.snapshots/` full of dream
 * archives, a permission problem that makes every probe look occupied -
 * spun forever with no output. A bound turns that into a loud failure that
 * names the id it started from.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { snapshotPath } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { compactRunStamp } from "../../../src/core/brain/time.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

const NOW = new Date("2026-06-01T09:30:00Z");
const BASE_RUN_ID = `${BRAIN_SNAPSHOT_REASON.dream}-${compactRunStamp(NOW)}`;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-run-id-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-run-id-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  // A pass with nothing to do returns before the snapshot, so the run id
  // is only resolved when there is state to change: three same-sign
  // signals on one topic is the promotion threshold.
  for (const slug of ["a", "b", "c"]) {
    writeSignal(vault, {
      topic: "tabs-rule",
      signal: "positive",
      agent: "claude",
      principle: "Indent source with tabs, not spaces",
      created_at: "2026-06-01T09:00:00Z",
      date: "2026-06-01",
      slug,
      scope: "coding",
    });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Occupy `count` consecutive candidate names starting at the base id. */
function occupyRunIds(count: number): void {
  mkdirSync(join(vault, "Brain", ".snapshots"), { recursive: true });
  for (let n = 1; n <= count; n++) {
    const runId = n === 1 ? BASE_RUN_ID : `${BASE_RUN_ID}-${n}`;
    writeFileSync(snapshotPath(vault, runId), "occupied", "utf8");
  }
}

describe("dream run-id allocation", () => {
  test("steps past occupied ids to the first free one", () => {
    occupyRunIds(3);
    const summary = dream(vault, { now: NOW });
    expect(summary.run_id).toBe(`${BASE_RUN_ID}-4`);
  });

  test("fails loudly once the bound is exhausted instead of spinning", () => {
    occupyRunIds(64);
    expect(() => dream(vault, { now: NOW })).toThrow(/could not reserve a unique dream run id/);
  });
});
