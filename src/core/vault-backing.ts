/**
 * What filesystem backs the resolved vault path.
 *
 * This module exists because of what it refuses to answer. The question it
 * was asked was "is this machine local, a cloud sandbox, or an ephemeral
 * container", and no signal a host exposes can settle it:
 *
 *   - `/.dockerenv` is written by Docker and by nothing else. Absent is
 *     the normal reading under podman, containerd/CRI-O, LXC,
 *     systemd-nspawn, and any image that removed it.
 *   - `/proc/1/cgroup` carried the classic heuristic on cgroup v1. On a
 *     cgroup v2 unified host - what a current kernel gives you - the line
 *     is `0::/<path>` inside a container and inside a plain systemd scope
 *     alike, so the heuristic is dead rather than weakened.
 *   - "cloud sandbox" has no signal that separates it from "container",
 *     and "container" is not "ephemeral": a bind-mounted volume inside a
 *     container outlives a laptop's `/tmp`.
 *
 * Every one of those signals is ONE-WAY. A positive is decent evidence of
 * containerisation; a negative is evidence of nothing at all. A classifier
 * built on them would answer "local, therefore durable" on exactly the
 * hosts where the answer matters most, which is a confident wrong answer
 * in place of an honest missing one.
 *
 * What CAN be established is narrower and is the claim an ownership
 * statement actually makes: which filesystem backs ONE path. A vault on
 * `tmpfs` is provably gone at reboot. A vault on an overlay is very likely
 * gone at container exit, and is at least not a plain disk. A vault on
 * ext4/xfs/btrfs/zfs is backed by storage that survives the process.
 * Everything else - an unrecognised magic number, a path that will not
 * stat, a platform with no such facility at all - is
 * {@link VAULT_BACKING.undetermined}, with a reason from a SEPARATE
 * vocabulary so a guard can never read a reason back as a verdict.
 *
 * Beside survival the probe answers one more axis, REMOTENESS: whether the
 * backing is a NAMED network filesystem. It is narrow by the same
 * discipline. Only nfs and cifs classify remote, because those are the
 * types whose storage is provably shared with another host and whose
 * locking semantics SQLite's WAL journal mode depends on and does not
 * get. Fuse stays non-remote: what backs a fuse mount is unknowable from
 * its type, and failing safe there would warn every user-space mount.
 * Everything the probe could not read - unknown type, unreadable path,
 * platform without statfs - is {@link VAULT_BACKING_REMOTENESS.nonRemote}
 * and SILENT: the absence of a network finding is never rendered as a
 * finding that the storage is local.
 *
 * The probe is Linux-only by construction. `statfs(2)`'s `f_type` is a
 * Linux filesystem magic number; the same field on macOS and the BSDs
 * means something else, so every other platform answers
 * `probe_unsupported` rather than being handed a number to misread.
 *
 * Pure and injectable: the platform and the `statfs` call are parameters,
 * so every state below is reachable in a unit test on any host.
 */

import { statfsSync } from "node:fs";

// ----- The verdict vocabulary ----------------------------------------------

/**
 * What the filesystem under a path says about the path's survival.
 *
 * Deliberately absent: any member meaning "local machine", "cloud
 * sandbox" or "ephemeral". See the module docblock - no signal separates
 * them, and naming one would be the guess this design exists to refuse.
 */
export const VAULT_BACKING = Object.freeze({
  /** Backed by storage that survives the process and a reboot. */
  durable: "durable",
  /** Proved memory-backed: the contents are gone at reboot. */
  volatile: "volatile",
  /** Proved container-overlay-backed: survival past container exit unknown. */
  layered: "layered",
  /** No verdict was reached; {@link VaultBackingVerdict.reason} says why. */
  undetermined: "undetermined",
} as const);

/** Closed union over {@link VAULT_BACKING}. */
export type VaultBackingState = (typeof VAULT_BACKING)[keyof typeof VAULT_BACKING];

