/**
 * The note-write record (who-wrote-what, Task A / t_662f4e82).
 *
 * Signals and preferences have carried an `agent:` since they shipped,
 * and note writes - the bulk of what a connected agent actually produces
 * - carried nothing at all. A note rewritten by one of four agents on one
 * of three machines left an mtime and no answer to "who did that, and
 * what did it say before". This module is that answer, and it is
 * deliberately two artifacts rather than one:
 *
 *   - ONE `note-write` log event per write, carrying the write id, the
 *     operation, the target, the content hash and byte size on both
 *     sides, and the caller-asserted agent. The appender stamps the
 *     origin channel and shards per device, so the device rides on the
 *     shard name exactly as it does for every other event.
 *   - the bytes the write REPLACED, kept content-addressed under
 *     `Brain/.state/write-images/<sha256>`. A hash proves a write
 *     happened; only the bytes let it be undone.
 *
 * ## Order, and why the receipt can say `null`
 *
 * The caller stores the image, writes the file, and records last. The
 * file is the load-bearing artifact and the event is the audit trail, so
 * a log failure must never abort a write that has already landed - that
 * is the precedent the snapshot event set. What this module does NOT
 * inherit is the silence: {@link recordNoteWrite} never throws, and when
 * the append fails it returns `write_id: null` with an `audit_reason`
 * naming the failure, which every note-write result and MCP receipt
 * carries through to the caller. A write nobody can attribute is a fact
 * the caller is told, not one it has to infer.
 *
 * ## Why content-addressed
 *
 * An agent that toggles a note between two states costs two images, not
 * two per write, and two writers that replace identical content share
 * one file. The store is inside `Brain/`, so the snapshot region already
 * archives it; {@link pruneWriteImages} bounds its growth by mtime.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { resolveAgentName } from "../../config.ts";
import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import { appendLogEvent } from "../log.ts";
import { ensureInsideVault, vaultRelative, writeImagePath, writeImagesDir } from "../paths.ts";
import { fileAgeMs, isoSecond, msToWholeDays } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";

/**
 * What a recorded write did to its target. Closed vocabulary: the three
 * mutations the note seams perform, plus `revert`, which the per-agent
 * revert (t_924129c5) writes when it restores a before-image. `revert` is
 * declared HERE rather than added later on purpose - a restore is a write
 * like any other and must be attributable and itself revertible, so the
 * vocabulary that admits it is the vocabulary the reader already knows.
 */
export const NOTE_WRITE_OP = Object.freeze({
  create: "create",
  update: "update",
  append: "append",
  revert: "revert",
} as const);

export type NoteWriteOp = (typeof NOTE_WRITE_OP)[keyof typeof NOTE_WRITE_OP];

const NOTE_WRITE_OPS: ReadonlyArray<NoteWriteOp> = Object.freeze(Object.values(NOTE_WRITE_OP));

/** True when `value` is a member of {@link NOTE_WRITE_OP}. */
export function isNoteWriteOp(value: unknown): value is NoteWriteOp {
  return typeof value === "string" && (NOTE_WRITE_OPS as ReadonlyArray<string>).includes(value);
}

/**
 * What `hash_before` says when the target did not exist.
 *
 * A literal rather than an empty string or a missing key: the payload
 * contract admits only strings, an absent key would be indistinguishable
 * from a legacy line, and the sha256 of zero bytes is a real digest that
 * an empty FILE would also produce. "There was nothing here" and "there
 * was an empty file here" are different facts and a revert reads them
 * differently.
 */
export const NOTE_WRITE_NO_PRIOR = "absent";

/**
 * Default age, in whole days, past which {@link pruneWriteImages} removes
 * a before-image. Thirty days is the window in which an operator notices
 * an agent wrote something it should not have; past it the snapshot
 * region is the recovery story and the image only narrows revert reach.
 */
export const WRITE_IMAGE_RETENTION_DAYS = 30;

