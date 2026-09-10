/**
 * The fleet freeze, read side: one marker file, honoured by every writer
 * on every device (who-wrote-what, Task C).
 *
 * An operator running several agents on several machines has no single
 * stop. Killing one process stops one process; a Syncthing peer that was
 * mid-pass keeps writing, and the vault the operator is trying to hold
 * still moves under them. The stop this module supplies is a FILE -
 * `Brain/.state/frozen.json` - because a file is the only thing every
 * device already agrees about: it rides the same sync channel the vault
 * does, so freezing on the laptop freezes the desktop as soon as the two
 * have talked, with nothing to install and no daemon to reach.
 *
 * ## Why this module imports almost nothing
 *
 * The freeze check runs inside `assertVaultIdentityForWrite`, which is
 * imported by `paths.ts`, which is imported by `log.ts`. So this module
 * must not reach any of the three: an edge back would close a cycle whose
 * cost is paid at module-initialisation time by every consumer in the
 * tree (`tests/core/architecture/import-cycles.test.ts` is the ratchet).
 * It therefore builds its own path from the leaf constants, exactly as
 * `vault-identity.ts` builds the identity marker's path, and the
 * `paths.ts` re-export is a convenience for callers rather than the
 * definition.
 *
 * ## An unreadable marker is a freeze
 *
 * The asymmetry with {@link readVaultIdentity} is deliberate and is the
 * one judgement in this module. An absent identity marker collapses to
 * "unknown" because a fresh vault and a wrong root look identical. A
 * marker that is PRESENT and does not parse carries no such ambiguity of
 * intent: somebody put a file called `frozen.json` in the state directory,
 * and the only reading under which a parse error should reopen the vault
 * is one where a truncated sync is allowed to cancel an operator's stop.
 * So a marker that cannot be read freezes, and the refusal names
 * {@link FREEZE_MARKER_UNREADABLE_REASON} rather than inventing a reason
 * it did not read.
 *
 * ## The two lanes
 *
 * The freeze cannot cover literally every write, because the events that
 * record the freeze - `freeze`, `unfreeze`, `write-refused` - are
 * themselves writes into `Brain/log/`. A freeze that silenced its own
 * audit trail would make the one state an operator most needs to
 * reconstruct the least recorded. {@link WRITE_LANE} names that split
 * once: `content` is everything the freeze holds, `audit` is the log
 * appender and this feature's own marker writer. A source-scan test pins
 * that `audit` is requested from those modules and nowhere else, so the
 * exemption cannot spread by being convenient.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureInsideVault } from "../path-safety.ts";
import {
  DEGRADATION_CODE,
  degradationNotice,
  formatDegradationNotice,
  type DegradationNotice,
} from "../integrity/degradation.ts";
import { BRAIN_INTERNAL_STATE_REL } from "./path-constants.ts";

/** Marker schema version. Bumped only on an incompatible field change. */
export const FREEZE_MARKER_SCHEMA_VERSION = 1;

/** Marker filename inside `Brain/.state/`. */
export const FROZEN_MARKER_FILE = "frozen.json";

/** Site name carried by every notice this module emits. */
const SITE = "brain.freeze";

/**
 * The one command that ends a freeze, spelled once.
 *
 * Every refusal carries it - the thrown error, the MCP refusal payload,
 * the doctor finding - because a stop with no named way out is a dead end
 * for whoever hits it, including the operator who set it.
 */
export const FREEZE_NEXT_COMMAND = "o2b brain unfreeze";

/**
 * The reason reported when the marker is present and could not be read.
 * See the module docblock for why that is a freeze and not an absence.
 */
export const FREEZE_MARKER_UNREADABLE_REASON = "marker-unreadable";

/**
 * Which half of the write surface a caller belongs to.
 *
 * `content` is everything the freeze exists to hold: notes, preferences,
 * signals, state, snapshots - every byte an agent or a pass produces.
 * `audit` is the record of what happened, which has to keep working while
 * the vault is frozen or the freeze erases its own evidence.
 */
export const WRITE_LANE = Object.freeze({
  content: "content",
  audit: "audit",
} as const);

export type WriteLane = (typeof WRITE_LANE)[keyof typeof WRITE_LANE];

/**
 * The durable freeze record. Like the identity marker it carries nothing
 * machine-local except `device_id`, which names the device that SET the
 * freeze rather than a path - so the file is byte-identical on every peer
 * and means the same thing on each of them.
 */
export interface FreezeMarker {
  readonly schema: number;
  /** When the freeze was set, ISO-8601 UTC. */
  readonly frozen_at: string;
  /** Agent identity that set it, as `resolveAgentName` reports it. */
  readonly by: string;
  /** Device that set it, or the empty string when unresolvable. */
  readonly device_id: string;
  /** Operator-supplied reason, or the empty string when none was given. */
  readonly reason: string;
}

/** Path of the freeze marker: `<vault>/Brain/.state/frozen.json`. */
export function frozenMarkerPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_INTERNAL_STATE_REL, FROZEN_MARKER_FILE), vault);
}

/**
 * A write was attempted against a frozen vault.
 *
 * Carries the marker's fields beside the structured notice so a caller -
 * the MCP boundary, a CLI verb, an internal writer - reports the evidence
 * rather than re-parsing the message. The shape mirrors
 * `VaultIdentityMismatchError`, which is the other refusal this guard can
 * raise, so both are handled the same way at a call site.
 */
export class VaultFrozenError extends Error {
  readonly notice: DegradationNotice;
  readonly frozen_at: string;
  readonly by: string;
  readonly reason: string;
  readonly next_command: string;