/** Membership list, in order from most durable to least known. */
export const VAULT_BACKING_STATES: ReadonlyArray<VaultBackingState> = Object.freeze([
  VAULT_BACKING.durable,
  VAULT_BACKING.layered,
  VAULT_BACKING.volatile,
  VAULT_BACKING.undetermined,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isVaultBackingState(value: unknown): value is VaultBackingState {
  return (
    typeof value === "string" && (VAULT_BACKING_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Why the probe reached no verdict.
 *
 * A separate vocabulary rather than three more members on the one above,
 * because a reason is not a verdict: folding them together lets a guard
 * accept `path_unreadable` everywhere a state is expected, and lets a
 * renderer print a cause where a conclusion belongs.
 */
export const VAULT_BACKING_UNDETERMINED_REASON = Object.freeze({
  /** The platform exposes no filesystem-type facility this build can read. */
  probeUnsupported: "probe_unsupported",
  /** The path could not be stat'd at all. */
  pathUnreadable: "path_unreadable",
  /** A filesystem magic number this build does not recognise. */
  fsTypeUnknown: "fs_type_unknown",
} as const);

/** Closed union over {@link VAULT_BACKING_UNDETERMINED_REASON}. */
export type VaultBackingUndeterminedReason =
  (typeof VAULT_BACKING_UNDETERMINED_REASON)[keyof typeof VAULT_BACKING_UNDETERMINED_REASON];

/** Membership list for {@link VAULT_BACKING_UNDETERMINED_REASON}. */
export const VAULT_BACKING_UNDETERMINED_REASONS: ReadonlyArray<VaultBackingUndeterminedReason> =
  Object.freeze([
    VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported,
    VAULT_BACKING_UNDETERMINED_REASON.pathUnreadable,
    VAULT_BACKING_UNDETERMINED_REASON.fsTypeUnknown,
  ]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isVaultBackingUndeterminedReason(
  value: unknown,
): value is VaultBackingUndeterminedReason {
  return (
    typeof value === "string" &&
    (VAULT_BACKING_UNDETERMINED_REASONS as ReadonlyArray<string>).includes(value)
  );
}

// ----- The second axis: remoteness ------------------------------------------

/**
 * Whether the filesystem under a path is a NAMED network filesystem.
 *
 * A second axis beside {@link VAULT_BACKING}, not a new member on it.
 * Durability answers "do the bytes survive this process and this reboot"
 * - on nfs and cifs they do, which is why both stay `durable`. Remoteness
 * answers "is this storage shared with another host", which is the
 * question a consumer of cross-host-unsafe machinery (SQLite's WAL
 * journal mode and its shared-memory index) needs and which no durability
 * verdict can answer.
 *
 * Two members, and `nonRemote` is the one that earns the vocabulary: it
 * is deliberately NOT named `local`, because unknown and probe-unsupported
 * backings answer non-remote too, and "we found no network filesystem" is
 * not evidence that the storage is local.
 */
export const VAULT_BACKING_REMOTENESS = Object.freeze({
  /** Backed by a named network filesystem (nfs, cifs). */
  remote: "remote",
  /** No network filesystem was identified. Not a claim that the storage is local. */
  nonRemote: "non_remote",
} as const);

/** Closed union over {@link VAULT_BACKING_REMOTENESS}. */
export type VaultBackingRemoteness =
  (typeof VAULT_BACKING_REMOTENESS)[keyof typeof VAULT_BACKING_REMOTENESS];

/** Membership list for {@link VAULT_BACKING_REMOTENESS}. */
export const VAULT_BACKING_REMOTENESS_STATES: ReadonlyArray<VaultBackingRemoteness> = Object.freeze(
  [VAULT_BACKING_REMOTENESS.remote, VAULT_BACKING_REMOTENESS.nonRemote],
);

/** Narrow a string read back off disk or across a tool boundary. */
export function isVaultBackingRemoteness(value: unknown): value is VaultBackingRemoteness {
  return (
    typeof value === "string" &&
    (VAULT_BACKING_REMOTENESS_STATES as ReadonlyArray<string>).includes(value)
  );
}

// ----- The probe ------------------------------------------------------------

/**
 * One answer. `filesystem` and `reason` are exclusive by construction: a
 * verdict names the filesystem it read, an `undetermined` names why it
 * read none, and neither ever carries both.
 */
export interface VaultBackingVerdict {
  readonly state: VaultBackingState;
  /** Recognised filesystem name, or `null` when the state is undetermined. */
  readonly filesystem: string | null;
  /** Why no verdict was reached, or `null` when one was. */
  readonly reason: VaultBackingUndeterminedReason | null;
  /**
   * The second axis: whether the identified filesystem is a named network
   * one. `nonRemote` whenever no filesystem was identified at all - the
   * absence of a network finding, never a claim of local storage.
   */
  readonly remoteness: VaultBackingRemoteness;
  /** One line naming what was probed and what came back. */
  readonly detail: string;
}

/** The `statfs` facility, injectable so every branch is testable. */
export type StatfsProbe = (path: string) => { readonly type: number | bigint };

export interface VaultBackingOptions {
  /** Defaults to `process.platform`, following the house injection style. */
  readonly platform?: string;
  /** Defaults to `node:fs`'s `statfsSync`. */
  readonly statfs?: StatfsProbe;
}

/** The one platform whose `statfs` `f_type` is the magic number below. */
const PROBEABLE_PLATFORM = "linux";

/**
 * Linux filesystem magic numbers, each mapped to the state and remoteness
 * they prove.
 *
 * Only filesystems whose durability follows FROM THE TYPE are listed. A
 * type that is not here is `fs_type_unknown` rather than assumed durable -
 * the same polarity `declaredInputWindowTokens` uses for an unlisted
 * model, and for the same reason: reporting a pass for a condition nobody
 * measured is the misleading silence this release removes.
 *
 * Network filesystems are listed as durable deliberately. The vault living
 * on someone else's server is an availability question, not a survival
 * one: the bytes outlive this process and this reboot, which is the whole
 * claim the state makes. Sharing that server with other hosts is a
 * DIFFERENT question, answered by the second axis: nfs and cifs carry
 * `remote` because their storage is provably cross-host and their locking
 * semantics are the ones SQLite's WAL journal mode cannot rely on. Fuse
 * carries `nonRemote` deliberately too: what backs a fuse mount is
 * unknowable from the type, and failing safe there would put the warning
 * on every user-space mount rather than on the network ones.
 */
const FS_MAGIC: ReadonlyMap<
  number,
  {
    readonly name: string;
    readonly state: VaultBackingState;
    readonly remote: VaultBackingRemoteness;
  }
> = new Map([
  // Memory-backed: provably lost at reboot.
  [
    0x01021994,
    { name: "tmpfs", state: VAULT_BACKING.volatile, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x858458f6,
    { name: "ramfs", state: VAULT_BACKING.volatile, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  // Union mount: a container's root by default, survival unknown.
  [
    0x794c7630,
    { name: "overlayfs", state: VAULT_BACKING.layered, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0xaad7aaea,
    { name: "aufs", state: VAULT_BACKING.layered, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  // Storage that outlives the process and a reboot.
  [
    0xef53,
    { name: "ext4", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x9123683e,
    { name: "btrfs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x58465342,
    { name: "xfs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x2fc12fc1,
    { name: "zfs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0xf2f52010,
    { name: "f2fs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  // Cross-host storage: durable AND remote, the two axes independently.
  [0x6969, { name: "nfs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.remote }],
  [
    0xff534d42,
    { name: "cifs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.remote },
  ],
  // Backing unknowable from the type; non-remote rather than every
  // user-space mount being warned about.
  [
    0x65735546,
    { name: "fuse", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x4d44,
    { name: "vfat", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
  [
    0x52654973,
    { name: "reiserfs", state: VAULT_BACKING.durable, remote: VAULT_BACKING_REMOTENESS.nonRemote },
  ],
]);

function hex(type: number): string {
  return `0x${type.toString(16)}`;
}

function undetermined(reason: VaultBackingUndeterminedReason, detail: string): VaultBackingVerdict {
  return {
    state: VAULT_BACKING.undetermined,
    filesystem: null,
    reason,
    // Silent: nothing was read, so no remoteness finding is claimed.
    remoteness: VAULT_BACKING_REMOTENESS.nonRemote,
    detail,
  };
}

/**
 * Probe the filesystem backing `path`.
 *
 * Never throws: a path that will not stat is a verdict, not a fault - this
 * runs beside an ownership statement whose whole point is that it stays
 * honest on hosts it cannot measure.
 */
export function probeVaultBacking(
  path: string,
  opts: VaultBackingOptions = {},
): VaultBackingVerdict {
  const platform = opts.platform ?? process.platform;
  if (platform !== PROBEABLE_PLATFORM) {
    return undetermined(
      VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported,
      `the filesystem backing ${path} was not probed: statfs f_type is a ${PROBEABLE_PLATFORM} ` +
        `magic number and this host is ${platform}`,
    );
  }
  const statfs = opts.statfs ?? statfsSync;
  let type: number;
  try {
    type = Number(statfs(path).type);
  } catch (err) {
    return undetermined(
      VAULT_BACKING_UNDETERMINED_REASON.pathUnreadable,
      `the filesystem backing ${path} could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const known = FS_MAGIC.get(type);
  if (known === undefined) {
    return undetermined(
      VAULT_BACKING_UNDETERMINED_REASON.fsTypeUnknown,
      `${path} is backed by filesystem type ${hex(type)}, which this build does not recognise`,
    );
  }
  return {
    state: known.state,
    filesystem: known.name,
    reason: null,
    remoteness: known.remote,
    detail: `${path} is backed by ${known.name} (${hex(type)})`,
  };
}
