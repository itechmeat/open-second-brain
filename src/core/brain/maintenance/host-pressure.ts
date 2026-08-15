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
 * Whether that second case holds is asked of the cgroup this process is
 * actually in - `/proc/self/cgroup` and every ancestor of the path it
 * names - never of the hierarchy root, which under cgroup v2 carries no
 * `cpu.max` at all. {@link probeCpuQuota} says what each answer rests on.
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
import { join } from "node:path";

/**
 * Platforms whose load average is a constant rather than a measurement.
 * Named rather than inferred, exactly as `UNSUPPORTED_CONFIG_PLATFORMS`
 * is: which platforms report a real run queue is a fact about the
 * runtime, not something to discover by seeing whether the number moves.
 *
 * This is reachable rather than theoretical. `UNSUPPORTED_CONFIG_PLATFORMS`
 * does not refuse win32 outright - `resolveDefaultConfigPath` bows out of
 * the `$HOME/.config` CONVENTION there and says so, leaving
 * `OPEN_SECOND_BRAIN_CONFIG` and `XDG_CONFIG_HOME` as two working ways to
 * run this build on Windows - so a maintenance lane can and does reach
 * this refusal on a real host.
 */
const LOAD_AVERAGE_BLIND_PLATFORMS: ReadonlyArray<string> = Object.freeze(["win32"]);

/** cgroup v2 CPU bandwidth interface file: `"<quota|max> <period>"`. */
const CGROUP_V2_CPU_MAX = "cpu.max";
/** cgroup v1 CPU bandwidth interface file: microseconds, or `-1` for none. */
const CGROUP_V1_CPU_QUOTA = "cpu.cfs_quota_us";
/** The cgroup v2 token meaning "no bandwidth limit". */
const CGROUP_V2_UNLIMITED = "max";
/** The v1 controller whose quota this asks about. */
const CGROUP_V1_CPU_CONTROLLER = "cpu";
/** The only platform with a cgroup hierarchy to consult. */
const CGROUP_PLATFORM = "linux";

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
  /**
   * The quota question could not be answered: the interface exists and
   * refused to be read, its contents did not parse, or which cgroup this
   * process belongs to could not be established. Neither answer is
   * provable, and `false` would be the one that lets a wrong number out.
   */
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
   * Whether a CPU bandwidth limit applies: `true` a limit was read off
   * this process's own cgroup or one of its ancestors, `false` every
   * interface on that chain declares none (or this platform has no such
   * controller at all), `null` the question could not be answered - see
   * {@link probeCpuQuota} for the three ways that happens.
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

/**
 * Where the quota probe reads from.
 *
 * Two absolute paths and a platform, injected rather than hardcoded, so
 * the walk below can be driven over a real directory tree with real
 * permissions - including a `cpu.max` that exists and refuses to be read,
 * which is the case this module got wrong and which no amount of
 * arithmetic-level testing could have reached.
 */
export interface CgroupSource {
  /** `process.platform`. */
  readonly platform: string;
  /** File naming the cgroups this process belongs to; `/proc/self/cgroup`. */
  readonly selfCgroupPath: string;
  /** Mount root of the cgroup hierarchy; `/sys/fs/cgroup`. */
  readonly cgroupRoot: string;
}

/** What one read of a cgroup interface file found. */
type InterfaceRead =
  | { readonly kind: "text"; readonly text: string }
  /** No such file. Says nothing about any other cgroup in the chain. */
  | { readonly kind: "absent" }
  /** The file is there and this process may not read it. */
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * Read one file, keeping ABSENT and UNREADABLE apart.
 *
 * They used to be one `null`, under a comment claiming the caller told
 * them apart - which it did not, so an `EACCES` on an existing `cpu.max`
 * (a restricted `/sys` mount, a hardened runtime) was reported as "no
 * quota in force". They are two different facts here because the walk
 * below does two different things with them: an absent interface means
 * keep looking up the chain, an unreadable one means stop and say so.
 */
