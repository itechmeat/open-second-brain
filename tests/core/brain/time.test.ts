/**
 * Wall-clock age measurement in the Brain time leaf (evidence-at-the-boundary,
 * unit B3).
 *
 * The formatter half of `src/core/brain/time.ts` (`isoSecond`, `isoDate`,
 * `compactRunStamp`, `relativeAge`) is covered by the legacy flat-named
 * `tests/core/brain.time.test.ts`. This file is the current directory-form
 * suite and owns the age surface added by B3: it is separate rather than
 * appended so the new surface lands under the naming convention new files
 * follow, and so the flat file can be retired later without touching these
 * assertions.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileAgeMs, msToWholeDays, MS_PER_DAY } from "../../../src/core/brain/time.ts";

/** Pinned clock; every expectation below is relative to this instant. */
const NOW_MS = Date.parse("2026-05-29T12:00:00Z");

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "o2b-time-"));
}

/** Write `name` under `dir` and force its mtime to `atMs`. */
function writeFileAged(dir: string, name: string, atMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const seconds = atMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

describe("MS_PER_DAY", () => {
  test("is one day in milliseconds", () => {
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});

describe("msToWholeDays", () => {
  test("counts completed days and truncates the partial one", () => {
    expect(msToWholeDays(3 * MS_PER_DAY)).toBe(3);
    expect(msToWholeDays(3 * MS_PER_DAY - 1)).toBe(2);
    expect(msToWholeDays(0)).toBe(0);
  });

  test("does not clamp a negative duration, so a skewed clock stays visible", () => {
    expect(msToWholeDays(-2 * MS_PER_DAY)).toBe(-2);
  });
});

describe("fileAgeMs", () => {
  test("measures a readable file against the injected clock", () => {
    const dir = makeTempDir();
    try {
      const path = writeFileAged(dir, "note.md", NOW_MS - 5 * MS_PER_DAY);
      expect(fileAgeMs(path, NOW_MS)).toBe(5 * MS_PER_DAY);
      expect(msToWholeDays(fileAgeMs(path, NOW_MS) ?? 0)).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns a negative age for a file stamped in the future", () => {
    const dir = makeTempDir();
    try {
      const path = writeFileAged(dir, "ahead.md", NOW_MS + MS_PER_DAY);
      expect(fileAgeMs(path, NOW_MS)).toBe(-MS_PER_DAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for a path that does not exist", () => {
    const dir = makeTempDir();
    try {
      expect(fileAgeMs(join(dir, "absent.md"), NOW_MS)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for a file that exists but cannot be stat'ed", () => {
    const dir = makeTempDir();
    // A file is unstattable when its PARENT denies traversal, which is the
    // portable POSIX construction: removing every mode bit from the
    // directory makes `statSync` on a child fail EACCES while the child
    // itself still exists and is a different condition from absence.
    const denied = mkdtempSync(join(dir, "denied-"));
    const victim = join(denied, "victim.md");
    try {
      writeFileSync(victim, "x");
      chmodSync(denied, 0o000);
      let reachable = true;
      try {
        statSync(victim);
      } catch {
        reachable = false;
      }
      // Root ignores the mode bits, so the construction only bites for an
      // unprivileged uid. Assert the real thing when it holds and say
      // plainly why it does not when it cannot, rather than faking it.
      if (reachable) {
        expect(process.getuid?.()).toBe(0);
      } else {
        expect(fileAgeMs(victim, NOW_MS)).toBeNull();
      }
    } finally {
      chmodSync(denied, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
