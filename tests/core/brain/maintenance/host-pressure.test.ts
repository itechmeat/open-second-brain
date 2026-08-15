/**
 * Host pressure is either measured or named unmeasurable (t_992f0c33).
 *
 * The whole point of the vocabulary is the pair these tests keep apart: a
 * host whose run queue really is empty, and a host whose run queue this
 * build cannot read. `os.loadavg()` reports `[0, 0, 0]` on the platform it
 * does not implement, so the two are the same number and only the reason
 * separates them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  HOST_PRESSURE,
  HOST_PRESSURE_UNMEASURABLE_REASON,
  LIVE_HOST_PRESSURE_IO,
  measureHostPressure,
  probeCpuQuota,
  readHostPressureProbe,
  type CgroupSource,
  type HostPressureIo,
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

describe("probeCpuQuota reads the cgroup this process is in", () => {
  let root: string;
  /** `/sys/fs/cgroup` and `/proc/self/cgroup`, relocated under a tmpdir. */
  let cgroupRoot: string;
  let selfCgroupPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "o2b-cgroup-"));
    cgroupRoot = join(root, "sys", "fs", "cgroup");
    selfCgroupPath = join(root, "proc", "self", "cgroup");
    mkdirSync(cgroupRoot, { recursive: true });
    mkdirSync(dirname(selfCgroupPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write `cpu.max` (v2) at a path RELATIVE to the cgroup mount root. */
  function v2Interface(relative: string, contents: string): void {
    const dir = join(cgroupRoot, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cpu.max"), contents);
  }

  function source(platform = "linux"): CgroupSource {
    return { platform, cgroupRoot, selfCgroupPath };
  }

  test("a quota on the process's OWN cgroup is in force, though the root has no cpu.max", () => {
    // The exact layout of the host this was found on: no `cpu.max` at the
    // mount root - under cgroup v2 the root never carries one - and the
    // limit expressed on the leaf the process actually lives in.
    writeFileSync(selfCgroupPath, "0::/user.slice/session-9028.scope\n");
    v2Interface("user.slice/session-9028.scope", "50000 100000\n");
    expect(probeCpuQuota(source())).toBe(true);
  });

  test("an ANCESTOR's quota is in force too, because the limit is the minimum over the chain", () => {
    writeFileSync(selfCgroupPath, "0::/user.slice/session-9028.scope\n");
    v2Interface("user.slice", "20000 100000\n");
    v2Interface("user.slice/session-9028.scope", "max 100000\n");
    expect(probeCpuQuota(source())).toBe(true);
  });

  test("an unlimited chain is a real 'no quota', not an absence", () => {
    writeFileSync(selfCgroupPath, "0::/user.slice/session-9028.scope\n");
    v2Interface("user.slice", "max 100000\n");
    v2Interface("user.slice/session-9028.scope", "max 100000\n");
    expect(probeCpuQuota(source())).toBe(false);
  });

  test("a cgroup nobody could read is unknown, never 'no quota'", () => {
    writeFileSync(selfCgroupPath, "0::/user.slice/session-9028.scope\n");
    v2Interface("user.slice/session-9028.scope", "max 100000\n");
    const file = join(cgroupRoot, "user.slice/session-9028.scope", "cpu.max");
    chmodSync(file, 0o000);
    try {
      // EACCES on a file that EXISTS is the hardened-/sys case, and the
      // old probe reported it as "no bandwidth controller".
      expect(probeCpuQuota(source())).toBe(null);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  test("not knowing which cgroup this process is in is its own answer", () => {
    // No `/proc/self/cgroup` to read at all on a platform that has one.
    expect(probeCpuQuota(source())).toBe(null);
  });

  test("a /proc/self/cgroup naming no hierarchy this build understands is unknown", () => {
    writeFileSync(selfCgroupPath, "7:name=systemd:/user.slice\n");
    expect(probeCpuQuota(source())).toBe(null);
  });

  test("a cgroup v1 cpu quota on the process's own path is in force", () => {
    writeFileSync(selfCgroupPath, "4:cpu,cpuacct:/user/1001.user\n");
    const dir = join(cgroupRoot, "cpu,cpuacct", "user/1001.user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cpu.cfs_quota_us"), "50000\n");
    expect(probeCpuQuota(source())).toBe(true);
  });

  test("a cgroup v1 chain declaring -1 everywhere is unlimited", () => {
    writeFileSync(selfCgroupPath, "4:cpu,cpuacct:/user/1001.user\n");
    for (const rel of ["cpu,cpuacct", "cpu,cpuacct/user", "cpu,cpuacct/user/1001.user"]) {
      const dir = join(cgroupRoot, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cpu.cfs_quota_us"), "-1\n");
    }
    expect(probeCpuQuota(source())).toBe(false);
  });

  test("a platform with no cgroups at all has no bandwidth controller", () => {
    // macOS: the question is answerable and the answer is no, which is
    // why this is `false` rather than the unknown above.
    expect(probeCpuQuota(source("darwin"))).toBe(false);
  });
});

describe("readHostPressureProbe turns a failed read into a named refusal", () => {
  const io = (over: Partial<HostPressureIo>): HostPressureIo => ({
    ...LIVE_HOST_PRESSURE_IO,
    ...over,
  });

  test("a run-queue read that throws is refused, never reported as an idle host", () => {
    const probe = readHostPressureProbe(
      io({
        loadAverage: () => {
          throw new Error("uv_loadavg: not supported");
        },
      }),
    );
    expect(measureHostPressure({ ...probe, cpuQuotaInForce: false, platform: "linux" })).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.loadAverageInvalid,
    });
  });

  test("a CPU count read that throws leaves nothing to normalise by", () => {
    const probe = readHostPressureProbe(
      io({
        cpuCount: () => {
          throw new Error("uv_available_parallelism: not supported");
        },
      }),
    );
    expect(measureHostPressure({ ...probe, cpuQuotaInForce: false, platform: "linux" })).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.parallelismUnknown,
    });
  });

  test("a CPU count of zero is refused rather than divided by", () => {
    const probe = readHostPressureProbe(io({ cpuCount: () => 0 }));
    expect(measureHostPressure({ ...probe, cpuQuotaInForce: false, platform: "linux" })).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.parallelismUnknown,
    });
  });

  test("the platform whose load average is a constant reaches the refusal from the live probe", () => {
    // `platform_blind` is not a test-only member: this build runs on
    // win32 whenever OPEN_SECOND_BRAIN_CONFIG or XDG_CONFIG_HOME says
    // where the config lives, which is exactly the escape
    // `resolveDefaultConfigPath` documents.
    const probe = readHostPressureProbe(io({ platform: "win32", loadAverage: () => [0, 0, 0] }));
    expect(measureHostPressure(probe)).toEqual({
      state: HOST_PRESSURE.unmeasurable,
      reason: HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind,
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
