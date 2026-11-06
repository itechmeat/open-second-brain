import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  compareHlc,
  formatHlc,
  HLC_MAX_DRIFT_MS,
  parseHlc,
  receiveHlc,
  sendHlc,
  type Hlc,
} from "../../../src/core/store/hlc.ts";
import {
  clockFilePath,
  observeClock,
  readClock,
  tickClock,
} from "../../../src/core/store/clock-store.ts";

describe("hlc text form", () => {
  test("round-trips physical milliseconds and counter", () => {
    const clock: Hlc = { physical: 1_762_400_000_123, counter: 7 };
    expect(formatHlc(clock)).toBe("1762400000123.7");
    expect(parseHlc("1762400000123.7")).toEqual(clock);
  });

  test("rejects malformed stamps", () => {
    for (const bad of ["", "1.2.3", "abc.1", "12", "-1.0", "1.-1", "01.0", "1.01", "1e3.0"]) {
      expect(parseHlc(bad)).toBeNull();
    }
  });

  test("orders by physical, then counter", () => {
    expect(compareHlc({ physical: 1, counter: 9 }, { physical: 2, counter: 0 })).toBeLessThan(0);
    expect(compareHlc({ physical: 2, counter: 1 }, { physical: 2, counter: 0 })).toBeGreaterThan(0);
    expect(compareHlc({ physical: 2, counter: 1 }, { physical: 2, counter: 1 })).toBe(0);
  });
});

describe("hlc send rule", () => {
  test("takes the wall clock when it is ahead", () => {
    expect(sendHlc({ physical: 100, counter: 4 }, 200)).toEqual({ physical: 200, counter: 0 });
  });

  test("increments the counter on a tie", () => {
    expect(sendHlc({ physical: 200, counter: 4 }, 200)).toEqual({ physical: 200, counter: 5 });
  });

  test("stays monotonic when the wall clock goes backwards", () => {
    let clock: Hlc = { physical: 0, counter: 0 };
    const stamps: Hlc[] = [];
    for (const wall of [1000, 1005, 900, 900, 400, 1005, 1006]) {
      clock = sendHlc(clock, wall);
      stamps.push(clock);
    }
    for (let i = 1; i < stamps.length; i++) {
      expect(compareHlc(stamps[i]!, stamps[i - 1]!)).toBeGreaterThan(0);
    }
  });
});

describe("hlc receive rule", () => {
  test("raises the local clock above a remote clock from a faster machine", () => {
    const local = { physical: 1000, counter: 0 };
    const remote = { physical: 121_000, counter: 3 };
    const raised = receiveHlc(local, remote, 1001);
    expect(compareHlc(raised, remote)).toBeGreaterThanOrEqual(0);
    // The next stamp the slow machine sends orders after the remote one.
    expect(compareHlc(sendHlc(raised, 1002), remote)).toBeGreaterThan(0);
  });

  test("a remote stamp more than the drift bound ahead of the wall clock is not adopted", () => {
    const wall = Date.UTC(2026, 10, 6);
    const local = { physical: wall - 5, counter: 1 };
    const farFuture = { physical: wall + HLC_MAX_DRIFT_MS + 1, counter: 0 };
    expect(receiveHlc(local, farFuture, wall)).toEqual({ physical: wall, counter: 0 });
    // Just inside the bound, the remote stamp is still adopted.
    const near = { physical: wall + HLC_MAX_DRIFT_MS, counter: 2 };
    expect(receiveHlc(local, near, wall)).toEqual(near);
  });

  test("never lowers the local clock", () => {
    const local = { physical: 5000, counter: 2 };
    expect(
      compareHlc(receiveHlc(local, { physical: 10, counter: 0 }, 20), local),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("persisted device clock", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osb-store-clock-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("survives a restart: a new tick after a backwards wall clock still orders later", () => {
    const first = tickClock(root, "dev-a", () => 50_000);
    // A "restart" is a fresh call with nothing in memory; only the file remains.
    const second = tickClock(root, "dev-a", () => 10_000);
    expect(compareHlc(second, first)).toBeGreaterThan(0);
    expect(readClock(root, "dev-a")).toEqual(second);
  });

  test("an observed remote clock lifts later ticks above it", () => {
    const remote = { physical: 9_000_000, counter: 4 };
    observeClock(root, "dev-b", remote, () => 1_000);
    const reply = tickClock(root, "dev-b", () => 1_001);
    expect(compareHlc(reply, remote)).toBeGreaterThan(0);
  });

  test("a corrupt clock file falls back to the wall clock instead of failing the write", () => {
    const path = clockFilePath(root, "dev-c");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(tickClock(root, "dev-c", () => 777)).toEqual({ physical: 777, counter: 0 });
  });

  test("a far-future remote stamp from a broken clock does not poison later ticks", () => {
    const wall = Date.UTC(2026, 10, 6);
    // Year 9999 and beyond: a month name for it would break every later append.
    observeClock(root, "dev-f", { physical: 9_000_000_000_000_000, counter: 0 }, () => wall);
    expect(tickClock(root, "dev-f", () => wall + 1)).toEqual({ physical: wall + 1, counter: 0 });
  });

  test("a clock file that exists but cannot be read fails the tick instead of resetting the clock", () => {
    const path = clockFilePath(root, "dev-d");
    // A directory where the file should be: the read fails with something other than ENOENT.
    mkdirSync(path, { recursive: true });
    expect(() => readClock(root, "dev-d")).toThrow();
    expect(() => tickClock(root, "dev-d", () => 777)).toThrow();
  });

  test("clocks of two devices are independent", () => {
    tickClock(root, "dev-a", () => 9_000);
    expect(readClock(root, "dev-z")).toBeNull();
  });
});
