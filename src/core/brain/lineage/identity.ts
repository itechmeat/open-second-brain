/**
 * Declared work identity (signals-that-survive, Unit 9; kanban
 * t_e6be4f6b).
 *
 * Session continuation had two durable signals - the lineage the host
 * declared on the payload, and a fifteen-minute freshness window
 * (`CRUTCH_LINK_WINDOW_MS`). Neither survives a resumption: a work item
 * picked up again after a model, account, branch or worktree switch is
 * outside the window and in a different working state, so the resolver
 * correctly refuses to link it and the continuity is lost. This module
 * supplies the third signal - a work id and a lane id - which the
 * resolver ranks ABOVE the window because it does not decay.
 *
 * ## Declared, never derived
 *
 * Every value here is something a host, an operator or an earlier
 * declaration WROTE DOWN. Nothing fingerprints a git remote, a
 * merge-base or a gitdir, and nothing accumulates a union of the
 * identities it has seen. The vault is Syncthing-replicated with no
 * arbiter: a cumulative registry would be effectively irreversible
 * there, and a structurally derived identity would silently redefine
 * which sessions are "the same work" whenever the structure moved.
 *
 * ## Three rungs, in strict precedence
 *
 *   1. the HOST PAYLOAD (`work_id` / `lane_id` on the lifecycle hook) -
 *      the only rung that can distinguish two concurrent work items in
 *      one directory, so it wins;
 *   2. the ENVIRONMENT, then the CONFIG KEY (`OPEN_SECOND_BRAIN_WORK_ID`
 *      / `work_id`, and the lane twin) - one shell, one work item, which
 *      is how an operator declares identity to a host that does not;
 *   3. the per-worktree MARKER under the Brain state directory, which is
 *      the last declaration this worktree saw, persisted verbatim.
 *
 * The first rung that declares EITHER field supplies BOTH. A lane taken
 * from one rung and a work id from another would compose an identity
 * nobody declared, and because a lane is a hard separator that composite
 * could refuse a link both declarations agreed on.
 *
 * ## One marker file per worktree
 *
 * The marker is keyed by the hash of the worktree path and holds only
 * what was declared. One file per worktree rather than one shared table:
 * a replicated table has to be merged, and merging declarations is
 * exactly the union registry this unit refuses to build. Two devices
 * editing the same worktree's marker produce a Syncthing conflict file
 * beside it, which is visible and reversible.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig } from "../../config.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { ensureInsideVault } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { brainStateDirPath } from "./ledger.ts";

/** Where a declaration was read from. Ordered by precedence. */
export const WORK_IDENTITY_SOURCE = Object.freeze({
  /** The lifecycle hook payload named it. */
  payload: "payload",
  /** An environment variable or the plugin config key named it. */
  environment: "environment",
  /** The per-worktree marker recorded by an earlier declaration. */
  marker: "marker",
} as const);

export type WorkIdentitySource = (typeof WORK_IDENTITY_SOURCE)[keyof typeof WORK_IDENTITY_SOURCE];

/**
 * One resolved declaration. At least one of the two fields is present -
 * a result with neither is not a declaration and is returned as `null`,
 * so a caller can never mistake an empty identity for a declared one.
 */
export interface DeclaredWorkIdentity {
  readonly workId?: string;
  readonly laneId?: string;
  readonly source: WorkIdentitySource;
}

export interface ResolveWorkIdentityInput {
  readonly vault: string;
  /** `work_id` as the lifecycle hook payload carried it. */
  readonly payloadWorkId?: string;
  /** `lane_id` as the lifecycle hook payload carried it. */
  readonly payloadLaneId?: string;
  /** Working directory of the session; the key of the marker rung. */
  readonly worktree?: string;
  /** Injected environment. Defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Plugin config file, threaded to `discoverConfig`. */
  readonly configPath?: string;
}

/** What a caller declares when it records a marker. */
export interface WorkIdentityDeclaration {
  readonly workId?: string;
  readonly laneId?: string;
}

/** Whether {@link recordWorkIdentityMarker} changed anything on disk. */
export const WORK_IDENTITY_MARKER_STATUS = Object.freeze({
  written: "written",
  unchanged: "unchanged",
} as const);

export type WorkIdentityMarkerStatus =
  (typeof WORK_IDENTITY_MARKER_STATUS)[keyof typeof WORK_IDENTITY_MARKER_STATUS];

const WORK_ID_ENV_KEY = "OPEN_SECOND_BRAIN_WORK_ID";
const LANE_ID_ENV_KEY = "OPEN_SECOND_BRAIN_LANE_ID";
const WORK_ID_CONFIG_KEY = "work_id";
const LANE_ID_CONFIG_KEY = "lane_id";

