import { afterEach, beforeEach } from "bun:test";

/**
 * Run `run` with `O2B_DEVICE_ID` set to `deviceId`, then put the previous
 * value back (or remove the variable when it was absent), whatever `run`
 * did.
 *
 * Per-device ledger shards are named from this variable, so a test that
 * writes as two devices switches it several times. One helper owns the
 * save/set/restore: a hand-written restore that is missed or wrong leaks
 * the device id into every later test in the same bun process.
 * `tests/setup.ts` runs the suite under `test-device`; pass `""` here to
 * select the un-sharded legacy name explicitly.
 */
export function withDeviceId<T>(deviceId: string, run: () => T): T {
  const previous = process.env["O2B_DEVICE_ID"];
  process.env["O2B_DEVICE_ID"] = deviceId;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["O2B_DEVICE_ID"];
    else process.env["O2B_DEVICE_ID"] = previous;
  }
}

/**
 * Run every test of the calling file (or `describe` block) with
 * `O2B_DEVICE_ID=""`: no device id, so the legacy ledgers and the day log
 * keep their un-sharded names (`Brain/log/<date>.md`). For tests of the
 * legacy layout that read those names directly; a store write in such a
 * test fails with `no-device`, so its vault keeps a `Brain/` tree.
 */
export function useUnshardedLegacyLog(): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env["O2B_DEVICE_ID"];
    process.env["O2B_DEVICE_ID"] = "";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env["O2B_DEVICE_ID"];
    else process.env["O2B_DEVICE_ID"] = previous;
  });
}
