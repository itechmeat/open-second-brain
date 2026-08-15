import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOOK_CEILING_MS,
  HOOK_CEILING_HEADROOM_MS,
  HOOK_HOST_TIMEOUT_SECONDS,
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

/**
 * The watchdog and the host timeout are one design, and the thing worth
 * pinning is the RELATION between them, not either number. Asserting the
 * two constants separately would let someone raise the ceiling past the
 * host timeout and still see green - which is the exact state this suite
 * was written to end, where a 55 s self-ceiling sat behind a 10 s host
 * timeout and could never once have fired.
 */
describe("the self-ceiling and the declared host timeout", () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const declaredTimeouts = (): number[] => {
    const parsed = JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>;
    };
    const out: number[] = [];
    for (const groups of Object.values(parsed.hooks)) {
      for (const group of groups) {
        for (const entry of group.hooks) {
          if (entry.timeout !== undefined) out.push(entry.timeout);
        }
      }
    }
    return out;
  };

  test("every hooks.json entry declares the timeout the module is built against", () => {
    const timeouts = declaredTimeouts();
    expect(timeouts.length).toBeGreaterThan(0);
    expect([...new Set(timeouts)]).toEqual([HOOK_HOST_TIMEOUT_SECONDS]);
  });

  test("the self-ceiling fires first, by the stated headroom", () => {
    const hostMs = HOOK_HOST_TIMEOUT_SECONDS * 1000;
    expect(HOOK_CEILING_HEADROOM_MS).toBeGreaterThan(0);
    expect(DEFAULT_HOOK_CEILING_MS).toBe(hostMs - HOOK_CEILING_HEADROOM_MS);
    expect(DEFAULT_HOOK_CEILING_MS).toBeLessThan(hostMs);
    // And it is still a ceiling worth arming rather than a value the
    // floor would swallow.
    expect(resolveHookCeilingMs({})).toBe(DEFAULT_HOOK_CEILING_MS);
  });
});
