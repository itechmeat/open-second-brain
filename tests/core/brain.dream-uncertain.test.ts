/**
 * v0.10.16: `DreamRunSummary` gains `uncertain` and `quarantined`
 * arrays. This atom commit only asserts both fields are present and
 * empty on every dream-pass return path; populating them lands in
 * the consumer commit that wires self-approval-guardrail into the
 * pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-uncertain-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("DreamRunSummary uncertain + quarantined atoms", () => {
  test("no-op run returns both arrays empty", () => {
    const res = dream(vault);
    expect(res.changed).toBe(false);
    expect(res.uncertain).toEqual([]);
    expect(res.quarantined).toEqual([]);
  });

  test("dry-run no-op also has empty atoms", () => {
    const res = dream(vault, { dryRun: true });
    expect(res.uncertain).toEqual([]);
    expect(res.quarantined).toEqual([]);
  });

  test("frozen result and nested arrays cannot mutate", () => {
    const res = dream(vault);
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.uncertain)).toBe(true);
    expect(Object.isFrozen(res.quarantined)).toBe(true);
  });
});
