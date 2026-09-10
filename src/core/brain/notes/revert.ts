/**
 * Per-agent / per-session note revert (who-wrote-what, Task D /
 * t_924129c5).
 *
 * The note-write record answers "who wrote that, and what did it say
 * before". This module is the other half: taking it back. It is
 * plan-seal-apply over the `note-write` events, the same shape
 * `src/core/state/migrate.ts` uses for state relocation, because the
 * operator has to be able to READ what a revert is about to do before it
 * does it.
 *
 * ## Refuse on doubt
 *
 * A revert reaches into files other writers share, and there is no
 * three-way merge here by design (`docs/brainstorm/who-wrote-what/
 * design.md`, out of scope). So every target the selected writes touched
 * resolves to exactly one of three things and is REPORTED either way:
 *
 *   - `restore` - put back the before-image of the oldest selected write;
 *   - `delete` - the selected writes brought the note into existence and
 *     nothing wrote it before, so undoing them removes it;
 *   - `refuse` - with a named reason from {@link NOTE_REVERT_REFUSAL}.
 *
 * A refused target is never touched and never dropped from the plan: the
 * digest covers refusals too, so an operator who applies a digest applies
 * the plan they read, including the parts of it that will not run.
 *
 * ## The seal
 *
 * {@link planNoteRevert} returns a `digest` over the selector and the
 * entries - NOT over `planned_at`, so the same vault in the same state
 * plans to the same digest twice and an operator can re-read a plan
 * before applying it. {@link applyNoteRevert} re-plans from scratch and
 * refuses `digest_mismatch` before any byte moves when the vault changed
 * under the operator. That is the whole concurrency story: nothing is
 * locked between the two calls, and the digest is what notices.
 *
 * ## Why the apply is one gated block
 *
 * Every restored and deleted target runs inside one
 * {@link withDestructiveSnapshot} call, so a revert that half-succeeds
 * still has ONE recovery point covering the state before all of it. The
 * removal lives lexically inside the gate's argument list, which is also
 * what the destructive-site census reads.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import type { RecoverabilityVerdict } from "../gates/recoverability.ts";
import type { BrainLogParseWarning } from "../log.ts";
import { BRAIN_ROOT_REL, ensureInsideVault, writeImagePath } from "../paths.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_SNAPSHOT_REASON } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { listNoteWrites, type NoteWriteRecord } from "./write-log.ts";
import {
  NOTE_WRITE_NO_PRIOR,
  NOTE_WRITE_OP,
  recordNoteWrite,
  storeBeforeImage,
  type NoteWriteReceipt,
} from "./write-record.ts";

/** What a plan says will happen to one target. */
export const NOTE_REVERT_ACTION = Object.freeze({
  /** Put the before-image of the oldest selected write back. */
  restore: "restore",
  /** Remove the note the selected writes created. */
  delete: "delete",
  /** Touch nothing, and say why through {@link NOTE_REVERT_REFUSAL}. */
  refuse: "refuse",
} as const);

export type NoteRevertAction = (typeof NOTE_REVERT_ACTION)[keyof typeof NOTE_REVERT_ACTION];

/**
 * Why one target is refused. Closed, and every member is a fact about
 * the vault rather than a failure of this module.
 */
export const NOTE_REVERT_REFUSAL = Object.freeze({
  /**
   * The bytes on disk are not the ones the newest selected write left -
   * somebody wrote the target afterwards, or it is gone when it should
   * be there. Reverting would destroy that unrecorded work.
   */
  drift: "drift",
  /**
   * A write this selector did NOT select sits between the oldest and the
   * newest selected write on this target. Undoing the outer pair would
   * silently undo the middle one too. Same-second ties count as
   * interleaved: second-precision timestamps cannot order two writes
   * inside one second, and this is the doubt half of refuse-on-doubt.
   */
  interleaved: "interleaved",
  /**
   * The bytes a restore needs are not in the before-image store - pruned
   * by retention, or never written. The hash proves the write happened;
   * only the image can undo it.
   */
  imageMissing: "image-missing",
  /**
   * The current bytes of the target cannot be read at all, so no verdict
   * about drift is possible. "I could not tell" must never resolve to
   * "revert it".
   */
  unrecorded: "unrecorded",
  /**
   * The target already holds exactly what this revert would produce -
   * the selected writes put it back themselves, or a previous revert
   * already ran. Nothing to take back, and saying so is not the same
   * answer as a restore that rewrites identical bytes and logs a write.
   */
  alreadyReverted: "already-reverted",
} as const);

