import { expect, test } from "bun:test";

import {
  DEFAULT_HOOK_CEILING_MS,
  armProcessCeiling,
  resolveHookCeilingMs,
} from "../../hooks/lib/process-ceiling.ts";

test("armProcessCeiling schedules at the configured ceiling and self-terminates on expiry", () => {
  let scheduledMs = -1;
  let fired: (() => void) | null = null;
  const exits: number[] = [];
  let expired = false;

  const disarm = armProcessCeiling({
    ceilingMs: 55_000,
    onExpire: () => {
      expired = true;
    },
    exit: (code) => {
      exits.push(code);
    },
    setTimer: (fn, ms) => {
      scheduledMs = ms;
      fired = fn;
      return { id: 1 };
    },
    clearTimer: () => {
      /* not expected in this test */
    },
  });

  expect(scheduledMs).toBe(55_000);
  expect(exits).toEqual([]);

  // Simulate the process still running at the deadline.
  fired!();
  expect(expired).toBe(true);
  expect(exits).toEqual([0]);

  disarm();
});

test("disarming before the ceiling clears the timer and never exits", () => {
  const exits: number[] = [];
  let cleared: unknown = null;

  const disarm = armProcessCeiling({
    ceilingMs: 1_000,
    exit: (code) => exits.push(code),
    setTimer: () => ({ id: 42 }),
    clearTimer: (handle) => {
      cleared = handle;
    },
  });

  disarm();
  expect(cleared).toEqual({ id: 42 });
  // Idempotent: a second disarm is a no-op.
  disarm();
  expect(exits).toEqual([]);
});

test("an onExpire that throws still lets the process exit", () => {
  const exits: number[] = [];
  let fired: (() => void) | null = null;
  armProcessCeiling({
    ceilingMs: 10,
    onExpire: () => {
      throw new Error("audit blew up");
    },
    exit: (code) => exits.push(code),
    setTimer: (fn) => {
      fired = fn;
      return {};
    },
    clearTimer: () => {},
  });
  fired!();
  expect(exits).toEqual([0]);
});

test("resolveHookCeilingMs: default, override, and invalid fallback", () => {
  expect(resolveHookCeilingMs({})).toBe(DEFAULT_HOOK_CEILING_MS);
  expect(resolveHookCeilingMs({ OPEN_SECOND_BRAIN_HOOK_CEILING_MS: "30000" })).toBe(30_000);
  // Below the floor and non-numeric fall back to the default.
  expect(resolveHookCeilingMs({ OPEN_SECOND_BRAIN_HOOK_CEILING_MS: "10" })).toBe(
    DEFAULT_HOOK_CEILING_MS,
  );
  expect(resolveHookCeilingMs({ OPEN_SECOND_BRAIN_HOOK_CEILING_MS: "nope" })).toBe(
    DEFAULT_HOOK_CEILING_MS,
  );
});
