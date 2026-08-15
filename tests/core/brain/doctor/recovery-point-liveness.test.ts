/**
 * A durability check that reports LIVENESS, and says so.
 *
 * The obvious shape - "is the durability job registered, and did it run" -
 * has no referent in this product. Nothing here registers a scheduled job:
 * every cron surface in the tree is a recipe RENDERER that prints text for
 * the operator's own scheduler and writes nothing, so there is no record
 * whose presence could be looked up. Presence is therefore unobservable,
 * and the only thing that can be measured is the age of the artifacts a
 * durability pass leaves behind.
 *
 * That is not a limitation to be papered over - a check that reported
 * "durability job missing" would be inventing a fact - so it is stated in
 * the finding's own message, and this file asserts that it is.
 *
 * The three states the check can be in are the three answers
 * `listSnapshots` already distinguishes: an absent directory is an empty
 * history (a real answer), a populated one is a measurable one, and a
 * directory that IS there and cannot be enumerated is neither.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import {
  RECOVERY_POINT_LIVENESS_WINDOW_DAYS,
  RECOVERY_POINT_STALE_CODE,
  RECOVERY_POINT_UNMEASURED_CODE,
  recoveryPointLivenessCheck,
  SCHEDULE_UNOBSERVABLE_CLAUSE,
} from "../../../../src/core/brain/doctor/recovery-point-liveness.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { SNAPSHOT_ARCHIVE_SUFFIX, snapshotsDir } from "../../../../src/core/brain/paths.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

let vault: string;

/** Pinned so every age below is arithmetic rather than wall clock. */
const NOW = new Date("2026-06-01T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recovery-liveness-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  try {
    chmodSync(snapshotsDir(vault), 0o700);
  } catch {
    // The directory may never have been created; nothing to restore.
  }
  rmSync(vault, { recursive: true, force: true });
});

