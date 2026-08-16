/**
 * Whether a search origin can be read at all (a-label-is-not-a-boundary, U5).
 *
 * `listSearchOrigins` used to drop an origin whose directory had gone away
 * before the search fan-out ever saw it, so a union over N origins with one
 * dead origin answered as though that origin had honestly contributed
 * nothing. An origin that was never read is not an origin that held no
 * match, and the two must not arrive at a caller wearing the same face.
 *
 * The split is the one {@link statOrAbsent} already draws for the plugin
 * config and {@link RecallSourceStatus} draws for the registry: absence is
 * ENOENT on the path itself, and every other errno is a failure to ANSWER
 * the question rather than an answer. `isDir` deliberately collapses the
 * two - its own docblock says a caller whose OUTPUT distinguishes them must
 * probe with `statOrAbsent` and report the reason - and this is that caller.
 */

import { statOrAbsent } from "../../fs-utils.ts";

/** How much a probe learned about one origin. */
export const ORIGIN_REACH = Object.freeze({
  /** The path is a directory: the origin can be searched. */
  reachable: "reachable",
  /** The probe answered, and the origin is not there. */
  unreachable: "unreachable",
  /** The probe could not answer; nothing was learned. Never a synonym for absent. */
  unknown: "unknown",
} as const);

/** Closed union over {@link ORIGIN_REACH}. */
export type OriginReach = (typeof ORIGIN_REACH)[keyof typeof ORIGIN_REACH];

/** Membership list, from most-known to least-known. */
export const ORIGIN_REACHES: ReadonlyArray<OriginReach> = Object.freeze([
  ORIGIN_REACH.reachable,
  ORIGIN_REACH.unreachable,
  ORIGIN_REACH.unknown,
]);

/** Narrow a value read back off a payload or across a tool boundary. */
export function isOriginReach(value: unknown): value is OriginReach {
  return typeof value === "string" && (ORIGIN_REACHES as ReadonlyArray<string>).includes(value);
}

/**
 * Why an origin is not reachable. Each member is a fact the probe
 * established, never a guess, and each names a different repair: a missing
 * vault is detached or restored, a path that is not a directory is a
 * mistyped registry entry, and an unreadable one is a permission or device
 * fault on a vault that may be perfectly intact.
 *
 * These values ride the retrieval trail's `detail`, so they are identifiers
 * under {@link RETRIEVAL_DETAIL_IDENTIFIER} and carry no path and no errno
 * message.
 */
export const ORIGIN_REACH_REASON = Object.freeze({
  /** Nothing exists at the registered path. */
  vaultMissing: "vault-missing",
  /** Something exists there and it is not a directory. */
  vaultNotDirectory: "vault-not-directory",
  /** The path could not be examined, so the origin's state is unknown. */
  vaultUnreadable: "vault-unreadable",
} as const);

/** Closed union over {@link ORIGIN_REACH_REASON}. */
export type OriginReachReason = (typeof ORIGIN_REACH_REASON)[keyof typeof ORIGIN_REACH_REASON];

/** Membership list, in probe order. */
export const ORIGIN_REACH_REASONS: ReadonlyArray<OriginReachReason> = Object.freeze([
  ORIGIN_REACH_REASON.vaultMissing,
  ORIGIN_REACH_REASON.vaultNotDirectory,
  ORIGIN_REACH_REASON.vaultUnreadable,
]);

/** Narrow a value read back off a payload or across a tool boundary. */
export function isOriginReachReason(value: unknown): value is OriginReachReason {
  return (
    typeof value === "string" && (ORIGIN_REACH_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/** One probe's verdict. `reason` is absent exactly when the origin is reachable. */
export interface OriginReachVerdict {
  readonly reach: OriginReach;
  readonly reason?: OriginReachReason;
}

const REACHABLE: OriginReachVerdict = Object.freeze({ reach: ORIGIN_REACH.reachable });

/**
 * Errno of a stat that failed for a reason other than ENOENT (which
 * `statOrAbsent` reports as `undefined` instead of throwing). ENOTDIR means
 * a component of the path is a file, so the vault provably is not there;
 * anything else left the question unanswered.
 */
const ERRNO_NOT_A_DIRECTORY = "ENOTDIR";

function verdict(reason: OriginReachReason, reach: OriginReach): OriginReachVerdict {
  return Object.freeze({ reach, reason });
}

/**
 * Probe one origin path. Never throws: the failure to look IS one of the
 * three answers, and a caller enumerating origins must not lose the other
 * origins to one bad entry.
 */
export function probeOriginReach(vault: string): OriginReachVerdict {
  try {
    const stats = statOrAbsent(vault);
    if (stats === undefined) {
      return verdict(ORIGIN_REACH_REASON.vaultMissing, ORIGIN_REACH.unreachable);
    }
    if (!stats.isDirectory()) {
      return verdict(ORIGIN_REACH_REASON.vaultNotDirectory, ORIGIN_REACH.unreachable);
    }
    return REACHABLE;
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException | undefined)?.code;
    return code === ERRNO_NOT_A_DIRECTORY
      ? verdict(ORIGIN_REACH_REASON.vaultNotDirectory, ORIGIN_REACH.unreachable)
      : verdict(ORIGIN_REACH_REASON.vaultUnreadable, ORIGIN_REACH.unknown);
  }
}
