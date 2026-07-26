/**
 * Dream tells the truth about its own progress (no-dead-ends, Unit E).
 *
 * Three properties are pinned here:
 *
 *   1. The workrun journal never claims a phase complete whose durable
 *      output has not landed. A run interrupted mid-write leaves a last
 *      marker naming work that genuinely finished.
 *   2. The safeguard checkpoint the `DreamOptions` docstring promises
 *      before finalize actually exists, so the log writes / ledger write /
 *      snapshot pruning / digest regeneration tail is no longer unguarded.
 *   3. A per-run gate override applies for exactly one run and never
 *      touches the stored configuration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { brainDirs, dreamRunsDir } from "../../../src/core/brain/paths.ts";
import { SafeguardTimeoutError, type Safeguard } from "../../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

const NOW = new Date("2026-05-23T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-ckpt-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-ckpt-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  // A test that locked a directory to inject a write failure restores the
  // mode itself; belt-and-braces so a failed assertion cannot leave an
  // unremovable tree behind.
  const prefs = brainDirs(vault).preferences;
  if (existsSync(prefs)) chmodSync(prefs, 0o700);
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Three same-sign signals on one topic: enough to plan a promotion. */
function seedPromotion(target: string = vault, topic = "ckpt-topic"): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(target, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Prefer the ${topic} approach`,
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

function workrunPhases(): string[] {
  const dir = dreamRunsDir(vault);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  if (files.length === 0) return [];
  return readFileSync(join(dir, files[0]!), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { phase: string }).phase);
}

/**
 * Counting safeguard. `tripAt` is the 1-based index of the checkpoint
 * that throws; `null` never trips. Distinct from the shared
 * `createSafeguard` helper because these tests care about WHICH
 * checkpoint fires, not about a wall clock.
 */
function countingGuard(tripAt: number | null): { guard: Safeguard; calls: () => number } {
  let calls = 0;
  const guard: Safeguard = Object.freeze({
    operation: "dream",
    timeoutMs: null,
    checkpoint: (): void => {
      calls += 1;
      if (tripAt !== null && calls === tripAt) throw new SafeguardTimeoutError("dream", 1);
    },
  });
  return { guard, calls: () => calls };
}

/**
 * Excluded from the byte-comparison digest: the snapshot archive and the
 * workrun journal carry wall-clock stamps, and the two bootstrap identity
 * artifacts embed the vault's own path / generated id. None of the four is
 * dream output; everything else in the tree is compared byte for byte.
 */
const DIGEST_EXCLUSIONS: ReadonlyArray<string> = Object.freeze([
  join("Brain", ".snapshots"),
  join("Brain", "log", "dream-runs"),
  join("Brain", "_BRAIN.md"),
  join("Brain", "vault-id.json"),
]);

/** Recursive `<relative path>:<sha256>` digest of a tree, sorted. */
function treeDigest(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (DIGEST_EXCLUSIONS.some((v) => rel === v || rel.startsWith(`${v}/`))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else lines.push(`${rel}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return lines.join("\n");
}

/** Drop the two absolute-path fields so two vaults compare structurally. */
function withoutVaultPaths(summary: object): Record<string, unknown> {
  const { snapshot_path: _snapshot, log_path: _log, ...rest } = summary as Record<string, unknown>;
  return rest;
}

/** A linkable page plus a page mentioning it: the heal-enrichment fixture. */
function makeNotes(target: string = vault): { refPath: string } {
  const notes = join(target, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "Acme.md"), "---\ntitle: Acme\n---\nThe Acme page.\n", "utf8");
  const refPath = join(notes, "ref.md");
  writeFileSync(refPath, "---\ntitle: Ref\n---\nwe rely on Acme daily\n", "utf8");
  return { refPath };
}

// ----- 1. Truthful workrun checkpoints -------------------------------------

