/**
 * Pure `_brain.yaml` transform behind `o2b brain health-baseline`. The
 * writer must upsert or remove ONLY the `silence_before` line, leaving
 * every other block and key byte-for-byte intact, and the result must
 * always re-parse through the real config loader.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyHealthSilenceBeforeToYaml,
  writeHealthBaseline,
} from "../../../src/core/brain/health-baseline.ts";
import { loadBrainConfig, resolveHealth } from "../../../src/core/brain/policy.ts";
import { withFileLock } from "../../../src/core/reliability/lock.ts";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";

const BASE = "schema_version: 1\n\nvault:\n  ignore_paths:\n    - .git\n";

function silenceOf(text: string): unknown {
  const parsed = parseBrainYaml(text) as Record<string, Record<string, unknown>>;
  return parsed["health"]?.["silence_before"];
}

describe("applyHealthSilenceBeforeToYaml", () => {
  test("appends a health block when none exists", () => {
    const out = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    expect(silenceOf(out)).toBe("2026-01-01");
    // The pre-existing vault block is untouched.
    expect(out).toContain("vault:\n  ignore_paths:\n    - .git");
  });

  test("upserts into an existing health block without disturbing siblings", () => {
    const withBlock = `${BASE}\nhealth:\n  concept_gap_min_frequency: 5\n`;
    const out = applyHealthSilenceBeforeToYaml(withBlock, "2026-02-02");
    expect(silenceOf(out)).toBe("2026-02-02");
    const parsed = parseBrainYaml(out) as Record<string, Record<string, unknown>>;
    expect(parsed["health"]?.["concept_gap_min_frequency"]).toBe(5);
  });

  test("replaces an existing silence_before line rather than duplicating it", () => {
    const first = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    const second = applyHealthSilenceBeforeToYaml(first, "2026-09-09");
    expect(silenceOf(second)).toBe("2026-09-09");
    expect(second.match(/silence_before/g)?.length).toBe(1);
  });

  test("clearing removes the line and the now-empty header it created", () => {
    const set = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    const cleared = applyHealthSilenceBeforeToYaml(set, null);
    expect(silenceOf(cleared)).toBeUndefined();
    expect(cleared).not.toContain("health:");
  });

  test("clearing keeps a health block that still has other keys", () => {
    const withBlock = `${BASE}\nhealth:\n  concept_gap_min_frequency: 5\n  silence_before: "2026-01-01"\n`;
    const cleared = applyHealthSilenceBeforeToYaml(withBlock, null);
    expect(silenceOf(cleared)).toBeUndefined();
    const parsed = parseBrainYaml(cleared) as Record<string, Record<string, unknown>>;
    expect(parsed["health"]?.["concept_gap_min_frequency"]).toBe(5);
  });

  test("clearing an absent watermark is a no-op", () => {
    expect(applyHealthSilenceBeforeToYaml(BASE, null)).toBe(BASE);
  });
});

/**
 * `writeHealthBaseline` upserts `_brain.yaml` under the same `withFileLock`
 * convention `schema-mutate.ts` uses. Without it, a concurrent writer's
 * read-modify-write can interleave with this one and one side's edit is
 * silently lost. These tests exercise the real file on disk (not the pure
 * transform above) to prove the lock actually serializes the two writers.
 */
describe("writeHealthBaseline locking", () => {
  function makeVault(): { tmp: string; vault: string; configPath: string } {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-health-baseline-lock-"));
    const vault = join(tmp, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const configPath = join(vault, "Brain", "_brain.yaml");
    writeFileSync(configPath, "schema_version: 1\n\nhealth:\n  concept_gap_min_frequency: 3\n");
    return { tmp, vault, configPath };
  }

  test("serializes against a concurrent _brain.yaml writer instead of losing an update", async () => {
    const { tmp, vault, configPath } = makeVault();
    try {
      const events: string[] = [];

      // Stand-in for another writer of _brain.yaml (e.g. schema-mutate.ts):
      // takes the same lock, holds it briefly, then edits an unrelated line
      // via a plain read-modify-write (no atomic rename needed for the test -
      // only the locking matters here).
      const competitor = withFileLock(configPath, { staleMs: 30_000, retries: 3 }, async () => {
        events.push("competitor-start");
        const before = readFileSync(configPath, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 40));
        writeFileSync(configPath, `${before}\nnote: unrelated\n`);
        events.push("competitor-end");
      });

      // Give the competitor a head start so it holds the lock first; without
      // the fix, writeHealthBaseline would instead race straight in and one
      // of the two edits would be overwritten.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const baseline = writeHealthBaseline(vault, "2026-03-03").then(() => {
        events.push("baseline-done");
      });

      await Promise.all([competitor, baseline]);

      expect(events).toEqual(["competitor-start", "competitor-end", "baseline-done"]);

      const finalText = readFileSync(configPath, "utf8");
      expect(finalText).toContain("note: unrelated");
      const resolved = resolveHealth(loadBrainConfig(vault));
      expect(resolved.silence_before).toBe("2026-03-03");
      expect(resolved.concept_gap_min_frequency).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("two concurrent writeHealthBaseline calls serialize to a single, uncorrupted line", async () => {
    const { tmp, vault, configPath } = makeVault();
    try {
      await Promise.all([
        writeHealthBaseline(vault, "2026-04-04"),
        writeHealthBaseline(vault, "2026-05-05"),
      ]);

      const finalText = readFileSync(configPath, "utf8");
      // Exactly one writer's line survives - never a torn or duplicated one.
      expect(finalText.match(/silence_before/g)?.length).toBe(1);
      const resolved = resolveHealth(loadBrainConfig(vault));
      expect(resolved.silence_before).not.toBeNull();
      expect(["2026-04-04", "2026-05-05"]).toContain(resolved.silence_before as string);
      expect(resolved.concept_gap_min_frequency).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
