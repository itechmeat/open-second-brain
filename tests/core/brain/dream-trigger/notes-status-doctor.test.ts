/**
 * What other machines say, what the owner's machine says, the status and
 * doctor (change `dream-session-trigger`, design D4, D6, D7; spec "Other
 * machines say one thing, once", "The state of the day is visible"). The
 * clock is injected; the spawn helper is spied and never run.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import { dreamTriggerCheck } from "../../../../src/core/brain/doctor/dream-trigger-check.ts";
import { dreamDayCheck } from "../../../../src/core/brain/dream-trigger/check.ts";
import {
  emptyDreamTriggerRecord,
  readDreamTriggerRecord,
  writeDreamTriggerRecord,
  type DreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";
import { recordDreamOutcome } from "../../../../src/core/brain/dream-trigger/outcome.ts";
import { DREAM_COVERAGE_KIND } from "../../../../src/core/brain/dream-replay/records.ts";
import * as o2bCommand from "../../../../src/core/maintenance/o2b-command.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { agentFixture } from "../dream-agent/fixture.ts";
import { makeTriggerFixture, type TriggerFixture } from "./fixture.ts";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const TODAY = "2026-11-20";
const HOUR = 3_600_000;

let f: TriggerFixture;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  f = makeTriggerFixture();
  spawnSpy = spyOn(o2bCommand, "spawnSelfDetached").mockImplementation((() => ({
    pid: 0,
    unref: () => {},
  })) as unknown as typeof o2bCommand.spawnSelfDetached);
});

afterEach(() => {
  spawnSpy.mockRestore();
  f.cleanup();
});

function covered(day: string): void {
  appendRecord(f.store("dev-a"), {
    partition: "shared",
    stream: "dream-replay",
    kind: DREAM_COVERAGE_KIND,
    agent: "o2b",
    body: { day, window: day, admission: `adm-${day}` },
  });
}

function check(now: number, notes = true) {
  return dreamDayCheck(f.config(), { now: () => now, notes });
}

function seed(over: Partial<DreamTriggerRecord>): void {
  writeDreamTriggerRecord(f.recordPath, { ...emptyDreamTriggerRecord(f.storeRoot), ...over });
}

function doctor(now = NOW, withholdsPrivate = false): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  dreamTriggerCheck.run(
    {
      vault: null,
      configPath: f.configPath,
      now: new Date(now),
      dbPath: "",
      readable: true,
      reach: withholdsPrivate ? "remote" : "local",
      withholdsPrivate,
    } as never,
    out,
  );
  return out;
}

function codes(out: DoctorFindings): string[] {
  return [...out.issues.map((i) => i.code), ...out.uncertain.map((u) => u.code)].toSorted();
}

const MINE = { device: "dev-a", agent: "claude", revision: null, mine: true };

describe("a machine that is not the owner", () => {
  beforeEach(() => {
    process.env["O2B_DEVICE_ID"] = "dev-b";
  });

  test("shows one line when the owner covered nothing for more than three days, once a day", () => {
    covered("2026-11-15");
    const first = check(NOW);
    expect(first.started).toBe(false);
    expect(first.note).toBe(
      "Dream is owned by dev-a (claude) and last covered 2026-11-15. To run it here: o2b dream owner --here",
    );
    expect(check(NOW + HOUR).note).toBeUndefined();
    // The next day says it again, once.
    expect(check(NOW + 24 * HOUR).note).toContain("last covered 2026-11-15");
    expect(check(NOW + 25 * HOUR).note).toBeUndefined();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("says nothing when the owner covered a window within three days", () => {
    covered("2026-11-17");
    expect(check(NOW).note).toBeUndefined();
    expect(check(NOW + HOUR).note).toBeUndefined();
  });

  test("a check that shows no note (a tool call) leaves the line for the next session", () => {
    covered("2026-11-15");
    expect(check(NOW, false).note).toBeUndefined();
    expect(check(NOW + 1, true).note).toContain("dev-a (claude)");
  });

  test("with no coverage at all, the age of the owner's claim decides", () => {
    // The claim was written on the wall clock at the fixture's start.
    expect(check(Date.now() + HOUR).note).toBeUndefined();
    seed({});
    expect(check(Date.now() + 4 * 24 * HOUR).note).toBe(
      "Dream is owned by dev-a (claude) and last covered no day yet. To run it here: o2b dream owner --here",
    );
  });
});

describe("the owner's note for a day closed with work nobody here answers", () => {
  test("is written by the outcome, shown once a day and reported by doctor", () => {
    const x = agentFixture();
    try {
      x.text("a");
      const started = new Date();
      const record = recordDreamOutcome(null, {
        configPath: x.f.configPath,
        startedAt: started,
        result: { returned: true },
        by: "cli",
      });
      expect(record?.closed).toBe(true);
      expect(record?.last_run?.outcome).toBe("complete-unanswerable");
      expect(record?.note).toContain(
        "Dream closed the day with work nothing on this machine answers",
      );
      expect(record?.note).toContain("o2b dream agent set");
      expect(record?.line).toEqual({ shown_day: null, text: record?.note ?? null });
    } finally {
      x.cleanup();
    }
  });

  test("the session note is shown once a day, and doctor names it", () => {
    const note = "Dream closed the day with work nothing on this machine answers: 1 rollup.";
    seed({ owner: MINE, closed: true, day: TODAY, note, line: { text: note, shown_day: null } });
    expect(check(NOW).note).toBe(note);
    expect(check(NOW + HOUR).note).toBeUndefined();
    const out = doctor();
    expect(codes(out)).toEqual(["dream-work-unanswerable"]);
    expect(out.uncertain[0]!.message).toBe(note);
    // Below local reach the note, which counts private work too, is not shown.
    const remote = doctor(NOW, true);
    expect(codes(remote)).toEqual(["dream-work-unanswerable"]);
    expect(remote.uncertain[0]!.message).not.toContain("rollup");
  });
});

describe("doctor", () => {
  test("a day open for more than one day: dream-day-open with the reason and the retry time", () => {
    const retry = new Date(NOW + 4 * HOUR).toISOString();
    seed({
      owner: MINE,
      day: TODAY,
      closed: false,
      reason: "2 window(s) behind (2026-11-18 to 2026-11-19)",
      failures: 3,
      retry_at: retry,
      open_since: new Date(NOW - 26 * HOUR).toISOString(),
    });
    const out = doctor();
    expect(codes(out)).toEqual(["dream-day-open"]);
    expect(out.uncertain[0]!.message).toContain("2 window(s) behind");
    expect(out.uncertain[0]!.message).toContain(retry);
    expect(doctor(NOW, true).uncertain[0]!.message).not.toContain("window(s) behind");
    // Open for less than a day: quiet.
    seed({
      owner: MINE,
      day: TODAY,
      closed: false,
      open_since: new Date(NOW - HOUR).toISOString(),
    });
    expect(codes(doctor())).toEqual([]);
  });

  test("a lost worker: dream-worker-lost", () => {
    seed({
      owner: MINE,
      day: TODAY,
      closed: false,
      last_run: {
        started_at: "2026-11-20T07:00:00.000Z",
        ended_at: null,
        outcome: "lost",
        by: "worker",
      },
      lost_worker_at: new Date(NOW).toISOString(),
    });
    const out = doctor();
    expect(out.issues.map((i) => [i.code, i.severity])).toEqual([["dream-worker-lost", "warning"]]);
  });

  test("automatic dream off: dream-auto-off", () => {
    f.setAuto(false);
    expect(codes(doctor())).toEqual(["dream-auto-off"]);
  });

  test("a closed day says nothing", () => {
    seed({ owner: MINE, day: TODAY, closed: true });
    expect(codes(doctor())).toEqual([]);
  });

  test("a machine that is not the owner hears nothing of the owner's day", () => {
    seed({
      owner: MINE,
      day: TODAY,
      closed: true,
      note: "x",
      line: { text: "x", shown_day: null },
    });
    process.env["O2B_DEVICE_ID"] = "dev-b";
    expect(codes(doctor())).toEqual([]);
  });
});

function status(args: string[] = []) {
  return runCli(["dream", "status", ...args], {
    env: { OPEN_SECOND_BRAIN_CONFIG: f.configPath },
  });
}

const today = (): string => new Date().toISOString().slice(0, 10);

describe("o2b dream status", () => {
  test("a closed day, in text and JSON", async () => {
    seed({
      owner: MINE,
      day: today(),
      closed: true,
      last_run: {
        started_at: "2026-11-20T07:00:00.000Z",
        ended_at: "2026-11-20T07:01:00.000Z",
        outcome: "complete",
        by: "worker",
      },
    });
    const text = await status();
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("Automatic dream: on");
    expect(text.stdout).toContain("this device is the owner");
    expect(text.stdout).toContain("The day is closed.");
    expect(text.stdout).toContain(
      "Last run: started 2026-11-20T07:00:00.000Z, ended 2026-11-20T07:01:00.000Z, complete, by worker.",
    );
    const json = JSON.parse((await status(["--json"])).stdout);
    expect(json).toMatchObject({
      ok: true,
      auto: { on: true, setting: true, machine_off: false },
      is_owner: true,
      closed_today: true,
      day: { closed: true, last_run: { outcome: "complete" } },
    });
  });

  test("a day closed ahead of the clock is closed, in text and JSON, as the trigger reads it", async () => {
    const ahead = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    seed({ owner: MINE, day: ahead, closed: true });
    const text = await status();
    expect(text.stdout).toContain(`The day is closed: the record closed ${ahead}`);
    expect(text.stdout).not.toContain("today is open");
    const json = JSON.parse((await status(["--json"])).stdout);
    // The record's own fields are reported as they are.
    expect(json).toMatchObject({ closed_today: true, day: { day: ahead, closed: true } });
  });

  test("an open day names the failure and the next attempt", async () => {
    const retry = "2026-11-20T10:00:00.000Z";
    seed({
      owner: MINE,
      day: today(),
      closed: false,
      reason: "the pass failed: dream exceeded its deadline",
      failures: 1,
      retry_at: retry,
      last_run: {
        started_at: "2026-11-20T09:00:00.000Z",
        ended_at: "2026-11-20T09:10:00.000Z",
        outcome: "failed",
        by: "worker",
      },
    });
    const text = await status();
    expect(text.stdout).toContain("is open: the pass failed: dream exceeded its deadline.");
    expect(text.stdout).toContain(`Next attempt after ${retry}`);
    const json = JSON.parse((await status(["--json"])).stdout);
    expect(json.day).toMatchObject({ closed: false, retry_at: retry, failures: 1 });
    expect(json.closed_today).toBe(false);
  });

  test("automatic dream off", async () => {
    f.setAuto(false);
    const text = await status();
    expect(text.stdout).toContain("Automatic dream: off (the shared setting dream.auto is false).");
    expect(JSON.parse((await status(["--json"])).stdout).auto).toEqual({
      on: false,
      setting: false,
      machine_off: false,
    });
  });

  test("a device that is not the owner", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-b";
    const text = await status();
    expect(text.stdout).toContain(
      "Dream owner: dev-a (claude); this device (dev-b) is not, and starts no pass.",
    );
    const json = JSON.parse((await status(["--json"])).stdout);
    expect(json).toMatchObject({
      is_owner: false,
      owner: { device: "dev-a", agent: "claude" },
      day: null,
    });
  });

  test("writes nothing and starts nothing", async () => {
    await status();
    expect(readDreamTriggerRecord(f.recordPath, f.storeRoot)).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