/** Prefix of every write id, mirroring the continuity record id shape. */
const NOTE_WRITE_ID_PREFIX = "nw_";
/** Digits of the event timestamp carried in the id, most significant first. */
const NOTE_WRITE_ID_STAMP_LENGTH = 14;
/** Hex characters of the body digest carried in the id. */
const NOTE_WRITE_ID_HASH_LENGTH = 16;

/** The facts a write id is derived from. */
export interface NoteWriteIdInput {
  /** ISO-8601 UTC second the event carries. */
  readonly timestamp: string;
  readonly op: NoteWriteOp;
  /** Vault-relative POSIX path of the note. */
  readonly target: string;
  /** sha256 of the replaced bytes, or {@link NOTE_WRITE_NO_PRIOR}. */
  readonly hash_before: string;
  /** sha256 of the bytes now on disk. */
  readonly hash_after: string;
  readonly agent: string;
}

/**
 * The id of one recorded write: `nw_<14 timestamp digits>_<16 hex>`.
 *
 * Sortable by its stamp and unique by its digest, the shape
 * `continuity/store.ts` already uses for the same reason. Derived from
 * the event body rather than from a counter or a random value, so two
 * devices that record the same write of the same bytes at the same
 * second agree on its id and a merged log deduplicates rather than
 * double-counts.
 */
export function noteWriteId(body: NoteWriteIdInput): string {
  const stamp = body.timestamp.replace(/\D/g, "").slice(0, NOTE_WRITE_ID_STAMP_LENGTH);
  const hash = sha256Hex(canonicalJson(body)).slice(0, NOTE_WRITE_ID_HASH_LENGTH);
  return `${NOTE_WRITE_ID_PREFIX}${stamp}_${hash}`;
}

/** Where one before-image ended up, and whether this call put it there. */
export interface StoredBeforeImage {
  /** sha256 of the stored bytes; the file's own name. */
  readonly sha256: string;
  /** Absolute path of the image file. */
  readonly path: string;
  /** False when an image of the same content already existed. */
  readonly stored: boolean;
}

/**
 * Keep the bytes a write is about to replace, keyed by their digest.
 *
 * Content-addressed and therefore idempotent: a second call with the same
 * bytes writes nothing and reports `stored: false`, which is what keeps a
 * note edited a hundred times between two states at two images.
 */
export function storeBeforeImage(vault: string, bytes: string): StoredBeforeImage {
  const sha256 = sha256Hex(bytes);
  const path = writeImagePath(vault, sha256);
  if (existsSync(path)) return { sha256, path, stored: false };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, bytes);
  return { sha256, path, stored: true };
}

/** One side of a write, as the bytes that were or are on disk. */
export interface NoteWriteBytes {
  readonly bytes: string;
}

/** What {@link recordNoteWrite} needs to describe one write. */
export interface RecordNoteWriteInput {
  readonly op: NoteWriteOp;
  /** Vault-relative POSIX path, or an absolute path inside the vault. */
  readonly target: string;
  /** The replaced bytes, or null when the target did not exist. */
  readonly before: NoteWriteBytes | null;
  /** The bytes now on disk. */
  readonly after: NoteWriteBytes;
  /** ISO-8601 UTC second; defaults to now. */
  readonly timestamp?: string;
  /** Caller-asserted identity; defaults to {@link resolveAgentName}. */
  readonly agent?: string;
}

/**
 * The audit half of a note-write result.
 *
 * Discriminated on `write_id` so a caller cannot read an unrecorded write
 * as a recorded one: either there is an id, or there is a reason there is
 * not. Both halves ride on every note-write result and MCP receipt.
 */
export type NoteWriteReceipt =
  | { readonly write_id: string; readonly audit_reason?: undefined }
  | { readonly write_id: null; readonly audit_reason: string };

/**
 * Append the one `note-write` event for a write whose bytes have ALREADY
 * landed, and never throw.
 *
 * The ordering is the contract: this runs after the atomic write, so a
 * failure here costs the audit line and not the note. Every failure mode
 * - an unresolvable agent identity, a locked log directory, a full disk -
 * returns `write_id: null` with the reason, because the alternative shapes
 * are both worse: throwing would undo nothing and report a failure for a
 * write that succeeded, and swallowing would leave the caller believing an
 * event exists.
 */
