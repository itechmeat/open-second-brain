/**
 * Durable workrun checkpoints for the dream pass (Brain Integrity
 * Suite, Feature 4). Each dream invocation writes a JSONL workrun
 * file under `Brain/log/dream-runs/<run-id>.jsonl`; the file records
 * phase transitions so a crash mid-pass leaves an inspectable trail.
 *
 * Recovery is non-resuming: `scanDanglingWorkruns(vault)` returns the
 * paths of every file whose last event is neither `finalized` nor
 * `interrupted`. The next dream pass logs a `recovered` event and the
 * brain_doctor surfaces the dangling files as warnings.
 *
 * Dry-run never emits a workrun - the workrun is part of the
 * durable side-effect surface and dry-runs must not mutate disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openWorkrun,
  scanDanglingWorkruns,
  WORKRUN_PHASE,
} from "../../../src/core/brain/dream-workrun.ts";
import { dreamRunsDir, dreamWorkrunPath } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-workrun-"));
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function parseJsonl(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("WORKRUN_PHASE", () => {
  test("exposes the five canonical phase strings + interrupted", () => {
    expect(WORKRUN_PHASE.started).toBe("started");
    expect(WORKRUN_PHASE.clusterComplete).toBe("cluster_complete");
    expect(WORKRUN_PHASE.promoteComplete).toBe("promote_complete");
    expect(WORKRUN_PHASE.retireComplete).toBe("retire_complete");
    expect(WORKRUN_PHASE.finalized).toBe("finalized");
    expect(WORKRUN_PHASE.interrupted).toBe("interrupted");
  });
});

describe("openWorkrun + checkpoint + finalize", () => {
  test("creates a JSONL file under Brain/log/dream-runs/ with a started line", () => {
    const runId = "dream-2026-05-27-120000";
    const handle = openWorkrun(vault, runId);
    expect(handle.path).toBe(dreamWorkrunPath(vault, runId));
    expect(existsSync(handle.path)).toBe(true);
    const lines = parseJsonl(handle.path);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.phase).toBe("started");
    expect(lines[0]?.run_id).toBe(runId);
    expect(typeof lines[0]?.at).toBe("string");
    handle.finalize();
  });

  test("checkpoint appends one line per phase, in invocation order", () => {
    const runId = "dream-2026-05-27-120001";
    const handle = openWorkrun(vault, runId);
    handle.checkpoint(WORKRUN_PHASE.clusterComplete);
    handle.checkpoint(WORKRUN_PHASE.promoteComplete);
    handle.checkpoint(WORKRUN_PHASE.retireComplete);
    handle.finalize();
    const lines = parseJsonl(handle.path);
    expect(lines.map((l) => l.phase)).toEqual([
      "started",
      "cluster_complete",
      "promote_complete",
      "retire_complete",
      "finalized",
    ]);
  });

  test("finalize is idempotent (second call is a no-op)", () => {
    const handle = openWorkrun(vault, "dream-2026-05-27-120002");
    handle.finalize();
    handle.finalize();
    const lines = parseJsonl(handle.path);
    expect(lines.filter((l) => l.phase === "finalized")).toHaveLength(1);
  });

  test("interrupt records an interrupted line with optional reason", () => {
    const handle = openWorkrun(vault, "dream-2026-05-27-120003");
    handle.interrupt("test crash");
    const lines = parseJsonl(handle.path);
    const last = lines[lines.length - 1];
    expect(last?.phase).toBe("interrupted");
    expect(last?.reason).toBe("test crash");
  });

  test("checkpoint after finalize is rejected (silent no-op)", () => {
    const handle = openWorkrun(vault, "dream-2026-05-27-120004");
    handle.finalize();
    handle.checkpoint(WORKRUN_PHASE.promoteComplete);
    const lines = parseJsonl(handle.path);
    // started + finalized, nothing else
    expect(lines.map((l) => l.phase)).toEqual(["started", "finalized"]);
  });
});

describe("scanDanglingWorkruns", () => {
  test("returns empty when no workruns directory exists", () => {
    expect(scanDanglingWorkruns(vault)).toEqual([]);
  });

  test("returns empty when every workrun file ends in finalized", () => {
    const a = openWorkrun(vault, "dream-2026-05-27-200001");
    a.finalize();
    const b = openWorkrun(vault, "dream-2026-05-27-200002");
    b.checkpoint(WORKRUN_PHASE.clusterComplete);
    b.finalize();
    expect(scanDanglingWorkruns(vault)).toEqual([]);
  });

  test("returns empty when a workrun ends in interrupted", () => {
    const handle = openWorkrun(vault, "dream-2026-05-27-200003");
    handle.checkpoint(WORKRUN_PHASE.clusterComplete);
    handle.interrupt("test");
    expect(scanDanglingWorkruns(vault)).toEqual([]);
  });

  test("returns paths of files whose last line is neither finalized nor interrupted", () => {
    const a = openWorkrun(vault, "dream-2026-05-27-200004");
    a.checkpoint(WORKRUN_PHASE.clusterComplete);
    // no finalize -> dangling

    const b = openWorkrun(vault, "dream-2026-05-27-200005");
    b.finalize();

    const dangling = scanDanglingWorkruns(vault).toSorted();
    expect(dangling).toEqual([a.path]);
  });

  test("tolerates malformed lines (a corrupt workrun is treated as dangling)", () => {
    mkdirSync(dreamRunsDir(vault), { recursive: true });
    const corruptPath = join(dreamRunsDir(vault), "dream-2026-05-27-9.jsonl");
    writeFileSync(corruptPath, "not json at all\n", "utf8");
    const dangling = scanDanglingWorkruns(vault);
    expect(dangling).toContain(corruptPath);
  });
});