/** Directory holding one marker file per worktree. */
const MARKER_DIR = "work-identity";
const MARKER_FILE_SUFFIX = ".json";

/** On-disk marker shape. `worktree` is the key, restated so the file is legible. */
interface WorkIdentityMarkerFile {
  readonly worktree: string;
  readonly wid?: string;
  readonly lane?: string;
}

/**
 * Resolve the declaration that applies to this session, or `null` when
 * no rung declares one. The rungs are tried in the order documented
 * above and the first that yields anything is taken whole.
 */
export function resolveWorkIdentity(input: ResolveWorkIdentityInput): DeclaredWorkIdentity | null {
  const payload = compose(input.payloadWorkId, input.payloadLaneId, WORK_IDENTITY_SOURCE.payload);
  if (payload !== null) return payload;

  const env = input.env ?? process.env;
  const config = discoverConfig(input.configPath).data;
  const declaredEnv = compose(
    env[WORK_ID_ENV_KEY] ?? config[WORK_ID_CONFIG_KEY],
    env[LANE_ID_ENV_KEY] ?? config[LANE_ID_CONFIG_KEY],
    WORK_IDENTITY_SOURCE.environment,
  );
  if (declaredEnv !== null) return declaredEnv;

  if (input.worktree === undefined) return null;
  return readWorkIdentityMarker(input.vault, input.worktree);
}

/** Path of the marker file for one worktree. */
export function workIdentityMarkerPath(vault: string, worktree: string): string {
  const file = `${createHash("sha256").update(worktree, "utf8").digest("hex")}${MARKER_FILE_SUFFIX}`;
  return ensureInsideVault(join(brainStateDirPath(vault), MARKER_DIR, file), vault);
}

/**
 * Read the marker recorded for one worktree. Fail-soft like every other
 * read on this path: a missing, unreadable or unparseable marker is
 * simply no declaration, which lets the rung below decide rather than
 * raising into a lifecycle hook. A marker whose recorded worktree is not
 * the one being asked about describes different work and is not read.
 */
export function readWorkIdentityMarker(
  vault: string,
  worktree: string,
): DeclaredWorkIdentity | null {
  let parsed: unknown;
  try {
    const path = workIdentityMarkerPath(vault, worktree);
    if (!existsSync(path)) return null;
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const marker = parsed as WorkIdentityMarkerFile;
  if (marker.worktree !== worktree) return null;
  return compose(marker.wid, marker.lane, WORK_IDENTITY_SOURCE.marker);
}

/**
 * Persist a declaration as this worktree's marker, so a later session
 * that the host does not tell about it still resolves the same work
 * item. Records the declaration VERBATIM - it never merges with what the
 * file already held, because a merge is the accumulating registry this
 * module refuses to build.
 *
 * Throws only where a write genuinely cannot be trusted (the vault
 * identity guard, an unwritable state directory); the capture boundary
 * treats a marker failure as a non-blocker, exactly as it treats the
 * other enhancements that ride the lifecycle hook.
 */
export function recordWorkIdentityMarker(
  vault: string,
  worktree: string,
  declaration: WorkIdentityDeclaration,
): WorkIdentityMarkerStatus {
  assertVaultIdentityForWrite(vault);
  const wid = declaredValue(declaration.workId);
  const lane = declaredValue(declaration.laneId);
  const body: WorkIdentityMarkerFile = {
    worktree,
    ...(wid !== undefined ? { wid } : {}),
    ...(lane !== undefined ? { lane } : {}),
  };
  const serialized = `${JSON.stringify(body)}\n`;
  const path = workIdentityMarkerPath(vault, worktree);
  if (existsSync(path) && readFileSync(path, "utf8") === serialized) {
    return WORK_IDENTITY_MARKER_STATUS.unchanged;
  }
  mkdirSync(join(brainStateDirPath(vault), MARKER_DIR), { recursive: true });
  atomicWriteFileSync(path, serialized);
  return WORK_IDENTITY_MARKER_STATUS.written;
}

/**
 * Build a declaration from one rung's pair, or `null` when that rung
 * declared neither field. Blank is not a declaration: a host that sends
 * an empty string has said nothing, and treating it as a value would
 * make every such session share one identity.
 */
function compose(
  workId: string | undefined,
  laneId: string | undefined,
  source: WorkIdentitySource,
): DeclaredWorkIdentity | null {
  const wid = declaredValue(workId);
  const lane = declaredValue(laneId);
  if (wid === undefined && lane === undefined) return null;
  return Object.freeze({
    ...(wid !== undefined ? { workId: wid } : {}),
    ...(lane !== undefined ? { laneId: lane } : {}),
    source,
  });
}

/** A trimmed non-empty declaration, or `undefined`. */
function declaredValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