export type NoteRevertRefusal = (typeof NOTE_REVERT_REFUSAL)[keyof typeof NOTE_REVERT_REFUSAL];

/** Membership list, in declaration order. */
export const NOTE_REVERT_REFUSALS: ReadonlyArray<NoteRevertRefusal> = Object.freeze(
  Object.values(NOTE_REVERT_REFUSAL),
);

/**
 * Why a whole revert call is refused, as opposed to one target of it.
 * Each is thrown as a {@link NoteRevertError} carrying the code, so a CLI
 * or MCP surface reports the reason by name rather than by message text.
 */
export const NOTE_REVERT_ERROR = Object.freeze({
  /** No `agent`, `device` or `path`: a time window alone selects the vault. */
  unboundedSelector: "unbounded_selector",
  /** The sealed plan no longer describes the vault. */
  digestMismatch: "digest_mismatch",
  /** Every entry is a refusal; there is nothing an apply could do. */
  nothingToApply: "nothing_to_apply",
} as const);

export type NoteRevertErrorCode = (typeof NOTE_REVERT_ERROR)[keyof typeof NOTE_REVERT_ERROR];

/** A revert refused as a whole, with the code a caller narrows on. */
export class NoteRevertError extends Error {
  readonly code: NoteRevertErrorCode;
  /** The digest the caller supplied, on a `digest_mismatch` only. */
  readonly expected?: string;
  /** The digest the re-plan produced, on a `digest_mismatch` only. */
  readonly actual?: string;

  constructor(
    code: NoteRevertErrorCode,
    message: string,
    digests?: { readonly expected: string; readonly actual: string },
  ) {
    super(message);
    this.name = "NoteRevertError";
    this.code = code;
    if (digests !== undefined) {
      this.expected = digests.expected;
      this.actual = digests.actual;
    }
  }
}

/**
 * Which recorded writes a revert is about.
 *
 * At least one of `agent`, `device` or `path` is required: a selector
 * that only bounds TIME selects every write every agent on every machine
 * made in a window, which is a rollback of the vault wearing a revert's
 * clothes. `o2b brain rollback` is the verb for that, and it takes a
 * snapshot the operator chose.
 */
export interface NoteRevertSelector {
  /** Exact agent identity that recorded the write. */
  readonly agent?: string;
  /** Exact device id; the empty string is the legacy un-sharded log. */
  readonly device?: string;
  /** Exact vault-relative target path. */
  readonly path?: string;
  /** Inclusive lower bound: an ISO date or an ISO-8601 UTC timestamp. */
  readonly since?: string;
  /** Inclusive upper bound, same two spellings. */
  readonly until?: string;
}

/** What the plan says about one target. */
export interface NoteRevertEntry {
  /** Vault-relative POSIX path of the note. */
  readonly target: string;
  readonly action: NoteRevertAction;
  /** Present exactly when {@link action} is `refuse`. */
  readonly reason?: NoteRevertRefusal;
  /** The selected write ids on this target, oldest first. */
  readonly writes: ReadonlyArray<string>;
  /**
   * sha256 of the bytes on disk now, or {@link NOTE_WRITE_NO_PRIOR} when
   * there is no file, or {@link NOTE_REVERT_HASH_UNREADABLE} when the
   * bytes could not be read at all.
   */
  readonly hash_now: string;
  /**
   * sha256 the target would hold after the revert, or
   * {@link NOTE_WRITE_NO_PRIOR} when the revert removes it.
   */
  readonly hash_to: string;
}

