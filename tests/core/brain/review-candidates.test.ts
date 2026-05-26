/**
 * `buildReviewCandidates` - read-only projection over what the next
 * dream pass would do. The helper drives `dream({ dryRun: true })`
 * so no persistent state mutates between invocations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { dreamRunsDir } from "../../../src/core/brain/paths.ts";
import { buildReviewCandidates } from "../../../src/core/brain/review-candidates.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rc-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rc-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("buildReviewCandidates", () => {
  test("returns a frozen report with all six top-level fields", () => {
    const r = buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Array.isArray(r.would_create)).toBe(true);
    expect(Array.isArray(r.would_promote)).toBe(true);
    expect(Array.isArray(r.would_retire)).toBe(true);
    expect(Array.isArray(r.would_supersede)).toBe(true);
    expect(Array.isArray(r.clusters_below_threshold)).toBe(true);
    expect(Array.isArray(r.gated_retires)).toBe(true);
  });

  test("returns empty arrays on a fresh-bootstrap vault", () => {
    const r = buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(r.would_create).toEqual([]);
    expect(r.would_promote).toEqual([]);
    expect(r.would_retire).toEqual([]);
    expect(r.would_supersede).toEqual([]);
    expect(r.clusters_below_threshold).toEqual([]);
    expect(r.gated_retires).toEqual([]);
  });

  test("does NOT create a workrun file (dry-run path)", () => {
    buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    const dir = dreamRunsDir(vault);
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      expect(entries).toEqual([]);
    }
  });

  test("invoked twice in a row produces identical output (idempotent)", () => {
    const a = buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    const b = buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
