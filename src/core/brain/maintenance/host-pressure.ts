/**
 * Host pressure, measured honestly or refused by name (t_992f0c33).
 *
 * The quiet-window lane already gates heavy work on a measured pressure
 * signal - interactive query rate. This module supplies the second one:
 * how loaded the MACHINE is, normalised so a threshold means the same
 * thing on a laptop and on a build box.
 *
 * ## Why this is mostly refusals
 *
 * `os.loadavg()` is the only dependency-free run-queue reading available,
 * and it does not mean what its name suggests everywhere:
 *
 *   - on the platform Node and Bun do not implement it for, it returns
 *     `[0, 0, 0]` - a constant, not a measurement, and indistinguishable
 *     from a genuinely idle host;
 *   - inside a cgroup with a CPU BANDWIDTH quota it still reports the
 *     whole host's run queue, while the denominator this module divides
 *     by is the CPU count the process may be scheduled on. A quota bounds
 *     how much CPU TIME the cgroup may consume without changing that
 *     count, so the ratio would be computed from two numbers that do not
 *     describe the same machine.
 *
 * A gate that answered "idle" in either case would be the silent no-op
 * this project forbids: it would read exactly like a quiet host, and the
 * operator would have no way to tell that the gate never evaluated. So
 * the reading is a two-state value - a number, or a named reason there is
 * no number - following the precedent of
 * `UnsupportedPlatformError` in `src/core/config.ts`, which refuses to
 * invent a Windows config path rather than return "a plausible-looking
 * answer to a question this build cannot answer".
 *
 * The caller decides what to do with a refusal. The lane leaves its gate
 * OPEN and journals the reason, because refusing to maintain a vault
 * forever on a platform where the metric does not exist would be a worse
 * failure than not having the gate at all.
 */

import { availableParallelism, loadavg, platform } from "node:os";
import { readFileSync } from "node:fs";

/**
 * Platforms whose load average is a constant rather than a measurement.
 * Named rather than inferred, exactly as `UNSUPPORTED_CONFIG_PLATFORMS`
 * is: which platforms report a real run queue is a fact about the
 * runtime, not something to discover by seeing whether the number moves.
 */
const LOAD_AVERAGE_BLIND_PLATFORMS: ReadonlyArray<string> = Object.freeze(["win32"]);

/** cgroup v2 CPU bandwidth interface: `"<quota|max> <period>"`. */
const CGROUP_V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";
/** cgroup v1 CPU bandwidth interface: microseconds, or `-1` for none. */
const CGROUP_V1_CPU_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
/** The cgroup v2 token meaning "no bandwidth limit". */
const CGROUP_V2_UNLIMITED = "max";

/** Whether a pressure reading is a number or a named absence. */
export const HOST_PRESSURE = Object.freeze({
  /** A normalised percentage of this host's usable capacity. */
  measured: "measured",
  /** No number: the accompanying reason says which question failed. */
  unmeasurable: "unmeasurable",
});

export const HOST_PRESSURE_STATES: ReadonlyArray<string> = Object.freeze(
  Object.values(HOST_PRESSURE),
);

export type HostPressureState = (typeof HOST_PRESSURE)[keyof typeof HOST_PRESSURE];

export function isHostPressureState(value: unknown): value is HostPressureState {
  return typeof value === "string" && HOST_PRESSURE_STATES.includes(value);
}

/**
 * Why no pressure number could be produced.
 *
 * Separate from the state for the reason every `*_UNDETERMINED_REASON`
 * vocabulary in this repository is separate from its verdict: one guard
 * over both would let `cpu_quota_in_force` be read back off a journal row
 * where a load percentage belongs.
 */
export const HOST_PRESSURE_UNMEASURABLE_REASON = Object.freeze({
  /** This platform's load average is a constant, not a run queue. */
  platformBlind: "platform_blind",
  /** A CPU bandwidth quota applies: the run queue is the host's, not ours. */
  cpuQuotaInForce: "cpu_quota_in_force",
  /** The quota interface exists and could not be read, so neither answer is provable. */
  cpuQuotaUnknown: "cpu_quota_unknown",
  /** No usable CPU count to normalise the run queue by. */
  parallelismUnknown: "parallelism_unknown",
  /** The run-queue reading itself is not a finite, non-negative number. */
  loadAverageInvalid: "load_average_invalid",
});

export const HOST_PRESSURE_UNMEASURABLE_REASONS: ReadonlyArray<string> = Object.freeze(
  Object.values(HOST_PRESSURE_UNMEASURABLE_REASON),
);

export type HostPressureUnmeasurableReason =
  (typeof HOST_PRESSURE_UNMEASURABLE_REASON)[keyof typeof HOST_PRESSURE_UNMEASURABLE_REASON];