/**
 * What `hash_now` says when the target exists in some form and its bytes
 * cannot be read.
 *
 * A third literal rather than reusing {@link NOTE_WRITE_NO_PRIOR},
 * because "there is no file here" and "there is something here I could
 * not read" are different facts, and reporting the second as the first
 * is exactly the misleading silence the refusal beside it exists to
 * prevent.
 */
export const NOTE_REVERT_HASH_UNREADABLE = "unreadable";

/** A sealed revert plan. */
export interface NoteRevertPlan {
  /** The selector as it was applied, with absent fields omitted. */
  readonly selector: NoteRevertSelector;
  /** One entry per target the selected writes touched, sorted by target. */
  readonly entries: ReadonlyArray<NoteRevertEntry>;
  /** `sha256Hex(canonicalJson({ selector, entries }))`. */
  readonly digest: string;
  /** ISO-8601 UTC second the plan was made. NOT covered by the digest. */
  readonly planned_at: string;
  /**
   * Every parse warning the log days behind this plan reported. A day
   * whose JSONL lost a line is a day whose write history is incomplete,
   * and an operator deciding what to revert has to be told that.
   */
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

/** How one applied target was recorded back into the write ledger. */
export interface NoteRevertRecorded {
  readonly target: string;
  /** The `note-write` id of the revert, or null when it was not recorded. */
  readonly write_id: string | null;
  /** Present exactly when {@link write_id} is null. */
  readonly audit_reason?: string;
}

/** What one apply did. */
export interface NoteRevertApplyResult {
  /** The recovery point the whole apply ran behind. */
  readonly snapshot: { readonly run_id: string; readonly path: string };
  /** Entries whose bytes moved, in plan order. */
  readonly applied: ReadonlyArray<NoteRevertEntry>;
  /**
   * Entries nothing touched: the plan's own refusals, plus any target
   * whose before-image failed verification at apply time.
   */
  readonly refused: ReadonlyArray<NoteRevertEntry>;
  /** One row per applied target, naming its `revert` write id. */
  readonly recorded: ReadonlyArray<NoteRevertRecorded>;
  /**
   * What the recovery point is worth for what this apply reached. A
   * note under `Brain/` and a note outside it are covered differently,
   * and reporting the archive path with no verdict beside it reads as
   * full coverage to every caller.
   */
  readonly recoverability: RecoverabilityVerdict;
}

/** Injected clock, shared by both entry points. */
export interface PlanNoteRevertOptions {
  readonly now?: Date;
}

/** How an apply attributes the `revert` writes it records. */
export interface ApplyNoteRevertOptions extends PlanNoteRevertOptions {
  /** Caller-asserted identity; defaults to the resolved agent name. */
  readonly agent?: string;
  /** Config file that names the writing agent, threaded to the record. */
  readonly configPath?: string;
}

/** The selector fields that bound a revert to something smaller than the vault. */
const BOUNDING_FIELDS = Object.freeze(["agent", "device", "path"] as const);

/** Prefix that puts a target inside the Brain tree. */
const BRAIN_TREE_PREFIX = `${BRAIN_ROOT_REL}/`;

/** The bytes at a target, or the named reason there are none to hash. */
type CurrentBytes =
  | { readonly kind: "bytes"; readonly bytes: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/**
 * Read the target as it is now.
 *
 * `ENOENT` is the one error that means "no file here"; every other
 * failure - a directory at the path, a permission wall, an I/O error -
 * is `unreadable`, because a plan that cannot see the bytes cannot judge
 * whether reverting them destroys somebody's work.
 */
function readCurrent(abs: string): CurrentBytes {
  try {
    return { kind: "bytes", bytes: readFileSync(abs, "utf8") };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
}

/** The digest of what is on disk now, in the entry's vocabulary. */
function hashOf(current: CurrentBytes): string {
  if (current.kind === "bytes") return sha256Hex(current.bytes);
  return current.kind === "absent" ? NOTE_WRITE_NO_PRIOR : NOTE_REVERT_HASH_UNREADABLE;
}

/** The selector with absent fields dropped, so the digest is stable. */
function normaliseSelector(selector: NoteRevertSelector): NoteRevertSelector {
  return {
    ...(selector.agent !== undefined ? { agent: selector.agent } : {}),
    ...(selector.device !== undefined ? { device: selector.device } : {}),
    ...(selector.path !== undefined ? { path: selector.path } : {}),
    ...(selector.since !== undefined ? { since: selector.since } : {}),
    ...(selector.until !== undefined ? { until: selector.until } : {}),
  };
}

/** Refuse a selector that names nobody and nothing. */
function assertBounded(selector: NoteRevertSelector): void {
  if (BOUNDING_FIELDS.some((field) => selector[field] !== undefined)) return;
  throw new NoteRevertError(
    NOTE_REVERT_ERROR.unboundedSelector,
    `a revert selector must name at least one of ${BOUNDING_FIELDS.join(", ")}; a time window ` +
      "alone selects every write by every agent on every device, which is a vault rollback - " +
      "use o2b brain rollback for that",
  );
}

/** One refusal entry, so the four call sites cannot spell it differently. */
function refuse(
  target: string,
  writes: ReadonlyArray<string>,
  reason: NoteRevertRefusal,
  hashNow: string,
  hashTo: string,
): NoteRevertEntry {
  return {
    target,
    action: NOTE_REVERT_ACTION.refuse,
    reason,
    writes,
    hash_now: hashNow,
    hash_to: hashTo,
  };
}

/**
 * Whether the store holds the image a restore needs.
 *
 * `writeImagePath` validates the digest shape, because it reaches this
 * module from a log payload an operator may have hand-edited; a digest
 * it rejects is an image this vault does not have, which is the same
 * answer as a missing file.
 */
function imageAvailable(vault: string, sha256: string): boolean {
  try {
    return existsSync(writeImagePath(vault, sha256));
  } catch {
    return false;
  }
}

/**
 * Resolve one target, applying the design's rules in the order they are
 * stated: what cannot be judged, then what would destroy unrecorded
 * work, then what would undo somebody else's write, then what is already
 * done, and only then the two actions.
 */
function planTarget(
  vault: string,
  target: string,
  selected: ReadonlyArray<NoteWriteRecord>,
  universe: ReadonlyArray<NoteWriteRecord>,
): NoteRevertEntry {
  const oldest = selected[0]!;
  const newest = selected[selected.length - 1]!;
  const writes = selected.map((w) => w.write_id);
  const current = readCurrent(ensureInsideVault(join(vault, target), vault));
  const hashNow = hashOf(current);

  if (current.kind === "unreadable") {
    return refuse(target, writes, NOTE_REVERT_REFUSAL.unrecorded, hashNow, oldest.hash_before);
  }
  if (hashNow !== newest.hash_after) {
    return refuse(target, writes, NOTE_REVERT_REFUSAL.drift, hashNow, oldest.hash_before);
  }

  const selectedIds = new Set(writes);
  const interleaved = universe.some(
    (w) =>
      !selectedIds.has(w.write_id) &&
      w.timestamp >= oldest.timestamp &&
      w.timestamp <= newest.timestamp,
  );
  if (interleaved) {
    return refuse(target, writes, NOTE_REVERT_REFUSAL.interleaved, hashNow, oldest.hash_before);
  }

  // `delete` applies only when the selected writes brought the note into
  // existence: the oldest one replaced nothing AND nothing on record
  // wrote this target before it. A note created outside the selection is
  // never deleted through this path (design.md, out of scope).
  const createdBySelection =
    oldest.hash_before === NOTE_WRITE_NO_PRIOR &&
    universe.findIndex((w) => w.write_id === oldest.write_id) === 0;
  const hashTo = createdBySelection ? NOTE_WRITE_NO_PRIOR : oldest.hash_before;

  if (hashNow === hashTo) {
    return refuse(target, writes, NOTE_REVERT_REFUSAL.alreadyReverted, hashNow, hashTo);
  }
  if (createdBySelection) {
    return {
      target,
      action: NOTE_REVERT_ACTION.delete,
      writes,
      hash_now: hashNow,
      hash_to: hashTo,
    };
  }
  // A restore to `absent` would be a delete the delete rule declined to
  // authorise - the oldest selected write replaced nothing, but an
  // earlier write of record exists, so this note had a life before the
  // selection. There is no image of nothing to restore, and the store is
  // where the plan says so.
  if (hashTo === NOTE_WRITE_NO_PRIOR || !imageAvailable(vault, hashTo)) {
    return refuse(target, writes, NOTE_REVERT_REFUSAL.imageMissing, hashNow, hashTo);
  }
  return { target, action: NOTE_REVERT_ACTION.restore, writes, hash_now: hashNow, hash_to: hashTo };
}

/**
 * Plan what reverting the selected writes would do, and seal it.
 *
 * Two reads of the ledger rather than one: the SELECTED writes narrow by
 * the whole selector, and the UNIVERSE of writes on the same targets
 * narrows by path alone, because the interleaving and creation rules ask
 * about writes the selector deliberately excluded.
 */
export function planNoteRevert(
  vault: string,
  selector: NoteRevertSelector,
  opts: PlanNoteRevertOptions = {},
): NoteRevertPlan {
  assertBounded(selector);
  const normalised = normaliseSelector(selector);
  // `listNoteWrites` returns newest-first; every rule here reads the
  // history forwards, so both lists are reversed once, here.
  const selectedRead = listNoteWrites(vault, normalised);
  const universeRead = listNoteWrites(
    vault,
    normalised.path !== undefined ? { path: normalised.path } : {},
  );
  const selected = selectedRead.writes.toReversed();
  const universe = universeRead.writes.toReversed();

  const byTarget = new Map<string, NoteWriteRecord[]>();
  for (const write of selected) {
    const bucket = byTarget.get(write.target);
    if (bucket === undefined) byTarget.set(write.target, [write]);
    else bucket.push(write);
  }

  const entries = [...byTarget.keys()]
    .toSorted((a, b) => a.localeCompare(b))
    .map((target) =>
      planTarget(
        vault,
        target,
        byTarget.get(target)!,
        universe.filter((w) => w.target === target),
      ),
    );

  return {
    selector: normalised,
    entries,
    digest: sha256Hex(canonicalJson({ selector: normalised, entries })),
    planned_at: isoSecond(opts.now ?? new Date()),
    warnings: universeRead.warnings,
  };
}

/** The regions this apply reaches, declared from the targets themselves. */
function blastRadiusOf(entries: ReadonlyArray<NoteRevertEntry>): {
  readonly brainTopLevel?: boolean;
  readonly outsideBrainRoot?: boolean;
} {
  const inBrain = entries.some((e) => e.target.startsWith(BRAIN_TREE_PREFIX));
  const outside = entries.some((e) => !e.target.startsWith(BRAIN_TREE_PREFIX));
  return {
    ...(inBrain ? { brainTopLevel: true } : {}),
    ...(outside ? { outsideBrainRoot: true } : {}),
  };
}

/** The recorded row for one applied target, discriminated on the receipt. */
function recordedRow(target: string, receipt: NoteWriteReceipt): NoteRevertRecorded {
  return receipt.write_id === null
    ? { target, write_id: null, audit_reason: receipt.audit_reason }
    : { target, write_id: receipt.write_id };
}

/**
 * Apply a plan the caller has already read, identified by its digest.
 *
 * Order is the contract. The vault-identity guard runs FIRST, so a
 * frozen vault refuses a revert by name before anything is read; then
 * the plan is rebuilt from scratch and compared to the digest, so a
 * vault that moved under the operator is refused before any byte; and
 * only then does the destructive gate take the one recovery point the
 * whole apply runs behind.
 */
export function applyNoteRevert(
  vault: string,
  selector: NoteRevertSelector,
  digest: string,
  opts: ApplyNoteRevertOptions = {},
): NoteRevertApplyResult {
  assertVaultIdentityForWrite(vault);
  const plan = planNoteRevert(vault, selector, opts);
  if (plan.digest !== digest) {
    throw new NoteRevertError(
      NOTE_REVERT_ERROR.digestMismatch,
      `this plan no longer describes the vault: the sealed digest was ${digest} and re-planning ` +
        `the same selector now yields ${plan.digest}. Nothing has been touched - plan again and ` +
        "read what changed",
      { expected: digest, actual: plan.digest },
    );
  }

  const actionable = plan.entries.filter((e) => e.action !== NOTE_REVERT_ACTION.refuse);
  if (actionable.length === 0) {
    throw new NoteRevertError(
      NOTE_REVERT_ERROR.nothingToApply,
      `every one of the ${plan.entries.length} target(s) in this plan is refused, so there is ` +
        "nothing to apply; the plan names the reason for each",
    );
  }

  const timestamp = isoSecond(opts.now ?? new Date());
  const applied: NoteRevertEntry[] = [];
  const refused: NoteRevertEntry[] = plan.entries.filter(
    (e) => e.action === NOTE_REVERT_ACTION.refuse,
  );
  const recorded: NoteRevertRecorded[] = [];
  const record = (entry: NoteRevertEntry, before: string | null, after: string | null): void => {
    applied.push(entry);
    recorded.push(
      recordedRow(
        entry.target,
        recordNoteWrite(vault, {
          op: NOTE_WRITE_OP.revert,
          target: entry.target,
          before: before === null ? null : { bytes: before },
          after: after === null ? null : { bytes: after },
          timestamp,
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
        }),
      ),
    );
  };

  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.noteRevert,
    () => {
      for (const entry of actionable) {
        const abs = ensureInsideVault(join(vault, entry.target), vault);
        const current = readCurrent(abs);
        if (entry.action === NOTE_REVERT_ACTION.delete) {
          // The plan proved the bytes are the ones the newest selected
          // write left, so `current` is those bytes; keeping an image of
          // them is what makes this delete itself revertible.
          if (current.kind !== "bytes") {
            refused.push({
              ...entry,
              action: NOTE_REVERT_ACTION.refuse,
              reason: NOTE_REVERT_REFUSAL.unrecorded,
            });
            continue;
          }
          storeBeforeImage(vault, current.bytes);
          unlinkSync(abs);
          record(entry, current.bytes, null);
          continue;
        }
        // A restore verifies the image against the digest the plan
        // sealed BEFORE it writes: restoring bytes that are not the ones
        // recorded is the one failure a revert must never have, and a
        // corrupt or vanished image is the same answer the plan gives.
        const bytes = readImage(vault, entry.hash_to);
        if (bytes === null) {
          refused.push({
            ...entry,
            action: NOTE_REVERT_ACTION.refuse,
            reason: NOTE_REVERT_REFUSAL.imageMissing,
          });
          continue;
        }
        if (current.kind === "bytes") storeBeforeImage(vault, current.bytes);
        mkdirSync(dirname(abs), { recursive: true });
        atomicWriteFileSync(abs, bytes);
        record(entry, current.kind === "bytes" ? current.bytes : null, bytes);
      }
    },
    {
      blastRadius: blastRadiusOf(actionable),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
  );

  return {
    snapshot: { run_id: gated.snapshot.runId, path: gated.snapshot.path },
    applied,
    refused,
    recorded,
    recoverability: gated.recoverability,
  };
}

/** The image's bytes, or null when it is missing or no longer hashes to its name. */
function readImage(vault: string, sha256: string): string | null {
  try {
    const bytes = readFileSync(writeImagePath(vault, sha256), "utf8");
    return sha256Hex(bytes) === sha256 ? bytes : null;
  } catch {
    return null;
  }
}
