/**
 * Multi-phase dream pipeline (Brain lifecycle suite, Feature 2).
 *
 * A changed dream run names its seams as ordered phases - close,
 * reconcile, synthesize, heal, log - emitting one workrun checkpoint
 * per phase and a structured `phases` summary. A no-op run stays a true
 * no-op: empty `phases`, no workrun. The proven dream internals are
 * unchanged; this only adds observable phase structure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { dreamRunsDir } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-phases-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-phases-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seed(slug: string, date: string): void {
  writeSignal(vault, {
    topic: "phase-topic",
    signal: "positive",
    agent: "claude",
    principle: "Prefer the phased approach",
    created_at: `${date}T10:00:00Z`,
    date,
    slug,
    scope: "writing",
  });
}

function workrunPhases(): string[] {
  const dir = dreamRunsDir(vault);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  if (files.length === 0) return [];
  const text = readFileSync(join(dir, files[0]!), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { phase: string }).phase);
}

describe("dream multi-phase pipeline", () => {
  test("a changed run returns the ordered phase summaries", () => {
    seed("phase-topic-a", "2026-05-20");
    seed("phase-topic-b", "2026-05-21");
    seed("phase-topic-c", "2026-05-22");
    const summary = dream(vault, { now: new Date("2026-05-23T12:00:00Z") });
    expect(summary.changed).toBe(true);
    expect(summary.phases.map((p) => p.phase)).toEqual([
      "close",
      "reconcile",
      "synthesize",
      "heal",
      "log",
    ]);
    const synth = summary.phases.find((p) => p.phase === "synthesize");
    expect(synth?.metrics["new_unconfirmed"]).toBe(1);
  });

  test("a changed run emits ordered phase checkpoints in the workrun", () => {
    seed("phase-topic-a", "2026-05-20");
    seed("phase-topic-b", "2026-05-21");
    seed("phase-topic-c", "2026-05-22");
    dream(vault, { now: new Date("2026-05-23T12:00:00Z") });
    const phases = workrunPhases();
    // The new phase checkpoints appear in order between started/finalized.
    const ordered = phases.filter((p) =>
      ["close_complete", "reconcile_complete", "synthesize_complete", "heal_complete"].includes(p),
    );
    expect(ordered).toEqual([
      "close_complete",
      "reconcile_complete",
      "synthesize_complete",
      "heal_complete",
    ]);
  });

  test("a no-op run returns empty phases and writes no workrun", () => {
    const summary = dream(vault, { now: new Date("2026-05-23T12:00:00Z") });
    expect(summary.changed).toBe(false);
    expect(summary.phases).toEqual([]);
    expect(existsSync(dreamRunsDir(vault))).toBe(false);
  });
});
