import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluateStaleness } from "../../../src/core/brain/staleness.ts";

function setup(): string {
  return mkdtempSync(join(tmpdir(), "o2b-staleness-"));
}

/** Write a file and stamp its mtime to a fixed epoch-second. */
function writeAt(path: string, atSec: number): void {
  writeFileSync(path, "x", "utf8");
  utimesSync(path, atSec, atSec);
}

describe("evaluateStaleness", () => {
  test("no outputs is never fresh (nothing materialized yet)", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      writeAt(input, 1000);
      const res = evaluateStaleness([input], []);
      expect(res.fresh).toBe(false);
      expect(res.oldestOutputMs).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh when every output is at least as new as every input", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      expect(evaluateStaleness([input], [output]).fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale when any input is newer than the oldest output", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(output, 1000);
      writeAt(input, 2000);
      const res = evaluateStaleness([input], [output]);
      expect(res.fresh).toBe(false);
      expect(res.newestInputMs).toBe(2000 * 1000);
      expect(res.oldestOutputMs).toBe(1000 * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no inputs with existing outputs is fresh (nothing to be stale against)", () => {
    const dir = setup();
    try {
      const output = join(dir, "out.md");
      writeAt(output, 1000);
      expect(evaluateStaleness([], [output]).fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable paths are ignored, not treated as newest", () => {
    const dir = setup();
    try {
      const output = join(dir, "out.md");
      writeAt(output, 2000);
      // A missing input path contributes no mtime.
      const res = evaluateStaleness([join(dir, "gone.md")], [output]);
      expect(res.fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
