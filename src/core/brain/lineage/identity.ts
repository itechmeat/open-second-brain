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
 *   2. the ENVIRONMENT (`OPEN_SECOND_BRAIN_WORK_ID` and the lane twin),
 *      then the CONFIG KEY (`work_id` / `lane_id`) - one shell, one work
 *      item, which is how an operator declares identity to a host that
 *      does not;
 *   3. the per-worktree MARKER under the Brain state directory, which is
 *      the last declaration this worktree saw, persisted verbatim.
 *
 * The first rung that declares EITHER field supplies BOTH - and the
 * environment and the config file are two SEPARATE rungs for exactly
 * that reason, never one rung with a per-field fallback. A lane taken
 * from one source and a work id from another would compose an identity
 * nobody declared, and because a lane is a hard separator that composite
 * could refuse a link both declarations agreed on.
 *
 * ## One marker file per worktree, bounded in time and in count
 *
 * The marker is keyed by the hash of the worktree path and holds what was
 * declared plus the INSTANT it was declared. One file per worktree rather
 * than one shared table: a replicated table has to be merged, and merging
 * declarations is exactly the union registry this unit refuses to build.
 * Two devices editing the same worktree's marker produce a Syncthing
 * conflict file beside it, which is visible and reversible.
 *
 * Two bounds apply to this rung, and only to this rung:
 *
 *   - STALENESS. A marker older than {@link WORK_IDENTITY_MARKER_MAX_AGE_MS}
 *     declares nothing. Rungs 1 and 2 stay unbounded: a payload or an
 *     environment declaration is an explicit act by something that is
 *     live right now, so it must still re-attach work resumed after a
 *     month. The marker is not an act - it is what the directory last
 *     saw, inherited by every later session there with no expiry - so
 *     without a bound each unrelated conversation in that directory
 *     chains onto the previous one and `depth` grows without end. This
 *     module holds that a FALSE stitch is strictly worse than a missed
 *     one, and an indefinite inherited stitch is the false kind.
 *
 *     The instant is refreshed by a live declaration (see
 *     {@link recordWorkIdentityMarker}), so continuous declared work
 *     keeps inheriting; only a directory nothing has declared in for
 *     longer than the bound goes quiet.
 *
 *   - COUNT. The directory holds at most
 *     {@link WORK_IDENTITY_MARKER_MAX_FILES} files, compacted in the
 *     ledger's idiom (a cap that triggers, a retained remainder) so a CI
 *     runner or a `git worktree` flow checking out to a fresh path per
 *     job cannot leave one permanent file per job behind.
 *
 * ## Clearing a marker
 *
 * {@link clearWorkIdentityMarker} removes one worktree's marker, and the
 * file it removes is the one {@link workIdentityMarkerPath} names - so
 * deleting that path by hand (or the whole `work-identity` directory) is
 * an equally supported way to make the rung forget. Nothing else in the
 * system depends on a marker existing: the two rungs above it and the
 * timing crutch below are untouched by its absence.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
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

/** Injected clock, shared by every entry point that ages a marker. */
export interface WorkIdentityClockOptions {
  /** Epoch ms. Defaults to the wall clock. */
  readonly nowMs?: number;
}