function readInterface(path: string): InterfaceRead {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
    return { kind: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Which cgroups this process is in, as `/proc/self/cgroup` reports them. */
interface CgroupMembership {
  /** The unified (v2) path, e.g. `/user.slice/session-9.scope`, or `null`. */
  readonly v2Path: string | null;
  /** The v1 `cpu` controller's mount name and path, or `null`. */
  readonly v1: { readonly controllers: string; readonly path: string } | null;
}

/**
 * Parse `/proc/self/cgroup`.
 *
 * Every line is `<hierarchy-id>:<controllers>:<path>`. The unified
 * hierarchy is the line with id `0` and an empty controller list; a v1
 * hierarchy is any line whose comma-separated controller list contains
 * `cpu`. A hybrid host has both, and the v2 line is preferred because a
 * quota expressed there is the one the kernel enforces.
 */
function parseSelfCgroup(text: string): CgroupMembership {
  let v2Path: string | null = null;
  let v1: CgroupMembership["v1"] = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const id = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    if (id === "0" && controllers === "") {
      v2Path = path;
      continue;
    }
    if (controllers.split(",").includes(CGROUP_V1_CPU_CONTROLLER)) v1 = { controllers, path };
  }
  return { v2Path, v1 };
}

/**
 * Every cgroup directory from the named one up to the mount root.
 *
 * The effective bandwidth limit is the MINIMUM over the whole ancestor
 * chain, so a quota on `user.slice` binds a process in
 * `user.slice/session-9.scope` exactly as one on the leaf does. Reading a
 * single directory would answer for one link of that chain.
 */
function ancestorDirs(root: string, path: string): string[] {
  const parts = path.split("/").filter((p) => p !== "");
  const dirs: string[] = [];
  for (let i = parts.length; i >= 0; i--) dirs.push(join(root, ...parts.slice(0, i)));
  return dirs;
}

/** How one interface file's contents answered, or that it did not. */
type QuotaVerdict = "in_force" | "unlimited" | "unparseable";

/** `"<quota|max> <period>"`. */
function parseV2Quota(text: string): QuotaVerdict {
  const token = text.split("\n", 1)[0]?.trim().split(/\s+/)[0];
  if (token === undefined || token === "") return "unparseable";
  return token === CGROUP_V2_UNLIMITED ? "unlimited" : "in_force";
}

/** Microseconds per period, or `-1` for "no limit". */
function parseV1Quota(text: string): QuotaVerdict {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  const quota = Number(first);
  if (first === "" || !Number.isFinite(quota)) return "unparseable";
  return quota > 0 ? "in_force" : "unlimited";
}

/**
 * What one hierarchy had to say.
 *
 * `unknown` and `no_interface` are separate members for the reason this
 * whole module exists: a file that refused to be read and a controller
 * that is not enabled are different facts, and collapsing them is what
 * turned an `EACCES` into "no quota in force".
 */
type ChainAnswer = "in_force" | "unlimited" | "unknown" | "no_interface";

/**
 * Walk one chain of cgroup directories, leaf first, looking for a
 * bandwidth limit. An absent interface on one link says nothing about the
 * next, so the walk continues; an unreadable or unparseable one stops it.
 */
function walkChain(
  dirs: ReadonlyArray<string>,
  file: string,
  parse: (text: string) => QuotaVerdict,
): ChainAnswer {
  let sawInterface = false;
  for (const dir of dirs) {
    const read = readInterface(join(dir, file));
    if (read.kind === "absent") continue;
    if (read.kind === "unreadable") return "unknown";
    sawInterface = true;
    const verdict = parse(read.text);
    if (verdict === "in_force") return "in_force";
    if (verdict === "unparseable") return "unknown";
  }
  return sawInterface ? "unlimited" : "no_interface";
}

/** The three answers a walked chain maps onto, or `undefined` to keep looking. */
function fromChain(answer: ChainAnswer): boolean | null | undefined {
  if (answer === "in_force") return true;
  if (answer === "unlimited") return false;
  if (answer === "unknown") return null;
  return undefined;
}

/**
 * Whether a CPU bandwidth quota applies to this process.
 *
 * `true` a limit is in force, `false` there is provably none, `null` the
 * question could not be answered - and that third value is not a
 * formality. This used to read `/sys/fs/cgroup/cpu.max` and nothing else.
 * Under cgroup v2 the ROOT cgroup carries no `cpu.max`: the file exists on
 * every child and never on the root, so the read missed on every v2 host,
 * fell through to a v1 path that does not exist there either, and returned
 * `false` - "no bandwidth controller" - about a process that might be
 * inside a `CPUQuota=50%` unit. `measureHostPressure` then divided the
 * HOST's run queue by a CPU count the process may not have, which is the
 * confident-number-over-a-degenerate-metric this module opens by
 * forbidding.
 *
 * So the cgroup this process is actually in is read from
 * `/proc/self/cgroup` first, and the interface is looked up on it and on
 * every ancestor, because the effective limit is the minimum over the
 * chain.
 *
 * The three refusals, each its own answer rather than a shrug:
 *
 *   - `/proc/self/cgroup` unreadable, or naming no hierarchy this build
 *     understands: which cgroup governs this process is unknown, so
 *     nothing may be claimed about its quota.
 *   - an interface file that exists and refuses to be read, or whose
 *     contents do not parse.
 *   - on Linux, a chain on which no interface file exists at all: the
 *     cpu controller is not enabled here, and no bandwidth limit can be
 *     applied through a controller that is not there - `false`.
 *
 * A platform with no cgroups at all (macOS) is `false` for the same
 * reason and not `null`: the question is answerable there and the answer
 * is that there is no such controller.
 */
export function probeCpuQuota(src: CgroupSource = liveCgroupSource()): boolean | null {
  if (src.platform !== CGROUP_PLATFORM) return false;

  const self = readInterface(src.selfCgroupPath);
  if (self.kind !== "text") return null;
  const membership = parseSelfCgroup(self.text);

  if (membership.v2Path !== null) {
    const answer = fromChain(
      walkChain(ancestorDirs(src.cgroupRoot, membership.v2Path), CGROUP_V2_CPU_MAX, parseV2Quota),
    );
    // Answered - including "unknown" - it is the answer. Only
    // `no_interface` falls through, and only to a v1 hierarchy this
    // process was also told it belongs to (the hybrid layout).
    if (answer !== undefined) return answer;
    if (membership.v1 === null) return false;
  }

  if (membership.v1 === null) return null;
  // The v1 cpu controller is mounted under its controller list
  // (`cpu,cpuacct` on most hosts) or under the bare controller name.
  const mounts = [membership.v1.controllers, CGROUP_V1_CPU_CONTROLLER].filter(
    (m, i, all) => all.indexOf(m) === i,
  );
  for (const mount of mounts) {
    const answer = fromChain(
      walkChain(
        ancestorDirs(join(src.cgroupRoot, mount), membership.v1.path),
        CGROUP_V1_CPU_QUOTA,
        parseV1Quota,
      ),
    );
    if (answer !== undefined) return answer;
  }
  // Named a cpu hierarchy and found no interface under either mount: the
  // controller is not enabled where this build can see it.
  return false;
}

/** The live paths, read at call time so a test never has to patch a module. */
export function liveCgroupSource(): CgroupSource {
  return {
    platform: platform(),
    selfCgroupPath: "/proc/self/cgroup",
    cgroupRoot: "/sys/fs/cgroup",
  };
}

/**
 * Everything {@link readHostPressureProbe} reads, in one injectable
 * record.
 *
 * The three runtime readings are functions rather than values because
 * two of them are syscalls that a runtime may not implement, and this
 * module's whole argument is that an unavailable reading must arrive as a
 * named refusal rather than as a plausible number or a thrown error.
 */
export interface HostPressureIo extends CgroupSource {
  /** `os.loadavg()`. */
  readonly loadAverage: () => ReadonlyArray<number>;
  /** `os.availableParallelism()`. */
  readonly cpuCount: () => number;
}

export const LIVE_HOST_PRESSURE_IO: HostPressureIo = Object.freeze({
  ...liveCgroupSource(),
  platform: platform(),
  loadAverage: () => loadavg(),
  cpuCount: () => availableParallelism(),
});

/**
 * Gather the live facts.
 *
 * `platform` is a property read that cannot fail. The other two are
 * syscall-backed (`uv_loadavg`, `uv_available_parallelism`) and a runtime
 * that does not implement one throws rather than returning a wrong
 * number - so each is caught and turned into the value
 * {@link measureHostPressure} already names: `NaN` is
 * `load_average_invalid`, a non-count is `parallelism_unknown`. That is
 * why this function does not throw: not because the reads cannot fail,
 * but because a failure has somewhere honest to go.
 */
export function readHostPressureProbe(
  io: HostPressureIo = LIVE_HOST_PRESSURE_IO,
): HostPressureProbe {
  let loadAverage1m: number;
  try {
    loadAverage1m = io.loadAverage()[0] ?? Number.NaN;
  } catch {
    loadAverage1m = Number.NaN;
  }
  let cpuCount: number;
  try {
    cpuCount = io.cpuCount();
  } catch {
    cpuCount = Number.NaN;
  }
  return {
    platform: io.platform,
    loadAverage1m,
    cpuCount,
    cpuQuotaInForce: probeCpuQuota(io),
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