export function isHostPressureUnmeasurableReason(
  value: unknown,
): value is HostPressureUnmeasurableReason {
  return typeof value === "string" && HOST_PRESSURE_UNMEASURABLE_REASONS.includes(value);
}

/**
 * The raw facts a reading is computed from, gathered in one place so the
 * arithmetic and the refusal rules can be tested without a machine that
 * happens to be loaded, containerised, or running Windows.
 */
export interface HostPressureProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** One-minute run-queue average, as the platform reports it. */
  readonly loadAverage1m: number;
  /** CPUs this process may be scheduled on. */
  readonly cpuCount: number;
  /**
   * Whether a CPU bandwidth limit applies: `true` a limit was read,
   * `false` the interface says there is none (or there is no such
   * interface on this host), `null` the interface exists and could not
   * be read.
   */
  readonly cpuQuotaInForce: boolean | null;
}

export interface HostPressureMeasured {
  readonly state: typeof HOST_PRESSURE.measured;
  /** Run queue as a percentage of usable capacity; 100 means fully subscribed. */
  readonly percent: number;
  readonly load_average_1m: number;
  readonly cpu_count: number;
}

export interface HostPressureUnmeasurable {
  readonly state: typeof HOST_PRESSURE.unmeasurable;
  readonly reason: HostPressureUnmeasurableReason;
}

export type HostPressureReading = HostPressureMeasured | HostPressureUnmeasurable;

function unmeasurable(reason: HostPressureUnmeasurableReason): HostPressureUnmeasurable {
  return { state: HOST_PRESSURE.unmeasurable, reason };
}

/** First line of `path`, or `null` when it cannot be read at all. */
function readFirstLine(path: string): string | null {
  try {
    return readFileSync(path, "utf8").split("\n", 1)[0]?.trim() ?? null;
  } catch {
    // Absent and unreadable are told apart by the caller, which knows
    // which of the two interfaces it asked for.
    return null;
  }
}

/**
 * Whether a CPU bandwidth quota applies to this process.
 *
 * Both cgroup generations are probed because a host can expose either.
 * When neither interface is present there is no bandwidth controller to
 * be limited by, which is a real answer - `false` - rather than an
 * absence: that is the ordinary case on macOS and on a Linux host
 * outside a container.
 */
function probeCpuQuota(): boolean | null {
  const v2 = readFirstLine(CGROUP_V2_CPU_MAX);
  if (v2 !== null) {
    const quota = v2.split(/\s+/)[0];
    if (quota === undefined || quota === "") return null;
    return quota !== CGROUP_V2_UNLIMITED;
  }
  const v1 = readFirstLine(CGROUP_V1_CPU_QUOTA);
  if (v1 !== null) {
    const quota = Number(v1);
    if (!Number.isFinite(quota)) return null;
    return quota > 0;
  }
  return false;
}

/** Gather the live facts. Pure reads; never throws. */
export function readHostPressureProbe(): HostPressureProbe {
  return {
    platform: platform(),
    loadAverage1m: loadavg()[0] ?? Number.NaN,
    cpuCount: availableParallelism(),
    cpuQuotaInForce: probeCpuQuota(),
  };
}

/**
 * Turn a probe into a reading: a normalised percentage, or the named
 * reason there is no number. The refusals are checked before the
 * arithmetic, because every one of them would otherwise produce a
 * plausible number from an implausible input.
 */
export function measureHostPressure(
  probe: HostPressureProbe = readHostPressureProbe(),
): HostPressureReading {
  if (LOAD_AVERAGE_BLIND_PLATFORMS.includes(probe.platform)) {
    return unmeasurable(HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind);
  }
  if (probe.cpuQuotaInForce === null) {
    return unmeasurable(HOST_PRESSURE_UNMEASURABLE_REASON.cpuQuotaUnknown);
  }
  if (probe.cpuQuotaInForce) {
    return unmeasurable(HOST_PRESSURE_UNMEASURABLE_REASON.cpuQuotaInForce);
  }
  if (!Number.isInteger(probe.cpuCount) || probe.cpuCount < 1) {
    return unmeasurable(HOST_PRESSURE_UNMEASURABLE_REASON.parallelismUnknown);
  }
  if (!Number.isFinite(probe.loadAverage1m) || probe.loadAverage1m < 0) {
    return unmeasurable(HOST_PRESSURE_UNMEASURABLE_REASON.loadAverageInvalid);
  }
  return {
    state: HOST_PRESSURE.measured,
    percent: (probe.loadAverage1m / probe.cpuCount) * 100,
    load_average_1m: probe.loadAverage1m,
    cpu_count: probe.cpuCount,
  };
}