export interface ResolveWorkIdentityInput extends WorkIdentityClockOptions {
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

/**
 * How long an INHERITED declaration keeps speaking for a worktree.
 *
 * Matched to the lineage gap sidecar's retention window: both bound how
 * long a point-in-time observation keeps being treated as current. A week
 * is long enough to carry work across a weekend or a switch of machine -
 * the resumption this rung exists for - and short enough that a directory
 * nobody has declared anything in stops adopting new conversations into
 * old work.
 */
export const WORK_IDENTITY_MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often a live, UNCHANGED declaration rewrites its marker.
 *
 * The instant has to move forward or continuous declared work would go
 * stale mid-flight, but rewriting on every lifecycle event would churn a
 * Syncthing-replicated file many times a minute for no new information.
 * One hour keeps the recorded instant accurate to within an hour of a
 * seven-day bound - three orders of magnitude of slack.
 */
export const WORK_IDENTITY_MARKER_REFRESH_MS = 60 * 60 * 1000;

/**
 * Marker files retained. The pair is the ledger's compaction idiom: the
 * cap is what TRIGGERS a sweep, the retained count is what survives one,
 * so the sweep is amortized rather than run on every write.
 */
export const WORK_IDENTITY_MARKER_MAX_FILES = 256;
const RETAIN_WORK_IDENTITY_MARKERS = 128;

/** On-disk marker shape. `worktree` is the key, restated so the file is legible. */
interface WorkIdentityMarkerFile {
  readonly worktree: string;
  readonly wid?: string;
  readonly lane?: string;
  /** ISO-8601 instant of the declaration this file records. */
  readonly at?: string;
}

/**
 * Resolve the declaration that applies to this session, or `null` when
 * no rung declares one. The rungs are tried in the order documented
 * above and the first that yields anything is taken whole.
 */
export function resolveWorkIdentity(input: ResolveWorkIdentityInput): DeclaredWorkIdentity | null {
  const payload = compose(input.payloadWorkId, input.payloadLaneId, WORK_IDENTITY_SOURCE.payload);
  if (payload !== null) return payload;

  // The shell and the config file are two rungs, tried in that order and
  // each taken WHOLE. A per-field fallback would let a work id from the
  // shell compose with a lane from the file - the composite identity
  // nobody declared that the rung boundary exists to prevent.
  const env = input.env ?? process.env;
  const declaredEnv = compose(
    env[WORK_ID_ENV_KEY],
    env[LANE_ID_ENV_KEY],
    WORK_IDENTITY_SOURCE.environment,
  );
  if (declaredEnv !== null) return declaredEnv;

  const config = discoverConfig(input.configPath).data;
  const declaredConfig = compose(
    config[WORK_ID_CONFIG_KEY],
    config[LANE_ID_CONFIG_KEY],
    WORK_IDENTITY_SOURCE.environment,
  );
  if (declaredConfig !== null) return declaredConfig;

  if (input.worktree === undefined) return null;
  return readWorkIdentityMarker(input.vault, input.worktree, {
    nowMs: input.nowMs ?? Date.now(),
  });
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
 *
 * A marker older than {@link WORK_IDENTITY_MARKER_MAX_AGE_MS}, and one
 * that records no instant at all, declare nothing. The second case is
 * deliberate and asymmetric with the gap sidecar's "an undatable record
 * never expires": there, an unexpiring record over-REPORTS; here it would
 * over-LINK, and a false stitch is the outcome this ladder refuses.
 */
export function readWorkIdentityMarker(
  vault: string,
  worktree: string,
  opts: WorkIdentityClockOptions = {},
): DeclaredWorkIdentity | null {
  const marker = readMarkerFile(workIdentityMarkerPathSafe(vault, worktree));
  if (marker === null || marker.worktree !== worktree) return null;
  if (markerAgeMs(marker, opts.nowMs ?? Date.now()) === null) return null;
  return compose(marker.wid, marker.lane, WORK_IDENTITY_SOURCE.marker);
}

/**
 * Forget one worktree's marker. Returns whether a marker was there to
 * remove, so "cleared" and "there was nothing to clear" stay
 * distinguishable; both are success. Fail-soft like the rest of this
 * path - an unremovable file reports `false` rather than raising into a
 * lifecycle hook.
 */
export function clearWorkIdentityMarker(vault: string, worktree: string): boolean {
  try {
    const path = workIdentityMarkerPath(vault, worktree);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The marker path, or `null` when it cannot be formed (guard refusal). */
function workIdentityMarkerPathSafe(vault: string, worktree: string): string | null {
  try {
    return workIdentityMarkerPath(vault, worktree);
  } catch {
    return null;
  }
}

/** Parse one marker file, or `null` when it is absent or unusable. */
function readMarkerFile(path: string | null): WorkIdentityMarkerFile | null {
  if (path === null) return null;
  let parsed: unknown;
  try {
    if (!existsSync(path)) return null;
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const marker = parsed as WorkIdentityMarkerFile;
  return typeof marker.worktree === "string" ? marker : null;
}

/**
 * Age of a marker in ms, or `null` when it is undatable or past the
 * staleness bound - the two cases that mean "this declares nothing".
 */
function markerAgeMs(marker: WorkIdentityMarkerFile, nowMs: number): number | null {
  const declaredAt = typeof marker.at === "string" ? Date.parse(marker.at) : Number.NaN;
  if (!Number.isFinite(declaredAt)) return null;
  const age = nowMs - declaredAt;
  return age > WORK_IDENTITY_MARKER_MAX_AGE_MS ? null : age;
}

/**
 * Persist a declaration as this worktree's marker, so a later session
 * that the host does not tell about it still resolves the same work
 * item. Records the declaration VERBATIM - it never merges with what the
 * file already held, because a merge is the accumulating registry this
 * module refuses to build.
 *
 * The recorded instant is what the read path ages against, so only a
 * caller holding a LIVE declaration may call this - `session-lifecycle.ts`
 * skips a marker-sourced identity for exactly that reason. Handing back
 * what the marker itself supplied would refresh it forever and the
 * staleness bound would mean nothing.
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
  opts: WorkIdentityClockOptions = {},
): WorkIdentityMarkerStatus {
  assertVaultIdentityForWrite(vault);
  const nowMs = opts.nowMs ?? Date.now();
  const wid = declaredValue(declaration.workId);
  const lane = declaredValue(declaration.laneId);
  const path = workIdentityMarkerPath(vault, worktree);
  // An unchanged declaration still refreshes the recorded instant, so
  // work that keeps being declared keeps being inheritable - but only
  // once per refresh interval, so a replicated file is not rewritten on
  // every lifecycle event to say the same thing.
  const existing = readMarkerFile(path);
  if (
    existing !== null &&
    existing.worktree === worktree &&
    existing.wid === wid &&
    existing.lane === lane
  ) {
    const age = markerAgeMs(existing, nowMs);
    if (age !== null && age >= 0 && age < WORK_IDENTITY_MARKER_REFRESH_MS) {
      return WORK_IDENTITY_MARKER_STATUS.unchanged;
    }
  }
  const body: WorkIdentityMarkerFile = {
    worktree,
    ...(wid !== undefined ? { wid } : {}),
    ...(lane !== undefined ? { lane } : {}),
    at: new Date(nowMs).toISOString(),
  };
  const dir = join(brainStateDirPath(vault), MARKER_DIR);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(body)}\n`);
  boundMarkerDirectory(dir, path, nowMs);
  return WORK_IDENTITY_MARKER_STATUS.written;
}

/**
 * Keep the marker directory bounded, in the ledger's compaction idiom:
 * the cap TRIGGERS a sweep, the retained count is what survives one, so
 * the directory is not re-read on every write.
 *
 * What goes first is what has least to say: markers that are expired or
 * undatable (they already declare nothing) before live ones, and among
 * live ones the oldest. The marker just written is never a candidate.
 * Best-effort - the bound is hygiene, and a directory that cannot be
 * swept must not cost a lifecycle hook its capture.
 */
function boundMarkerDirectory(dir: string, keepPath: string, nowMs: number): void {
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith(MARKER_FILE_SUFFIX));
    if (names.length <= WORK_IDENTITY_MARKER_MAX_FILES) return;
    const entries = names
      .map((name) => join(dir, name))
      .filter((path) => path !== keepPath)
      .map((path) => {
        const marker = readMarkerFile(path);
        return { path, age: marker === null ? null : markerAgeMs(marker, nowMs) };
      });
    // Expired / undatable first (age null), then oldest first.
    const ordered = entries.toSorted((a, b) => {
      if (a.age === null || b.age === null) return a.age === b.age ? 0 : a.age === null ? -1 : 1;
      return b.age - a.age;
    });
    const removeCount = names.length - RETAIN_WORK_IDENTITY_MARKERS;
    for (const entry of ordered.slice(0, removeCount)) unlinkSync(entry.path);
  } catch {
    // Best-effort; the marker itself is already written.
  }
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