/** An archive named `runId`, stamped `daysAgo` before the pinned clock. */
function archive(runId: string, daysAgo: number): void {
  const dir = snapshotsDir(vault);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}${SNAPSHOT_ARCHIVE_SUFFIX}`);
  writeFileSync(path, "not-a-real-archive");
  const at = new Date(NOW.getTime() - daysAgo * MS_PER_DAY);
  utimesSync(path, at, at);
}

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(now: Date = NOW): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  recoveryPointLivenessCheck.run({ vault, now } as unknown as DoctorCheckContext, {
    issues,
    uncertain,
  });
  return { issues, uncertain };
}

function stale(result: RunResult): ReadonlyArray<DoctorIssue> {
  return result.issues.filter((i) => i.code === RECOVERY_POINT_STALE_CODE);
}

describe("recovery-point liveness", () => {
  test("the check never fails the pass", () => {
    expect(recoveryPointLivenessCheck.failSoft).toBe(true);
  });

  test("a vault with no recovery point at all reports nothing", () => {
    // No archive exists because no state-changing pass has ever run.
    // There is no schedule to have missed and no artifact to be stale,
    // so inventing a finding here would be inventing the expectation.
    const result = run();
    expect(stale(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("a recent recovery point is clean", () => {
    archive("dream-20260530T000000Z", 2);
    const result = run();
    expect(stale(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("a recovery point older than the window is a warning naming its age", () => {
    const age = RECOVERY_POINT_LIVENESS_WINDOW_DAYS + 7;
    archive("dream-20260101T000000Z", age);
    const issues = stale(run());
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain(String(age));
    expect(issues[0]!.message).toContain(String(RECOVERY_POINT_LIVENESS_WINDOW_DAYS));
  });

  test("the warning states that schedule PRESENCE was not checked", () => {
    archive("dream-20260101T000000Z", RECOVERY_POINT_LIVENESS_WINDOW_DAYS + 1);
    // The whole reason the check reports liveness only: nothing in this
    // tool registers a scheduled job, so a silent schedule and no
    // schedule at all leave identical evidence. The finding says so
    // rather than letting the reader assume it checked.
    expect(stale(run())[0]!.message).toContain(SCHEDULE_UNOBSERVABLE_CLAUSE);
  });

  test("the NEWEST recovery point decides, not the oldest", () => {
    archive("dream-20260101T000000Z", RECOVERY_POINT_LIVENESS_WINDOW_DAYS + 100);
    archive("dream-20260531T000000Z", 1);
    expect(stale(run())).toEqual([]);
  });

  test("a history whose ONLY archive cannot be stat'ed is uncertain, not an empty history", () => {
    // The directory is populated and enumerable; the archive inside it is
    // not readable by this user - the shape a vault synced with preserved
    // ownership takes. Reporting "no state-changing pass has ever run"
    // here is the silence this check exists to remove.
    const dir = snapshotsDir(vault);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, "nothing-here.tar.zst"), join(dir, `dangling${SNAPSHOT_ARCHIVE_SUFFIX}`));

    const result = run();
    expect(stale(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === RECOVERY_POINT_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("dangling");
    expect(entry!.message).toContain(SCHEDULE_UNOBSERVABLE_CLAUSE);
  });

  test("an unreadable archive beside a readable one is reported alongside the age", () => {
    // The measured age is the newest READABLE archive's, and the entry
    // nobody could stat may be newer - so the number is an upper bound and
    // the reader is told the listing was partial.
    archive("dream-20260531T000000Z", 1);
    const dir = snapshotsDir(vault);
    symlinkSync(join(dir, "nothing-here.tar.zst"), join(dir, `dangling${SNAPSHOT_ARCHIVE_SUFFIX}`));

    const result = run();
    const entry = result.uncertain.find((e) => e.code === RECOVERY_POINT_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("dangling");
  });

  test("an archive whose run id does not validate is named, not swallowed", () => {
    const dir = snapshotsDir(vault);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `not a run id!${SNAPSHOT_ARCHIVE_SUFFIX}`), "x");

    const result = run();
    const entry = result.uncertain.find((e) => e.code === RECOVERY_POINT_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("not a run id!");
  });

  test("a file in the directory that is not an archive at all is not a skipped entry", () => {
    // A sidecar manifest, a store archive, or an operator's stray note is
    // not a recovery point that could not be read - it is not a recovery
    // point. Reporting it would train the reader to ignore the code.
    archive("dream-20260531T000000Z", 1);
    writeFileSync(join(snapshotsDir(vault), "README.txt"), "mine");
    expect(run().uncertain).toEqual([]);
  });

  test("an unreadable snapshots directory is uncertain, never clean and never stale", () => {
    archive("dream-20260101T000000Z", RECOVERY_POINT_LIVENESS_WINDOW_DAYS + 7);
    chmodSync(snapshotsDir(vault), 0o000);

    const result = run();
    expect(stale(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === RECOVERY_POINT_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(SCHEDULE_UNOBSERVABLE_CLAUSE);
  });
});

describe("the verdict comes from the injected clock, never from the wall", () => {
  test("two clocks over one vault give two answers", () => {
    archive("dream-20260501T000000Z", 1);
    // Same archive, same vault: only the clock moves.
    const early = run(NOW);
    const late = run(
      new Date(NOW.getTime() + (RECOVERY_POINT_LIVENESS_WINDOW_DAYS + 5) * MS_PER_DAY),
    );
    expect(stale(early)).toEqual([]);
    expect(stale(late).length).toBe(1);
  });

  test("the module reads no global clock", () => {
    // Asserted structurally rather than by timing: a `Date.now()` here
    // would pass every test above while making the check unpinnable.
    const source = Bun.file(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "core",
        "brain",
        "doctor",
        "recovery-point-liveness.ts",
      ),
    );
    return source.text().then((text) => {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code.includes("Date.now(")).toBe(false);
      expect(code.includes("new Date()")).toBe(false);
    });
  });
});

describe("both codes are classified exactly once", () => {
  test("the stale code carries a registered command", () => {
    expect(DIAGNOSTIC_SIGNALS.has(RECOVERY_POINT_STALE_CODE)).toBe(true);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RECOVERY_POINT_STALE_CODE)).toBe(false);
  });

  test("the unmeasured code carries a written reason instead", () => {
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RECOVERY_POINT_UNMEASURED_CODE)).toBe(true);
    expect(DIAGNOSTIC_SIGNALS.has(RECOVERY_POINT_UNMEASURED_CODE)).toBe(false);
  });
});
