/**
 * The fleet freeze, write side: the two operator actions that set and
 * lift it (who-wrote-what, Task C).
 *
 * `freeze-marker.ts` is the leaf every guarded write reads. This module
 * is the pair of verbs behind `o2b brain freeze` / `o2b brain unfreeze`,
 * and it is deliberately separate: the reader must import nothing from
 * the log (which imports the paths module, which imports the guard), and
 * these two writers must import the log, because the events they emit
 * are the only durable record either action leaves.
 *
 * ## Why the marker's removal is not a data-loss event
 *
 * The marker carries no memory. Its whole content is its existence plus
 * the five fields that say who stopped the vault and why, and the
 * `unfreeze` event copies all five before the file goes. So the
 * `unlinkSync` here is declared in `destructive-sites.ts` with exactly
 * that story rather than routed through the snapshot gate: archiving a
 * file whose replacement costs one command would be ceremony, and the
 * fact worth keeping is kept in the log.
 *
 * ## Both verbs take the audit lane
 *
 * The vault-identity assertion still runs - a marker landing in the
 * wrong store is as wrong as a note landing there - but the freeze check
 * does not, because `unfreeze` must work on a vault that is frozen. That
 * is the whole point of it. `freeze` takes the same lane for symmetry
 * and because its own idempotence check, not the guard, is what makes a
 * second freeze a no-op.
 */

import { unlinkSync } from "node:fs";

import { resolveAgentName, resolveDeviceId } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  FREEZE_MARKER_SCHEMA_VERSION,
  WRITE_LANE,
  freezeMarkerExists,
  frozenMarkerPath,
  readFreezeMarker,
  type FreezeMarker,
} from "./freeze-marker.ts";
import { appendLogEvent, type BrainLogEntry } from "./log.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export interface FreezeVaultOptions {
  /** Agent recorded as having set the freeze. Defaults to the config identity. */
  readonly agent?: string;
  /** Operator's reason. Absent is recorded as the empty string, never guessed. */
  readonly reason?: string;
  /** Wall clock for `frozen_at`; injected so a test can pin the stamp. */
  readonly now?: Date;
}

export interface FreezeVaultResult {
  /**
   * `true` when this call wrote the marker. `false` when the vault was
   * already frozen - in which case {@link marker} is the EXISTING
   * freeze, not the one this call would have written.
   */
  readonly changed: boolean;
  readonly marker: FreezeMarker;
  readonly path: string;
}

export interface UnfreezeVaultOptions {
  /** Agent recorded as having lifted the freeze. Defaults to the config identity. */
  readonly agent?: string;
  /** Wall clock for the log event's timestamp. */
  readonly now?: Date;
}

export interface UnfreezeVaultResult {
  /** `true` when this call removed a marker; `false` when there was none. */
  readonly changed: boolean;
  /** What the marker said before it went, or `null` when there was none. */
  readonly marker: FreezeMarker | null;
}

/**
 * The device this machine appends under, or the empty string when it
 * cannot be resolved.
 *
 * The same absorption `appendLogEvent` performs for the same reason, and
 * the empty string is the documented shape rather than a value invented
 * to look healthy: a device id that cannot be read must not turn an
 * operator's stop into a failed command, and the field it fills is
 * descriptive - it names which machine set the freeze, and the freeze
 * itself is honoured on every machine regardless.
 */
function deviceIdOrEmpty(configPath?: string): string {
  try {
    return resolveDeviceId(configPath);
  } catch {
    return "";
  }
}

/**
 * Stop every content writer on every device that syncs this vault.
 *
 * Idempotent: a vault that is already frozen keeps the freeze it has and
 * this call reports `changed: false` without rewriting the marker. That
 * direction is the safe one - re-freezing would overwrite the record of
 * who stopped the vault first, and a second operator's reason is not
 * more true than the first's.
 */
export function freezeVault(vault: string, opts: FreezeVaultOptions = {}): FreezeVaultResult {
  assertVaultIdentityForWrite(vault, undefined, WRITE_LANE.audit);
  const path = frozenMarkerPath(vault);
  const existing = readFreezeMarker(vault);
  if (existing !== null) return { changed: false, marker: existing, path };

  const agent = opts.agent ?? resolveAgentName();
  const marker: FreezeMarker = Object.freeze({
    schema: FREEZE_MARKER_SCHEMA_VERSION,
    frozen_at: isoSecond(opts.now ?? new Date()),
    by: agent,
    device_id: deviceIdOrEmpty(),
    reason: opts.reason ?? "",
  });
  atomicWriteFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);

  const entry: BrainLogEntry = {
    timestamp: marker.frozen_at,
    eventType: BRAIN_LOG_EVENT_KIND.freeze,
    body: {
      reason: marker.reason,
      device_id: marker.device_id,
      agent,
    },
  };
  appendLogEvent(vault, entry);
  return { changed: true, marker, path };
}

/**
 * Lift the freeze.
 *
 * Removes the marker whatever state it is in - including a marker nobody
 * could parse, which freezes the vault exactly as a well-formed one does
 * and would otherwise be unliftable by any command. The event carries
 * what the marker said, so the record of the freeze outlives the file.
 */
export function unfreezeVault(vault: string, opts: UnfreezeVaultOptions = {}): UnfreezeVaultResult {
  assertVaultIdentityForWrite(vault, undefined, WRITE_LANE.audit);
  // `readFreezeMarker` collapses an unreadable marker onto a freeze, so
  // presence is asked of the filesystem rather than of the parse: the
  // two answers agree everywhere except on a file this call must still
  // be able to remove.
  if (!freezeMarkerExists(vault)) return { changed: false, marker: null };
  const marker = readFreezeMarker(vault);
  unlinkSync(frozenMarkerPath(vault));

  const agent = opts.agent ?? resolveAgentName();
  const entry: BrainLogEntry = {
    timestamp: isoSecond(opts.now ?? new Date()),
    eventType: BRAIN_LOG_EVENT_KIND.unfreeze,
    body: {
      frozen_at: marker?.frozen_at ?? "",
      by: marker?.by ?? "",
      reason: marker?.reason ?? "",
      agent,
    },
  };
  appendLogEvent(vault, entry);
  return { changed: true, marker };
}
