/**
 * Host pressure is either measured or named unmeasurable (t_992f0c33).
 *
 * The whole point of the vocabulary is the pair these tests keep apart: a
 * host whose run queue really is empty, and a host whose run queue this
 * build cannot read. `os.loadavg()` reports `[0, 0, 0]` on the platform it
 * does not implement, so the two are the same number and only the reason
 * separates them.
 */

import { describe, expect, test } from "bun:test";

import {
  HOST_PRESSURE,
  HOST_PRESSURE_UNMEASURABLE_REASON,
  measureHostPressure,
  readHostPressureProbe,
  type HostPressureProbe,
} from "../../../../src/core/brain/maintenance/host-pressure.ts";

/** A POSIX host at half its capacity: 2 runnable tasks across 4 CPUs. */
const POSIX_PROBE: HostPressureProbe = Object.freeze({
  platform: "linux",
  loadAverage1m: 2,
  cpuCount: 4,
  cpuQuotaInForce: false,
});

describe("measureHostPressure", () => {
  test("a readable run queue normalises to a percentage of capacity", () => {
    expect(measureHostPressure(POSIX_PROBE)).toEqual({
      state: HOST_PRESSURE.measured,
      percent: 50,
      load_average_1m: 2,
      cpu_count: 4,
    });
  });

  test("a genuinely quiet POSIX host measures zero rather than refusing", () => {
    const reading = measureHostPressure({ ...POSIX_PROBE, loadAverage1m: 0 });
    expect(reading).toEqual({
      state: HOST_PRESSURE.measured,
      percent: 0,
      load_average_1m: 0,
      cpu_count: 4,
    });
  });

  test("the platform whose load average is a constant is unmeasurable, not idle", () => {
    // Same zero the quiet host above reported, and it must NOT read the
    // same way: on this platform the number is not a measurement.
    const reading = measureHostPressure({
      ...POSIX_PROBE,
      platform: "win32",
      loadAverage1m: 0,
    });
    expect(reading).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind,
    });
  });

  test("a CPU bandwidth quota makes the run queue the wrong machine's", () => {
    expect(measureHostPressure({ ...POSIX_PROBE, cpuQuotaInForce: true })).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.cpuQuotaInForce,
    });
  });

  test("a quota interface that exists but cannot be read is not 'no quota'", () => {
    expect(measureHostPressure({ ...POSIX_PROBE, cpuQuotaInForce: null })).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.cpuQuotaUnknown,
    });
  });

  test("no usable CPU count leaves nothing to normalise by", () => {
    for (const cpuCount of [0, -1, 1.5, Number.NaN]) {
      expect(measureHostPressure({ ...POSIX_PROBE, cpuCount })).toEqual({
        state: HOST_PRESSURE.unmeasurable,
        reason: HOST_PRESSURE_UNMEASURABLE_REASON.parallelismUnknown,
      });
    }
  });

  test("a run queue that is not a finite non-negative number is refused", () => {
    for (const loadAverage1m of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(measureHostPressure({ ...POSIX_PROBE, loadAverage1m })).toEqual({
        state: HOST_PRESSURE.unmeasurable,
        reason: HOST_PRESSURE_UNMEASURABLE_REASON.loadAverageInvalid,
      });
    }
  });

  test("an over-subscribed host reports above one hundred percent", () => {
    const reading = measureHostPressure({ ...POSIX_PROBE, loadAverage1m: 8, cpuCount: 4 });
    expect(reading).toEqual({
      state: HOST_PRESSURE.measured,
      percent: 200,
      load_average_1m: 8,
      cpu_count: 4,
    });
  });
});

describe("readHostPressureProbe", () => {
  test("the real probe answers in the shape the measurement consumes", () => {
    const probe = readHostPressureProbe();
    expect(typeof probe.platform).toBe("string");
    expect(typeof probe.loadAverage1m).toBe("number");
    expect(typeof probe.cpuCount).toBe("number");
    expect(probe.cpuQuotaInForce === null || typeof probe.cpuQuotaInForce === "boolean").toBe(true);
    // And it reaches a verdict of one kind or the other on this host,
    // rather than throwing on a machine whose /sys layout differs.
    const reading = measureHostPressure(probe);
    expect([HOST_PRESSURE.measured, HOST_PRESSURE.unmeasurable]).toContain(reading.state);
  });
});