  constructor(notice: DegradationNotice, marker: FreezeMarker) {
    super(formatDegradationNotice(notice));
    this.name = "VaultFrozenError";
    this.notice = notice;
    this.frozen_at = marker.frozen_at;
    this.by = marker.by;
    this.reason = marker.reason;
    this.next_command = FREEZE_NEXT_COMMAND;
  }
}

/** The marker every present-but-unparseable file collapses to. */
const UNREADABLE_MARKER: FreezeMarker = Object.freeze({
  schema: FREEZE_MARKER_SCHEMA_VERSION,
  frozen_at: "",
  by: "",
  device_id: "",
  reason: FREEZE_MARKER_UNREADABLE_REASON,
});

/**
 * Inode identity of the marker the last read parsed, per resolved root.
 *
 * The check sits in front of every content write - the same
 * append-heavy loops `vault-identity.ts` measures - so the steady-state
 * cost has to be one syscall rather than an open-read-parse. The marker
 * is written through `atomicWriteFileSync` (temp file plus rename), so a
 * replaced marker always arrives with a new inode; matching on
 * (inode, size, mtime) therefore proves the bytes are the ones already
 * parsed.
 */
interface MarkerStamp {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly marker: FreezeMarker;
}
const MARKER_STAMPS = new Map<string, MarkerStamp>();

/** Resolved marker path per root; the containment walk is paid once. */
const MARKER_PATHS = new Map<string, string>();

/**
 * How many times the marker's BYTES have been read and parsed, process
 * wide.
 *
 * Exported for the cache test, which is the only place the hot-path claim
 * in the docblock above is actually measured. A counter rather than a
 * spy: the alternative is monkey-patching `node:fs` in a test, which
 * pins the implementation instead of the property.
 */
let reloadCount = 0;

export function freezeMarkerReloadCount(): number {
  return reloadCount;
}

/**
 * Drop every cached marker. Exported for tests, which run many vaults in
 * one process; production code has no reason to call it.
 */
export function resetFreezeMarkerCache(): void {
  MARKER_STAMPS.clear();
  MARKER_PATHS.clear();
}

/** Parse the marker's bytes, or report the unreadable collapse. */
function parseMarker(path: string): FreezeMarker {
  reloadCount += 1;
  let parsed: Partial<FreezeMarker>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FreezeMarker>;
  } catch {
    return UNREADABLE_MARKER;
  }
  if (parsed === null || typeof parsed !== "object") return UNREADABLE_MARKER;
  // `frozen_at` is the one field a freeze cannot be reconstructed without:
  // a refusal that cannot say WHEN the vault was stopped is not a record,
  // it is a wall. Its absence therefore reads as unreadable rather than as
  // a freeze with an empty timestamp.
  if (typeof parsed.frozen_at !== "string" || parsed.frozen_at === "") return UNREADABLE_MARKER;
  return Object.freeze({
    schema: typeof parsed.schema === "number" ? parsed.schema : FREEZE_MARKER_SCHEMA_VERSION,
    frozen_at: parsed.frozen_at,
    by: typeof parsed.by === "string" ? parsed.by : "",
    device_id: typeof parsed.device_id === "string" ? parsed.device_id : "",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  });
}

/**
 * The freeze marker for `vault`, or `null` when the vault is not frozen.
 *
 * A present-but-unparseable marker returns {@link UNREADABLE_MARKER} -
 * that is, a freeze - never `null`.
 */
export function readFreezeMarker(vault: string): FreezeMarker | null {
  const root = resolve(vault);
  let path = MARKER_PATHS.get(root);
  if (path === undefined) {
    path = frozenMarkerPath(root);
    MARKER_PATHS.set(root, path);
  }
  // `throwIfNoEntry: false` for the same reason `currentVaultId` uses it:
  // an absent marker is the steady state, and the throwing form built and
  // discarded one Error, with its stack, per guarded write. The `catch`
  // stays because the option suppresses ENOENT only and every other stat
  // failure (EACCES, ELOOP) must not propagate out of a write guard.
  let stat;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    MARKER_STAMPS.delete(root);
    return null;
  }
  const cached = MARKER_STAMPS.get(root);
  if (
    cached !== undefined &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    return cached.marker;
  }
  const marker = parseMarker(path);
  MARKER_STAMPS.set(root, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    marker,
  });
  return marker;
}

/** Whether the marker file exists at all, uncached. For the writer only. */
export function freezeMarkerExists(vault: string): boolean {
  return existsSync(frozenMarkerPath(vault));
}

/** The `vault-frozen` notice for `marker`, worded once. */
export function vaultFrozenNotice(vault: string, marker: FreezeMarker): DegradationNotice {
  const why = marker.reason === "" ? "no reason given" : marker.reason;
  return degradationNotice({
    code: DEGRADATION_CODE.vaultFrozen,
    site: SITE,
    path: resolve(vault),
    detail:
      `refusing to write: this vault was frozen at ${marker.frozen_at} by ` +
      `${marker.by === "" ? "an unnamed agent" : marker.by} (${why}). ` +
      `Run \`${FREEZE_NEXT_COMMAND}\` to lift it`,
  });
}

/**
 * Assert that the content lane may write to `vault`.
 *
 * Throws {@link VaultFrozenError} while the marker is present, including
 * when it is present and unreadable. Returns silently otherwise; it never
 * writes, creates, or repairs anything.
 */
export function assertVaultNotFrozen(vault: string): void {
  const marker = readFreezeMarker(vault);
  if (marker === null) return;
  throw new VaultFrozenError(vaultFrozenNotice(vault, marker), marker);
}
