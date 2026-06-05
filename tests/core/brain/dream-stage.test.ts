/**
 * Staged dream pipeline, stage half (t_ae8a8ec0): `stageDream` runs
 * the existing engine in dry-run mode and persists a discardable
 * proposal bundle under `Brain/dream/staged/<run-id>/` - manifest,
 * human-readable report, scanned sources, and the planned mutations
 * as data. The plan projection is clock-normalized (no run ids, no
 * timestamps), so two stages over an unchanged vault project the
 * same plan byte for byte.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DREAM_STAGE_SCHEMA_VERSION,
  listDreamBundles,
  stageDream,
} from "../../../src/core/brain/dream-stage.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-05T12:00:00Z");

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-stage-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedCluster(topic: string): void {
  for (const i of [1, 2, 3]) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Rule for ${topic}.`,
      created_at: "2026-06-01T10:00:00Z",
      date: "2026-06-01",
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

describe("stageDream", () => {
  test("persists a complete bundle and mutates nothing", () => {
    seedCluster("stage-rules");
    const bundle = stageDream(vault, { now: NOW });

    const dir = join(vault, "Brain", "dream", "staged", bundle.runId);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "REPORT.md"))).toBe(true);
    expect(existsSync(join(dir, "sources.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "proposals.jsonl"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.schema).toBe(DREAM_STAGE_SCHEMA_VERSION);
    expect(manifest.run_id).toBe(bundle.runId);
    expect(manifest.staged_at).toBe("2026-06-05T12:00:00Z");
    expect(manifest.sources).toBe(3);
    expect(typeof manifest.plan_hash).toBe("string");

    // Staging is read-only: the cluster must still sit in the inbox.
    expect(bundle.plan.new_unconfirmed).toEqual(["pref-stage-rules"]);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-stage-rules.md"))).toBe(false);

    // The report names the planned promotion.
    const report = readFileSync(join(dir, "REPORT.md"), "utf8");
    expect(report).toContain("stage-rules");

    // Sources carry content hashes for provenance.
    const sources = readFileSync(join(dir, "sources.jsonl"), "utf8").trim().split("\n");
    expect(sources).toHaveLength(3);
    for (const line of sources) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.path).toBe("string");
      expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the plan projection is stable across two stages of an unchanged vault", () => {
    seedCluster("stable-topic");
    const first = stageDream(vault, { now: new Date("2026-06-05T12:00:00Z") });
    const second = stageDream(vault, { now: new Date("2026-06-05T13:30:00Z") });
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
    expect(first.runId).not.toBe(second.runId);
  });

  test("listDreamBundles surfaces staged bundles newest-first", () => {
    seedCluster("list-topic");
    stageDream(vault, { now: new Date("2026-06-05T12:00:00Z") });
    stageDream(vault, { now: new Date("2026-06-05T12:05:00Z") });
    const bundles = listDreamBundles(vault);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.status).toBe("staged");
    expect(bundles[0]!.stagedAt >= bundles[1]!.stagedAt).toBe(true);
  });

  test("an empty vault stages an empty plan without error", () => {
    const bundle = stageDream(vault, { now: NOW });
    expect(bundle.plan.changed).toBe(false);
    expect(bundle.plan.new_unconfirmed).toEqual([]);
  });
});
