/**
 * Materialize-freshness gate (evidence-at-the-boundary, unit B4).
 *
 * Two expectations in this suite changed with the three-state verdict,
 * and both changed because the old boolean had no way to say "I could
 * not measure that":
 *
 *   - inputs listed but unreadable used to be pinned as FRESH. That is
 *     a measurement failure being reported as "outputs are up to date,
 *     skip the recompute", and the sole caller hands in the whole vault
 *     page list, so a walk that returned nothing readable read as a
 *     clean bill of health.
 *   - outputs listed but unreadable used to be stale-with-no-reason,
 *     indistinguishable from "nothing has been materialized yet".
 *
 * Both are now `unknown` with a named reason. The empty-list case is
 * deliberately NOT unknown: an empty list is an answer, an unreadable
 * member is not.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  evaluateStaleness,
  MATERIALIZE_FRESHNESS,
  MATERIALIZE_STALE_REASON,
  MATERIALIZE_UNKNOWN_REASON,
  stalenessReason,
} from "../../../src/core/brain/staleness.ts";
import { MS_PER_DAY } from "../../../src/core/brain/time.ts";

function setup(): string {
  return mkdtempSync(join(tmpdir(), "o2b-staleness-"));
}

/** Write a file and stamp its mtime to a fixed epoch-second. */
function writeAt(path: string, atSec: number): void {
  writeFileSync(path, "x", "utf8");
  utimesSync(path, atSec, atSec);
}

/**
 * A path that a directory walk WILL list and a stat WILL refuse: a
 * symlink to a file that does not exist. Chosen over a chmod-0
 * directory because that is a no-op for a test process running as root.
 */
function unreadable(dir: string, name: string): string {
  const path = join(dir, name);
  symlinkSync(join(dir, "does-not-exist"), path);
  return path;
}

describe("evaluateStaleness", () => {
  test("no outputs at all is stale for the not-materialized reason", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      writeAt(input, 1000);
      const res = evaluateStaleness([input], []);
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.stale);
      expect(stalenessReason(res)).toBe(MATERIALIZE_STALE_REASON.notMaterialized);
      expect(res.oldestOutputMs).toBeNull();
      expect(res.oldestOutputAgeMs).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an output newer than every input, inside the ceiling, is fresh", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      const res = evaluateStaleness([input], [output], {
        nowMs: 2000 * 1000 + MS_PER_DAY,
        maxAgeMs: 30 * MS_PER_DAY,
      });
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.fresh);
      expect(stalenessReason(res)).toBeNull();
      expect(res.newestInputMs).toBe(1000 * 1000);
      expect(res.oldestOutputMs).toBe(2000 * 1000);
      expect(res.oldestOutputAgeMs).toBe(MS_PER_DAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an input newer than the oldest output is stale for the input-newer reason", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(output, 1000);
      writeAt(input, 2000);
      const res = evaluateStaleness([input], [output]);
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.stale);
      expect(stalenessReason(res)).toBe(MATERIALIZE_STALE_REASON.inputNewer);
      expect(res.newestInputMs).toBe(2000 * 1000);
      expect(res.oldestOutputMs).toBe(1000 * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no inputs listed at all, with outputs present, is fresh", () => {
    const dir = setup();
    try {
      const output = join(dir, "out.md");
      writeAt(output, 1000);
      // Unchanged by this unit, and the boundary is the point: an EMPTY
      // list is an answer ("nothing could have changed"), whereas a
      // non-empty list with nothing measurable in it is a failed
      // measurement. The caller owns the difference, because only the
      // caller knows how the list was produced.
      expect(evaluateStaleness([], [output]).state).toBe(MATERIALIZE_FRESHNESS.fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inputs listed but unreadable is unknown, not fresh", () => {
    const dir = setup();
    try {
      const output = join(dir, "out.md");
      writeAt(output, 2000);
      // Expectation changed (was: fresh). An input whose mtime cannot be
      // read might be the newest thing in the vault; reporting fresh
      // here is the caller skipping a recompute on the strength of a
      // measurement that never happened.
      const res = evaluateStaleness([unreadable(dir, "gone.md")], [output]);
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.unknown);
      expect(stalenessReason(res)).toBe(MATERIALIZE_UNKNOWN_REASON.inputsUnreadable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one unreadable input among readable ones is still unknown", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      const res = evaluateStaleness([input, unreadable(dir, "gone.md")], [output]);
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.unknown);
      expect(stalenessReason(res)).toBe(MATERIALIZE_UNKNOWN_REASON.inputsUnreadable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outputs listed but unreadable is unknown, not stale", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      writeAt(input, 1000);
      // Expectation changed (was: stale with no reason, i.e. the same
      // answer as "nothing materialized yet"). An output that exists but
      // will not stat is not an absent output.
      const res = evaluateStaleness([input], [unreadable(dir, "out.md")]);
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.unknown);
      expect(stalenessReason(res)).toBe(MATERIALIZE_UNKNOWN_REASON.outputsUnreadable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable output outranks an unreadable input", () => {
    const dir = setup();
    try {
      // Both sides failed to measure; the output side is reported
      // because it is the side that decides whether anything usable was
      // materialized at all.
      const res = evaluateStaleness([unreadable(dir, "in.md")], [unreadable(dir, "out.md")]);
      expect(stalenessReason(res)).toBe(MATERIALIZE_UNKNOWN_REASON.outputsUnreadable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an output older than the ceiling, with no input moved, is stale", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      const res = evaluateStaleness([input], [output], {
        nowMs: 2000 * 1000 + 31 * MS_PER_DAY,
        maxAgeMs: 30 * MS_PER_DAY,
      });
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.stale);
      expect(stalenessReason(res)).toBe(MATERIALIZE_STALE_REASON.ceilingExceeded);
      expect(res.oldestOutputAgeMs).toBe(31 * MS_PER_DAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an age exactly at the ceiling has not exceeded it", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      const res = evaluateStaleness([input], [output], {
        nowMs: 2000 * 1000 + 30 * MS_PER_DAY,
        maxAgeMs: 30 * MS_PER_DAY,
      });
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent ceiling leaves an ancient output fresh", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(input, 1000);
      writeAt(output, 2000);
      // The ceiling is resolved from config by the caller, never
      // defaulted inside this module: omitting it must reproduce the
      // pre-ceiling behaviour exactly.
      const res = evaluateStaleness([input], [output], { nowMs: 2000 * 1000 + 3650 * MS_PER_DAY });
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a moved input outranks an exceeded ceiling", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      const output = join(dir, "out.md");
      writeAt(output, 1000);
      writeAt(input, 2000);
      // Both make it stale; the moved input is the actionable cause and
      // the one an operator can do something about.
      const res = evaluateStaleness([input], [output], {
        nowMs: 2000 * 1000 + 3650 * MS_PER_DAY,
        maxAgeMs: MS_PER_DAY,
      });
      expect(stalenessReason(res)).toBe(MATERIALIZE_STALE_REASON.inputNewer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable output outranks an exceeded ceiling", () => {
    const dir = setup();
    try {
      const input = join(dir, "in.md");
      writeAt(input, 1000);
      const res = evaluateStaleness([input], [unreadable(dir, "out.md")], {
        nowMs: 2000 * 1000 + 3650 * MS_PER_DAY,
        maxAgeMs: MS_PER_DAY,
      });
      expect(res.state).toBe(MATERIALIZE_FRESHNESS.unknown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
