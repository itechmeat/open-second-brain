/**
 * P5 (t_d067a153): dispatched-vs-ingested reconciliation for batch plans.
 *
 * After a batch plan drains, `reconcilePlan` diffs the plan's dispatched set
 * against the checkpoint's completed entries and reports the gap - each source
 * that was dispatched but never recorded as ingested. It is a WARNING surface,
 * not a retry: it re-dispatches nothing, is read-only over checkpoint state, and
 * is idempotent. A fully completed plan reports an empty gap explicitly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { checkpointPath } from "../../../../src/core/brain/ingest/checkpoint.ts";
import { reconcilePlan } from "../../../../src/core/brain/ingest/reconcile.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const CAPS = { maxBatchBytes: 100_000, maxBatchFiles: 100 } as const;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reconcile-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reconcile-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function write(rel: string, content = "content\n"): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function ingest(rel: string, planId: string): void {
  ingestSource(
    vault,
    {
      sourcePath: rel,
      summary: `Summary of ${rel}.`,
      extraction: { entities: [{ category: "concept", name: rel }], relations: [] },
    },
    { agent: "claude", now: NOW, planId },
  );
}

describe("reconcilePlan", () => {
  test("names each dispatched source the checkpoint never recorded", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    const plan = planBatches(vault, "Docs", CAPS);
    ingest("Docs/a.md", plan.planId); // only a completes; b is lost

    const report = reconcilePlan(vault, plan);
    expect(report.planId).toBe(plan.planId);
    expect(report.dispatched).toEqual(["Docs/a.md", "Docs/b.md"]);
    expect(report.ingested).toEqual(["Docs/a.md"]);
    expect(report.missing).toEqual(["Docs/b.md"]);
    expect(report.complete).toBe(false);
  });

  test("a fully completed plan reports an empty gap explicitly", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    const plan = planBatches(vault, "Docs", CAPS);
    ingest("Docs/a.md", plan.planId);
    ingest("Docs/b.md", plan.planId);

    const report = reconcilePlan(vault, plan);
    expect(report.missing).toEqual([]);
    expect(report.complete).toBe(true);
  });

  test("a plan with no dispatched files reports a clean empty gap", () => {
    // No ingestible files under the dir -> nothing dispatched, nothing missing.
    write("Docs/notes.bin");
    const plan = planBatches(vault, "Docs", CAPS);
    const report = reconcilePlan(vault, plan);
    expect(report.dispatched).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.complete).toBe(true);
  });

  test("with no checkpoint every dispatched source is missing", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    const plan = planBatches(vault, "Docs", CAPS);
    const report = reconcilePlan(vault, plan);
    expect(report.missing).toEqual(["Docs/a.md", "Docs/b.md"]);
    expect(report.ingested).toEqual([]);
    expect(report.complete).toBe(false);
  });

  test("an already-ingested, all-unchanged plan reports complete", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    // Ingest both so the content manifest records them; a re-plan then
    // classifies every source `unchanged` (manifest skips), not new work.
    ingest("Docs/a.md", "seed-plan");
    ingest("Docs/b.md", "seed-plan");
    const plan = planBatches(vault, "Docs", CAPS);
    expect(plan.batches).toEqual([]); // nothing new to dispatch

    const report = reconcilePlan(vault, plan);
    // Manifest-confirmed unchanged sources are ingested, not a false gap.
    expect(report.ingested).toEqual(["Docs/a.md", "Docs/b.md"]);
    expect(report.missing).toEqual([]);
    expect(report.complete).toBe(true);
  });

  test("a fully-resumed plan counts checkpointed sources as ingested", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    const first = planBatches(vault, "Docs", CAPS);
    ingest("Docs/a.md", first.planId);
    ingest("Docs/b.md", first.planId);
    // Re-plan with --resume: checkpointed completions are dropped before
    // batches/skips are built, so the plan enumerates nothing itself.
    const resumed = planBatches(vault, "Docs", { ...CAPS, resume: true });

    const report = reconcilePlan(vault, resumed);
    expect(report.missing).toEqual([]);
    expect(report.complete).toBe(true);
  });

  test("is idempotent and read-only over checkpoint state", () => {
    write("Docs/a.md");
    write("Docs/b.md");
    const plan = planBatches(vault, "Docs", CAPS);
    ingest("Docs/a.md", plan.planId);

    const cpPath = checkpointPath(vault, plan.planId);
    expect(existsSync(cpPath)).toBe(true);
    const before = readFileSync(cpPath, "utf8");

    const first = reconcilePlan(vault, plan);
    const second = reconcilePlan(vault, plan);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The reconcile must not write, clear, or otherwise touch the checkpoint.
    expect(readFileSync(cpPath, "utf8")).toBe(before);
  });
});