describe("dream workrun checkpoints are truthful", () => {
  test("a run interrupted mid-write claims only work that genuinely completed", () => {
    seedPromotion();
    const prefs = brainDirs(vault).preferences;
    // Inject the failure between close and synthesize: the preferences
    // directory is read-only, so the first preference write throws and the
    // run dies with the mutation loops half-run.
    chmodSync(prefs, 0o555);
    try {
      expect(() => dream(vault, { now: NOW })).toThrow();
    } finally {
      chmodSync(prefs, 0o700);
    }

    const phases = workrunPhases();
    // Only the phases whose durable output was already on disk may appear.
    expect(phases).toEqual(["started", "cluster_complete", "close_complete"]);
    // Every marker for work that never ran must be absent - most sharply
    // `reconcile_complete`, whose audit events are written in the log phase
    // this run never reached.
    for (const absent of [
      "reconcile_complete",
      "promote_complete",
      "synthesize_complete",
      "retire_complete",
      "heal_complete",
      "finalized",
    ]) {
      expect(phases).not.toContain(absent);
    }
  });

  test("a complete run records every phase, reconcile after its audit events", () => {
    seedPromotion();
    dream(vault, { now: NOW });
    expect(workrunPhases()).toEqual([
      "started",
      "cluster_complete",
      "close_complete",
      "promote_complete",
      "synthesize_complete",
      "retire_complete",
      "heal_complete",
      "reconcile_complete",
      "finalized",
    ]);
  });
});

// ----- 2. The pre-finalize safeguard checkpoint -----------------------------

describe("dream safeguard checkpoints", () => {
  test("a changed run checkpoints five times, the last before finalize", () => {
    seedPromotion();
    const { guard, calls } = countingGuard(null);
    dream(vault, { now: NOW, safeguard: guard });
    expect(calls()).toBe(5);
  });

  test("the pre-finalize checkpoint fires and leaves the workrun dangling", () => {
    seedPromotion();
    const { guard } = countingGuard(5);
    expect(() => dream(vault, { now: NOW, safeguard: guard })).toThrow(SafeguardTimeoutError);
    const phases = workrunPhases();
    // The tail is covered: every mutation landed, the journal recorded it,
    // and the run stopped before claiming a clean finish.
    expect(phases).toContain("heal_complete");
    expect(phases).not.toContain("finalized");
    expect(existsSync(join(brainDirs(vault).preferences, "pref-ckpt-topic.md"))).toBe(true);
  });

  test("a no-op run checkpoints once, at entry", () => {
    const { guard, calls } = countingGuard(null);
    const summary = dream(vault, { now: NOW, safeguard: guard });
    expect(summary.changed).toBe(false);
    expect(calls()).toBe(1);
  });
});

// ----- 3. Per-run gate override --------------------------------------------

describe("dream per-run gate override", () => {
  test("heal_enrich overrides a disabled config gate for one run only", () => {
    const { refPath } = makeNotes();
    seedPromotion();
    const cfgPath = join(vault, "Brain", "_brain.yaml");
    const cfgBefore = readFileSync(cfgPath);

    dream(vault, { now: NOW, gates: { heal_enrich: true } });

    expect(readFileSync(refPath, "utf8")).toContain("[[Acme]]");
    // The stored configuration is byte-identical: the override never
    // persists, so nothing has to be remembered and reverted.
    expect(readFileSync(cfgPath)).toEqual(cfgBefore);
  });

  test("heal_enrich: false overrides an enabled config gate", () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ndream:\n  heal_enrich_enabled: true\n",
      "utf8",
    );
    const { refPath } = makeNotes();
    seedPromotion();
    const before = readFileSync(refPath, "utf8");

    const summary = dream(vault, { now: NOW, gates: { heal_enrich: false } });

    expect(summary.changed).toBe(true);
    expect(readFileSync(refPath, "utf8")).toBe(before);
    expect(summary.phases.find((p) => p.phase === "heal")?.metrics["enriched"]).toBe(0);
  });

  test("an omitted override leaves the run byte-identical to the config path", () => {
    const { refPath } = makeNotes();
    seedPromotion();
    const summary = dream(vault, { now: NOW });
    const digest = treeDigest(vault);
    const untouched = readFileSync(refPath, "utf8");

    // A second, identically seeded vault run with the override set to the
    // value the config already resolves to: identical tree, identical
    // summary bar the vault-dependent paths.
    const twin = mkdtempSync(join(tmpdir(), "o2b-dream-ckpt-twin-"));
    const twinConfig = join(configHome, "twin.yaml");
    try {
      atomicWriteFileSync(twinConfig, `vault: ${twin}\n`);
      bootstrapBrain(twin, { configPath: twinConfig });
      const { refPath: twinRef } = makeNotes(twin);
      seedPromotion(twin);
      const twinSummary = dream(twin, { now: NOW, gates: { heal_enrich: false } });

      expect(treeDigest(twin)).toBe(digest);
      expect(withoutVaultPaths(twinSummary)).toEqual(withoutVaultPaths(summary));
      expect(readFileSync(twinRef, "utf8")).toBe(untouched);
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
  });
});
