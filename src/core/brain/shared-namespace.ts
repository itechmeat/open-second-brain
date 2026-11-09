/**
 * Cross-agent shared memory namespace (Agent Write Contract Suite,
 * t_936a1a61).
 *
 * Opt-in: the `shared_namespace` device-config key names a second
 * vault root. When set, explicit remember-writes (feedback signals and
 * narrative notes) MIRROR there after the primary write succeeds, so
 * facts learned by one agent become visible to every agent sharing the
 * namespace. Attribution is carried twice: the existing `agent` field
 * plus `origin_vault` (basename of the primary vault), which
 * `parseSignal` reads back and the agent-source provider surfaces.
 *
 * Mirror semantics are FAIL-SOFT by contract: a mirror failure must never
 * break, delay, or alter the primary write. Fail-soft is not the same as
 * mute, and it used to be (a-label-is-not-a-boundary, U5): both writes sat
 * behind a bare `catch { return "failed" }`, so a permissions problem, a
 * missing shared vault, a full disk and a schema violation reached the
 * operator as one indistinguishable bit - on the one path they cannot
 * observe by any other means. Every outcome that is not `ok` now carries
 * the reason that produced it.
 *
 * Unlike the cross-vault union, the reason here carries the underlying
 * message: the shared vault is the operator's OWN configured path on their
 * OWN machine, not a foreign index whose location is a disclosure.
 *
 * One-way by design: the shared vault's own dream pass treats mirrored
 * records as ordinary first-class signals. Reading it back is a separate
 * mechanism - it is enumerated as a search origin by
 * `portability/origins.ts`.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { storeOnlyMode } from "../store/store-only.ts";
import { resolveSharedNamespace } from "../config.ts";
import { appendLogEvent } from "./log.ts";
import { writeSignal, type WriteSignalInput, type WriteSignalOptions } from "./signal.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

export { resolveSharedNamespace };

/**
 * How one mirror write ended.
 *
 * `off` is not a member: the key being absent is expressed by the caller
 * never asking, and every caller reports the absence by omitting the field
 * entirely. A member no producer can return is a promise the surface does
 * not keep, so the token was retracted rather than kept "for later".
 *
 * `misconfigured` is split from `failed` because the two are the same word
 * for opposite situations: a shared namespace pointing at the origin vault
 * is decided before any I/O and is repaired by editing one config key,
 * while `failed` is a write that was attempted and raised. Reporting a
 * self-mirror identically to an unmounted disk sent the operator after the
 * wrong fault.
 */
export const MIRROR_OUTCOME = Object.freeze({
  /** The record landed in the shared vault. */
  ok: "ok",
  /** The write was attempted and raised; `reason` carries the message. */
  failed: "failed",
  /** Refused before any I/O; `reason` names the operator's misconfiguration. */
  misconfigured: "misconfigured",
} as const);

/** Closed union over {@link MIRROR_OUTCOME}. */
export type MirrorOutcome = (typeof MIRROR_OUTCOME)[keyof typeof MIRROR_OUTCOME];

/** Membership list, best outcome first. */
export const MIRROR_OUTCOMES: ReadonlyArray<MirrorOutcome> = Object.freeze([
  MIRROR_OUTCOME.ok,
  MIRROR_OUTCOME.failed,
  MIRROR_OUTCOME.misconfigured,
]);

/** Narrow a value read back off a payload or across a tool boundary. */
export function isMirrorOutcome(value: unknown): value is MirrorOutcome {
  return typeof value === "string" && (MIRROR_OUTCOMES as ReadonlyArray<string>).includes(value);
}

/** One mirror write's outcome and, unless it succeeded, why. */
export interface MirrorReport {
  readonly outcome: MirrorOutcome;
  /** Absent exactly when the outcome is `ok`. */
  readonly reason?: string;
}

/** The one sentence the self-mirror guard reports, so no caller reinvents it. */
const SELF_MIRROR_REASON =
  "shared_namespace resolves to the origin vault, which would double-write every record";

const OK: MirrorReport = Object.freeze({ outcome: MIRROR_OUTCOME.ok });

