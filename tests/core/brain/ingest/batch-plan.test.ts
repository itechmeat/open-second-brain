/**
 * Batch-plan step (A3, t_9eeb8ca2). `planBatches` discovers ingestible files
 * under a source dir, consults A1's content-hash manifest to skip `unchanged`
 * sources, then splits the `new`/`modified` remainder into size+count-bounded
 * batches an agent/CLI can dispatch as parallel subagents. The kernel runs no
 * ingestion here - it only plans. The plan is deterministic (sort by path, fill
 * greedily to the byte cap then the count cap).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { updateManifest } from "../../../../src/core/brain/ingest/content-manifest.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { recordCompleted } from "../../../../src/core/brain/ingest/checkpoint.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-batchplan-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-batchplan-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Write a source file of exactly `bytes` bytes (ASCII "x" fill). */
function writeSized(rel: string, bytes: number): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x".repeat(bytes), "utf8");
}

function allPlannedPaths(plan: ReturnType<typeof planBatches>): string[] {
  return plan.batches.flatMap((b) => b.files.map((f) => f.path));
}

describe("planBatches — discovery + skip-unchanged", () => {
  test("skips `unchanged` files (via the manifest) and plans only new/modified", () => {
    writeSized("Inbox/keep.md", 100);
    writeSized("Inbox/edit.md", 100);
    writeSized("Inbox/fresh.md", 100);
    // Seed the manifest for keep + edit, then modify edit so it re-classifies.
    updateManifest(vault, ["Inbox/keep.md", "Inbox/edit.md"]);
    writeSized("Inbox/edit.md", 120);

    const plan = planBatches(vault, "Inbox", { maxBatchBytes: 10_000, maxBatchFiles: 100 });

    // keep is unchanged → skipped, never batched.
    expect(plan.skipped).toEqual(["Inbox/keep.md"]);
    const planned = allPlannedPaths(plan);
    expect(planned).toContain("Inbox/edit.md"); // modified
    expect(planned).toContain("Inbox/fresh.md"); // new
    expect(planned).not.toContain("Inbox/keep.md");
    expect(plan.totalFiles).toBe(2);
  });

  test("only ingestible (text-bearing) files are discovered; binaries/media ignored", () => {
    writeSized("Docs/a.md", 50);
    writeSized("Docs/b.txt", 50);
    writeSized("Docs/image.png", 50);
    writeSized("Docs/archive.zip", 50);

    const plan = planBatches(vault, "Docs", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    const planned = allPlannedPaths(plan).toSorted();
    expect(planned).toEqual(["Docs/a.md", "Docs/b.txt"]);
  });

  test("hidden files and dot-directories are not discovered", () => {
    writeSized("Notes/real.md", 50);
    writeSized("Notes/.secret.md", 50);
    writeSized("Notes/.git/config.md", 50);

    const plan = planBatches(vault, "Notes", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(allPlannedPaths(plan)).toEqual(["Notes/real.md"]);
  });
});

describe("planBatches — bounded batches", () => {
  test("no batch exceeds the byte cap or the file-count cap", () => {
    // 6 files of 100 bytes each. Byte cap 250 → at most 2 per batch (200 ok,
    // 300 would exceed). File cap 5 is looser, so the byte cap governs here.
    for (let i = 0; i < 6; i++) writeSized(`Big/f${i}.md`, 100);

    const plan = planBatches(vault, "Big", { maxBatchBytes: 250, maxBatchFiles: 5 });
    expect(plan.totalFiles).toBe(6);
    for (const b of plan.batches) {
      expect(b.totalBytes).toBeLessThanOrEqual(250);
      expect(b.files.length).toBeLessThanOrEqual(5);
    }
    // Every file lands in exactly one batch.
    expect(allPlannedPaths(plan).length).toBe(6);
  });

  test("file-count cap governs when it is tighter than the byte cap", () => {
    for (let i = 0; i < 5; i++) writeSized(`Small/f${i}.md`, 10);

    const plan = planBatches(vault, "Small", { maxBatchBytes: 1_000_000, maxBatchFiles: 2 });
    // 5 files, cap 2 → batches of 2, 2, 1.
    expect(plan.batches.map((b) => b.files.length)).toEqual([2, 2, 1]);
  });

  test("a single file larger than the byte cap forms its own singleton batch", () => {
    writeSized("Huge/small.md", 10);
    writeSized("Huge/whale.md", 5_000);

    const plan = planBatches(vault, "Huge", { maxBatchBytes: 1_000, maxBatchFiles: 100 });
    // The oversize file cannot be split, so it lands alone; the small file is
    // its own batch. No batch mixes them.
    const whaleBatch = plan.batches.find((b) => b.files.some((f) => f.path === "Huge/whale.md"));
    expect(whaleBatch!.files.length).toBe(1);
    expect(whaleBatch!.totalBytes).toBe(5_000);
  });

  test("rejects non-positive caps (no silent fallback)", () => {
    writeSized("X/a.md", 10);
    expect(() => planBatches(vault, "X", { maxBatchBytes: 0, maxBatchFiles: 10 })).toThrow();
    expect(() => planBatches(vault, "X", { maxBatchBytes: 100, maxBatchFiles: 0 })).toThrow();
  });
});

describe("planBatches — determinism + empty", () => {
  test("same dir → identical plan, stable path ordering", () => {
    // Write out of lexical order to prove the plan sorts.
    writeSized("D/zebra.md", 100);
    writeSized("D/alpha.md", 100);
    writeSized("D/mango.md", 100);

    const p1 = planBatches(vault, "D", { maxBatchBytes: 250, maxBatchFiles: 10 });
    const p2 = planBatches(vault, "D", { maxBatchBytes: 250, maxBatchFiles: 10 });
    expect(p1).toEqual(p2);

    // Files are batched in sorted-by-path order.
    expect(allPlannedPaths(p1)).toEqual(["D/alpha.md", "D/mango.md", "D/zebra.md"]);
  });

  test("an empty dir yields an empty plan (no spurious batches)", () => {
    mkdirSync(join(vault, "Empty"), { recursive: true });
    const plan = planBatches(vault, "Empty", { maxBatchBytes: 100, maxBatchFiles: 10 });
    expect(plan.batches).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.totalFiles).toBe(0);
  });

  test("an all-unchanged dir yields an empty plan but reports the skipped files", () => {
    writeSized("Stable/a.md", 100);
    writeSized("Stable/b.md", 100);
    updateManifest(vault, ["Stable/a.md", "Stable/b.md"]);

    const plan = planBatches(vault, "Stable", { maxBatchBytes: 100, maxBatchFiles: 10 });
    expect(plan.batches).toEqual([]);
    expect(plan.totalFiles).toBe(0);
    expect(plan.skipped.toSorted()).toEqual(["Stable/a.md", "Stable/b.md"]);
  });

  test("a non-existent source dir is a hard error, not an empty plan", () => {
    expect(() => planBatches(vault, "Nope", { maxBatchBytes: 100, maxBatchFiles: 10 })).toThrow();
  });
});

describe("planBatches — resume (t_ba1fa5f6)", () => {
  test("resume excludes checkpointed items but keeps the plan id stable", () => {
    writeSized("Big/a.md", 100);
    writeSized("Big/b.md", 100);
    writeSized("Big/c.md", 100);

    // Fresh plan sees all three; its id is derived from the full discovered set.
    const fresh = planBatches(vault, "Big", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(fresh.totalFiles).toBe(3);
    expect(fresh.resumedCompleted).toBe(0);

    // Simulate an interruption after two items completed.
    recordCompleted(vault, fresh.planId, "Big", ["Big/a.md", "Big/b.md"], new Date());

    const resumed = planBatches(vault, "Big", {
      maxBatchBytes: 10_000,
      maxBatchFiles: 100,
      resume: true,
    });
    expect(resumed.planId).toBe(fresh.planId);
    expect(allPlannedPaths(resumed)).toEqual(["Big/c.md"]);
    expect(resumed.totalFiles).toBe(1);
    expect(resumed.resumedCompleted).toBe(2);
  });

  test("without resume the checkpoint is ignored", () => {
    writeSized("Big/a.md", 100);
    writeSized("Big/b.md", 100);
    const planId = planBatches(vault, "Big", {
      maxBatchBytes: 10_000,
      maxBatchFiles: 100,
    }).planId;
    recordCompleted(vault, planId, "Big", ["Big/a.md"], new Date());

    const plan = planBatches(vault, "Big", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(plan.totalFiles).toBe(2);
    expect(plan.resumedCompleted).toBe(0);
  });

  test("OSB_INGEST_NO_CHECKPOINT makes resume a no-op (nothing excluded)", () => {
    writeSized("Big/a.md", 100);
    writeSized("Big/b.md", 100);
    const fresh = planBatches(vault, "Big", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    try {
      process.env["OSB_INGEST_NO_CHECKPOINT"] = "1";
      // record is inert under the opt-out, and so is the resume read.
      recordCompleted(vault, fresh.planId, "Big", ["Big/a.md"], new Date());
      const plan = planBatches(vault, "Big", {
        maxBatchBytes: 10_000,
        maxBatchFiles: 100,
        resume: true,
      });
      expect(plan.totalFiles).toBe(2);
      expect(plan.resumedCompleted).toBe(0);
    } finally {
      delete process.env["OSB_INGEST_NO_CHECKPOINT"];
    }
  });
});