export function recordNoteWrite(vault: string, input: RecordNoteWriteInput): NoteWriteReceipt {
  try {
    const timestamp = input.timestamp ?? isoSecond();
    const agent = input.agent ?? resolveAgentName();
    // The seams hand this a vault-relative POSIX path they already
    // judged; an absolute one is admitted too, and both go back through
    // containment rather than being trusted, so a target outside the
    // vault becomes a named audit reason instead of a log line pointing
    // out of the tree.
    const abs = ensureInsideVault(
      isAbsolute(input.target) ? input.target : join(vault, input.target),
      vault,
    );
    const target = vaultRelative(abs, vault);
    const hashBefore = input.before === null ? NOTE_WRITE_NO_PRIOR : sha256Hex(input.before.bytes);
    const bytesBefore = input.before === null ? 0 : Buffer.byteLength(input.before.bytes, "utf8");
    const idInput: NoteWriteIdInput = {
      timestamp,
      op: input.op,
      target,
      hash_before: hashBefore,
      hash_after: sha256Hex(input.after.bytes),
      agent,
    };
    // Every value is a string: `BrainLogEntryPayload` admits `string |
    // string[]` and nothing else, so the byte counts are rendered rather
    // than carried as numbers a reader would have to coerce back.
    const writeId = noteWriteId(idInput);
    appendLogEvent(vault, {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent,
      body: {
        write_id: writeId,
        op: idInput.op,
        target: idInput.target,
        hash_before: idInput.hash_before,
        hash_after: idInput.hash_after,
        bytes_before: String(bytesBefore),
        bytes_after: String(Buffer.byteLength(input.after.bytes, "utf8")),
        agent,
      },
    });
    return { write_id: writeId };
  } catch (err) {
    return {
      write_id: null,
      audit_reason: `note-write event not recorded: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** How {@link pruneWriteImages} was asked to run. */
export interface PruneWriteImagesOptions {
  /** Whole days of age past which an image is removed. Default 30. */
  readonly olderThanDays?: number;
  /** Report what would go and remove nothing. */
  readonly dryRun?: boolean;
  /** Instant the ages are measured against; defaults to now. */
  readonly now?: Date;
}

/** What one prune pass found and did. */
export interface PruneWriteImagesResult {
  /** sha256 names removed (or, under `dryRun`, that would be), sorted. */
  readonly removed: ReadonlyArray<string>;
  /** Images left in the store. */
  readonly kept: number;
  /** True when nothing was actually unlinked. */
  readonly dry_run: boolean;
}

/**
 * Remove before-images older than a retention window.
 *
 * The store is not self-limiting - every distinct prior content of every
 * note stays until something removes it - so this is the bound. An image
 * is a copy of note content the snapshot region already archives, and its
 * absence only narrows how far back a revert can reach, which the revert
 * plan reports by name rather than discovering silently.
 */
export function pruneWriteImages(
  vault: string,
  opts: PruneWriteImagesOptions = {},
): PruneWriteImagesResult {
  const olderThanDays = opts.olderThanDays ?? WRITE_IMAGE_RETENTION_DAYS;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `pruneWriteImages: olderThanDays must be a non-negative integer, got ${String(olderThanDays)}`,
    );
  }
  const dryRun = opts.dryRun === true;
  const dir = writeImagesDir(vault);
  if (!existsSync(dir)) return { removed: [], kept: 0, dry_run: dryRun };
  const nowMs = (opts.now ?? new Date()).getTime();
  const removed: string[] = [];
  let kept = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    const path = writeImagePath(vault, entry.name);
    // An unmeasurable age is not an old age: a file whose mtime this
    // process cannot read is kept, because "I could not tell" must never
    // resolve to "remove it".
    const ageMs = fileAgeMs(path, nowMs);
    if (ageMs === null || msToWholeDays(ageMs) < olderThanDays) {
      kept += 1;
      continue;
    }
    if (!dryRun) unlinkSync(path);
    removed.push(entry.name);
  }
  return { removed, kept, dry_run: dryRun };
}
