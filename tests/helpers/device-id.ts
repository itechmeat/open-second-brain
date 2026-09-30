/**
 * Run `run` with `O2B_DEVICE_ID` set to `deviceId`, then put the previous
 * value back (or remove the variable when it was absent), whatever `run`
 * did.
 *
 * Per-device ledger shards are named from this variable, so a test that
 * writes as two devices switches it several times. One helper owns the
 * save/set/restore: a hand-written restore that is missed or wrong leaks
 * the device id into every later test in the same bun process.
 * `tests/setup.ts` pins the suite-wide default to the empty string (the
 * un-sharded legacy name); pass `""` here to select that name explicitly.
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