const SELF_MIRROR: MirrorReport = Object.freeze({
  outcome: MIRROR_OUTCOME.misconfigured,
  reason: SELF_MIRROR_REASON,
});

/**
 * The refusal when the shared vault is store-only on this machine (this
 * machine switched, or the shared vault has no legacy tree): a store write
 * goes to this machine's own store, never to the shared namespace, so the
 * mirror would only duplicate the origin record in the same store.
 */
const STORE_ONLY_MIRROR: MirrorReport = Object.freeze({
  outcome: MIRROR_OUTCOME.misconfigured,
  reason:
    "the shared namespace is store-only on this machine, so a mirror would write this " +
    "machine's own brain store again and never reach the shared vault; nothing was mirrored",
});

/** Why a mirror cannot run before any I/O, or `null` when it can. */
function mirrorRefusal(sharedVault: string, originVault: string): MirrorReport | null {
  if (isSelfMirror(sharedVault, originVault)) return SELF_MIRROR;
  const mode = storeOnlyMode({ vault: sharedVault });
  // A shared path that is no directory at all is a broken mount: the
  // attempted write reports it as `failed`, as before.
  if (mode.reason === "device-switched") return STORE_ONLY_MIRROR;
  if (mode.reason === "no-legacy-tree" && isDirectory(sharedVault)) return STORE_ONLY_MIRROR;
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Keep a thrown non-Error readable instead of casting it to one unchecked. */
function failureReason(exc: unknown): MirrorReport {
  return Object.freeze({
    outcome: MIRROR_OUTCOME.failed,
    reason: exc instanceof Error ? exc.message : String(exc),
  });
}

/**
 * Mirror a feedback signal into the shared vault. The record is the
 * same signal with `origin_vault` attribution; slug collisions resolve
 * through the normal allocator.
 */
export function mirrorSignal(
  sharedVault: string,
  originVault: string,
  input: WriteSignalInput,
  options: WriteSignalOptions = {},
): MirrorReport {
  const refused = mirrorRefusal(sharedVault, originVault);
  if (refused !== null) return refused;
  try {
    writeSignal(sharedVault, { ...input, origin_vault: basename(originVault) }, options);
    return OK;
  } catch (exc) {
    return failureReason(exc);
  }
}

export interface MirrorNoteInput {
  readonly text: string;
  readonly agent: string;
  readonly now?: Date;
}

/** Mirror a narrative note event into the shared vault's log. */
export function mirrorNote(
  sharedVault: string,
  originVault: string,
  input: MirrorNoteInput,
): MirrorReport {
  const refused = mirrorRefusal(sharedVault, originVault);
  if (refused !== null) return refused;
  try {
    appendLogEvent(
      sharedVault,
      {
        timestamp: isoSecond(input.now ?? new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.note,
        body: {
          text: input.text,
          agent: input.agent,
          origin_vault: basename(originVault),
        },
      },
      // Not fail-open: the mirror reports its own failure to the caller.
    );
    return OK;
  } catch (exc) {
    return failureReason(exc);
  }
}

/** The fields a result surface adds for a mirror it performed. */
export interface MirrorReportFields {
  readonly mirror?: MirrorOutcome;
  readonly mirror_reason?: string;
}

/**
 * Flatten a report onto a result payload, or contribute nothing when no
 * mirror was configured. One composer for the three surfaces that report a
 * mirror - the MCP feedback tool, the note writer and the CLI - so a
 * diagnosis cannot reach a caller on one surface and be dropped on another.
 */
export function mirrorReportFields(report: MirrorReport | undefined): MirrorReportFields {
  if (report === undefined) return {};
  return {
    mirror: report.outcome,
    ...(report.reason !== undefined ? { mirror_reason: report.reason } : {}),
  };
}

/**
 * A shared namespace pointing back at the origin vault would
 * double-write every record into its own store. That is always an
 * operator misconfiguration, and it is reported as one.
 */
function isSelfMirror(sharedVault: string, originVault: string): boolean {
  return canonicalPath(sharedVault) === canonicalPath(originVault);
}

/** Realpath when resolvable (catches symlink aliases), lexical otherwise. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
