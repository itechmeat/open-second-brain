/**
 * The multi-lane pending queue (write-side trust, Task 9).
 *
 * One store, three review lanes. The A3 signals queue keeps its flat
 * `Brain/pending/sig-*.md` directory byte-compatibly; note creates stage
 * into `Brain/pending/notes/` and the ingest summary page into
 * `Brain/pending/ingest/`. Every lane shares the same rules:
 *
 *   - The staged document is BYTE-FOR-BYTE what the publish target would
 *     have received - staging is purely a change of directory, so apply
 *     moves the bytes verbatim (exclusive create, then unlink - the A3
 *     order, with {@link PendingApplyConflictError} on an occupied
 *     target and the exclusive create as the real race gate).
 *   - The pending id is self-describing. `sig-` ids keep the A3 grammar;
 *     a `note-` id carries the REVERSIBLE percent-encoding of the publish
 *     target without its final `.md`; an `ing-` id carries the
 *     deterministic publish basename (the ingest publish path is a pure
 *     function of the source identity, so the basename suffices).
 *   - {@link listPendingLane} sorts deterministically and PARTITIONS
 *     unreadable entries: a corrupt or mis-named file is named with a
 *     reason instead of breaking the listing or vanishing.
 *   - Reject renders into `Brain/retired/` with the retire-shaped
 *     frontmatter, stamping `osb_pending_lane` at reject time only -
 *     reject transforms, publish never does.
 *
 * Dispositions resolve at {@link resolveWriteDisposition}: with no
 * permissions document the `write_approval.*` lane keys decide (on =
 * stage, off = publish); the document-backed arm arrives with Task 12.
 *
 * This module is the queue's engine; `../pending.ts` remains the
 * historical import surface and delegates here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicCreateFileSyncExclusive, atomicWriteFileSync } from "../../fs-atomic.ts";
import { discoverConfig } from "../../config.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import type { BrainDirs } from "../paths.ts";
import { BRAIN_INBOX_REL, BRAIN_SOURCES_REL, brainDirs, brainDirsForWrite } from "../paths.ts";
import { parseSignal } from "../signal.ts";
import type { BrainSignal } from "../types.ts";
import {
  WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  WRITE_APPROVAL_ENABLED_ENV_KEY,
  WRITE_APPROVAL_INGEST_CONFIG_KEY,
  WRITE_APPROVAL_INGEST_ENV_KEY,
  WRITE_APPROVAL_NOTES_CONFIG_KEY,
  WRITE_APPROVAL_NOTES_ENV_KEY,
  REVIEW_LANE,
  type ReviewLane,
  resolveWriteApprovalLane,
} from "../write-gate.ts";

// ----- Typed errors ---------------------------------------------------------

/**
 * The advisory-registry code a STAGED receipt names (see
 * `../diagnostics.ts`); it resolves to the queue command that publishes
 * the staged write. One spelling here so the CLI and MCP renderers
 * cannot drift.
 */
export const PENDING_STAGED_DIAGNOSTIC_CODE = "pending-staged";

/** Typed error for a missing / already-processed pending id (never a no-op). */
export class PendingSignalNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`pending signal not found: ${JSON.stringify(id)}`);
    this.name = "PendingSignalNotFoundError";
    this.id = id;
  }
}

/** Typed error for an id whose shape could not be a pending entry name. */
export class InvalidPendingIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `invalid pending id ${JSON.stringify(id)} - expected ` +
        `${PENDING_LANE_ID_SOURCE}:${PENDING_LANE_ID_SOURCE.slice(0, -1)}-<date>-<name>`,
    );
    this.name = "InvalidPendingIdError";
    this.id = id;
  }
}

/**
 * The publish target this id would move into is already occupied.
 *
 * The exclusive create in {@link applyPendingLane} has always refused
 * this as a raw filesystem error on the signals lane; it is a named
 * error because the dry run has to refuse it too - a preview that
 * reported a move the apply would then reject would be a preview that
 * lied. The exclusive create stays as the actual race gate.
 */
export class PendingApplyConflictError extends Error {
  readonly id: string;
  readonly path: string;
  constructor(id: string, path: string) {
    super(`publish target already occupied for ${JSON.stringify(id)}: ${path}`);
    this.name = "PendingApplyConflictError";
    this.id = id;
    this.path = path;
  }
}

/**
 * A publish target (or its encoding) cannot be staged or applied: the
 * encoded name would exceed the filesystem's 255-character filename
 * bound, the encoding is malformed, or the decoded path escapes the
 * vault. Named rather than truncated - a target that cannot stage
 * refuses the write by name rather than colliding with a sibling.
 */
export class PendingTargetPathError extends Error {
  readonly target: string;
  constructor(message: string, target: string) {
    super(message);
    this.name = "PendingTargetPathError";
    this.target = target;
  }
}

// ----- Pending ids ----------------------------------------------------------

/**
 * One grammar for every lane's pending id. The `sig-` shape is
 * byte-compatible with the A3 queue (its previous grammar allowed
 * exactly `[A-Za-z0-9._-]`, all of which remain legal here); the
 * `note-` suffix adds `%` because it carries the percent-encoded publish
 * target, and the `ing-` suffix carries the publish basename.
 */
export const PENDING_LANE_ID_RE = /^(sig|note|ing)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._%-]*$/;

/** Human-readable restatement of the grammar, for refusals. */
const PENDING_LANE_ID_SOURCE = "sig-|note-|ing-<YYYY-MM-DD>-<name>";

/** The lane a pending id belongs to, from its prefix. */
function laneOfId(id: string): ReviewLane {
  if (id.startsWith("sig-")) return REVIEW_LANE.signals;
  if (id.startsWith("note-")) return REVIEW_LANE.notes;
  return REVIEW_LANE.ingest;
}

// ----- Target path encoding -------------------------------------------------

/**
 * Longest publish-target suffix one pending filename can carry. The
 * classic filesystem bound is 255 bytes per filename component; the
 * longest composed name is `note-<YYYY-MM-DD>-<encoded>.md`
 * (15 + 3 + suffix), so the suffix itself is bounded at 231 bytes.
 */
const MAX_ENCODED_SUFFIX_BYTES = 231;

/** The filename bound every composed pending name must fit, in bytes. */
export const PENDING_FILENAME_MAX_BYTES = 255;

/**
 * Encode a vault-relative publish target into the reversible,
 * Windows-legal suffix of a `note-` pending id.
 *
 * Unreserved characters (`A-Za-z0-9._-`) pass through; EVERY other byte
 * of the UTF-8 encoding - separators, spaces, CJK, the escape character
 * itself - becomes an uppercase `%XX` triplet. The output therefore
 * matches the pending-id grammar exactly, carries no character Windows
 * forbids in a filename, and decodes to exactly the input. An encoded
 * result past {@link MAX_ENCODED_SUFFIX_BYTES} refuses by name: a
 * target that cannot stage refuses the write rather than truncating
 * into a collision.
 */
export function encodePendingTargetPath(relPath: string): string {
  const bytes = new TextEncoder().encode(relPath);
  let out = "";
  for (const byte of bytes) {
    const chr = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(chr)) {
      out += chr;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  if (Buffer.byteLength(out, "utf8") > MAX_ENCODED_SUFFIX_BYTES) {
    throw new PendingTargetPathError(
      `publish target ${JSON.stringify(relPath)} encodes to ${Buffer.byteLength(out, "utf8")} ` +
        `bytes, past the ${MAX_ENCODED_SUFFIX_BYTES}-byte suffix bound (the 255-byte ` +
        "filesystem filename bound minus the id prefix); shorten the target path - " +
        "it is refused, not truncated",
      relPath,
    );
  }
  return out;
}

/**
 * The strict inverse of {@link encodePendingTargetPath}: decode a
 * percent-encoded suffix back into the publish target. A malformed
 * escape is a named error, never a silent passthrough - a hand-edited
 * queue must not apply into a path nobody meant.
 */
export function decodePendingTargetPath(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const chr = encoded[i]!;
    if (chr !== "%") {
      bytes.push(encoded.charCodeAt(i));
      continue;
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new PendingTargetPathError(
        `pending target encoding ${JSON.stringify(encoded)} has a malformed percent escape at ` +
          `offset ${i}; the queue entry is corrupt and must be rejected or removed by hand`,
        encoded,
      );
    }
    bytes.push(parseInt(hex, 16));
    i += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new PendingTargetPathError(
      `pending target encoding ${JSON.stringify(encoded)} is not valid UTF-8; ` +
        "the queue entry is corrupt and must be rejected or removed by hand",
      encoded,
    );
  }
}

// ----- Lane registry --------------------------------------------------------

/** Absolute directory a lane stages into, under resolved Brain dirs. */
function pendingLaneDirIn(dirs: BrainDirs, lane: ReviewLane): string {
  if (lane === REVIEW_LANE.notes) return join(dirs.pending, REVIEW_LANE.notes);
  if (lane === REVIEW_LANE.ingest) return join(dirs.pending, REVIEW_LANE.ingest);
  return dirs.pending;
}

/** Absolute directory a lane stages into. Signals stay flat in `Brain/pending/`. */
export function pendingLaneDir(vault: string, lane: ReviewLane): string {
  return pendingLaneDirIn(brainDirs(vault), lane);
}

/**
 * The vault-relative publish target one pending id applies into. The
 * suffix starts after `<prefix><YYYY-MM-DD>-`, so the split is
 * width-based, not dash-search-based: encoded targets carry dashes of
 * their own.
 */
function publishTargetForId(vault: string, id: string): string {
  const lane = laneOfId(id);
  const prefix =
    lane === REVIEW_LANE.signals ? "sig-" : lane === REVIEW_LANE.notes ? "note-" : "ing-";
  const suffix = id.slice(prefix.length + "YYYY-MM-DD-".length);
  if (lane === REVIEW_LANE.signals) return `${BRAIN_INBOX_REL}/${id}.md`;
  if (lane === REVIEW_LANE.notes) return `${decodePendingTargetPath(suffix)}.md`;
  return `${BRAIN_SOURCES_REL}/${suffix}.md`;
}

// ----- Dispositions ---------------------------------------------------------

/**
 * Who is writing, for the document-backed disposition arm (Task 12).
 * Structural twin of the permissions resolver's subject; the document
 * arm swaps to the substrate's own type when it lands.
 */
export interface PermissionSubject {
  readonly agent: string;
  readonly via: "token" | "config" | "operator";
}

/** How one write should proceed, with the rule that decided it. */
export interface WriteDisposition {
  readonly verdict: "publish" | "stage" | "refuse";
  /** The config key, env twin, or document rule that decided. */
  readonly source: string;
  /** Why, when the disposition is not the plain publish path. */
  readonly reason?: string;
  /** The pending id a stage would use, when deterministic. */
  readonly pendingId?: string;
}

/**
 * The config key or env twin that decided a lane's toggle, for the
 * disposition's `source`. Resolution is the gate's own (lane key, then
 * master, then off), re-read here so the source names the SAME link in
 * the chain the verdict came from.
 */
function decidingSource(lane: ReviewLane): string {
  const laneEnv =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_ENV_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_ENV_KEY
        : undefined;
  const laneKey =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_CONFIG_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_CONFIG_KEY
        : undefined;
  if (laneEnv !== undefined && process.env[laneEnv] !== undefined && process.env[laneEnv] !== "") {
    return laneEnv;
  }
  if (laneKey !== undefined) {
    const raw = discoverConfig().data[laneKey];
    if (typeof raw === "string" && raw.trim() !== "") return laneKey;
  }
  const masterEnv = process.env[WRITE_APPROVAL_ENABLED_ENV_KEY];
  if (masterEnv !== undefined && masterEnv !== "") return WRITE_APPROVAL_ENABLED_ENV_KEY;
  return WRITE_APPROVAL_ENABLED_CONFIG_KEY;
}

/**
 * Resolve the write disposition for one lane. With no permissions
 * document the write-approval lane keys decide: on = stage, off =
 * publish. (`vault` names the vault the write targets; the
 * document-backed arm reads it in Task 12.)
 */
export function resolveWriteDisposition(
  vault: string,
  lane: ReviewLane,
  subject?: PermissionSubject,
): WriteDisposition {
  void vault;
  void subject;
  const on = resolveWriteApprovalLane(lane);
  return Object.freeze({
    verdict: on ? "stage" : "publish",
    source: decidingSource(lane),
  });
}

// ----- Staging --------------------------------------------------------------

export interface StageForReviewResult {
  readonly pendingId: string;
  readonly path: string;
}

/**
 * Stage one write for review: write `render()`'s bytes VERBATIM into the
 * lane's pending directory under the vault-identity write guard, named
 * by the lane's deterministic pending id. Re-staging the same target
 * replaces the staged bytes - the pending document always holds the
 * latest proposed bytes, and apply publishes exactly what is on disk.
 */
export function stageForReview(
  vault: string,
  lane: ReviewLane,
  publishTarget: string,
  render: () => string,
): StageForReviewResult {
  if (lane === REVIEW_LANE.signals) {
    throw new PendingTargetPathError(
      "the signals lane stages through the writeSignal allocator " +
        "(stagePendingSignal); its pending ids carry collision suffixes a " +
        "deterministic id cannot express",
      publishTarget,
    );
  }
  // Write intent: the vault-identity assertion runs here, in the queue,
  // so a staged write is guarded exactly like a published one.
  const laneDir = pendingLaneDirIn(brainDirsForWrite(vault), lane);
  const suffix =
    lane === REVIEW_LANE.notes
      ? encodePendingTargetPath(stripMarkdownSuffix(publishTarget))
      : basename(publishTarget).replace(/\.md$/i, "");
  const date = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const prefix = lane === REVIEW_LANE.notes ? "note-" : "ing-";
  const pendingId = `${prefix}${date}-${suffix}`;
  if (!PENDING_LANE_ID_RE.test(pendingId)) {
    throw new PendingTargetPathError(
      `publish target ${JSON.stringify(publishTarget)} produces the pending id ` +
        `${JSON.stringify(pendingId)}, which the queue grammar ` +
        `(${PENDING_LANE_ID_SOURCE}) cannot carry; refusing rather than writing a name ` +
        "the queue could not list or apply",
      publishTarget,
    );
  }
  const stagedPath = ensureInsideVault(join(laneDir, `${pendingId}.md`), vault);
  const composed = `${pendingId}.md`;
  if (Buffer.byteLength(composed, "utf8") > PENDING_FILENAME_MAX_BYTES) {
    throw new PendingTargetPathError(
      `pending filename ${JSON.stringify(composed)} is ${Buffer.byteLength(composed, "utf8")} ` +
        `bytes, past the ${PENDING_FILENAME_MAX_BYTES}-byte filesystem bound`,
      publishTarget,
    );
  }
  mkdirSync(laneDir, { recursive: true });
  atomicWriteFileSync(stagedPath, render(), { skipIfUnchanged: false });
  return { pendingId, path: stagedPath };
}

/** Strip one trailing `.md` (case-insensitive) from a publish target. */
function stripMarkdownSuffix(target: string): string {
  return target.replace(/\.md$/i, "");
}

// ----- Listing --------------------------------------------------------------

/** One staged entry, or one named unreadable file, in the queue. */
export interface PendingLaneEntry {
  readonly lane: ReviewLane;
  readonly id: string;
  /** Absolute path of the staged document. */
  readonly path: string;
  /** Vault-relative path this entry applies into. */
  readonly publishTarget?: string;
  /** Parsed signal, for the signals lane. */
  readonly signal?: BrainSignal;
  /** Parsed frontmatter, for the notes and ingest lanes. */
  readonly frontmatter?: FrontmatterMap;
  /** Body below the frontmatter, for the notes and ingest lanes. */
  readonly body?: string;
  /**
   * Present when the file could not be read as a queue entry; the
   * content fields are then absent. Named, never silently skipped.
   */
  readonly unreadableReason?: string;
}

export interface PendingLaneListing {
  /** Every readable entry, sorted by id. */
  readonly entries: ReadonlyArray<PendingLaneEntry>;
  /** Files in a lane directory that could not be read as entries. */
  readonly unreadable: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** List one lane's `.md` files (the directory may not exist yet). */
function laneDirFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

/** Read one staged file into an entry, or into a named-unreadable row. */
function readLaneEntry(vault: string, lane: ReviewLane, path: string): PendingLaneEntry {
  const id = basename(path).slice(0, -".md".length);
  const base: PendingLaneEntry = { lane, id, path };
  if (!PENDING_LANE_ID_RE.test(id)) {
    return { ...base, unreadableReason: "name does not match the pending id grammar" };
  }
  try {
    if (lane === REVIEW_LANE.signals) {
      return { ...base, ...signalFields(path), publishTarget: publishTargetForId(vault, id) };
    }
    const [meta, body] = parseFrontmatter(path);
    return {
      ...base,
      frontmatter: meta,
      body,
      publishTarget: publishTargetForId(vault, id),
    };
  } catch (err) {
    return {
      ...base,
      unreadableReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The signals lane parses its documents through the signal reader. */
function signalFields(path: string): { readonly signal: BrainSignal } {
  return { signal: parseSignal(path) };
}

/**
 * List the queue. `lane` selects one lane or `"all"`. Deterministic:
 * sorted by id, with unreadable files partitioned into a named list
 * rather than skipped silently or allowed to break the listing.
 */
export function listPendingLane(vault: string, lane: ReviewLane | "all"): PendingLaneListing {
  const lanes: ReadonlyArray<ReviewLane> =
    lane === "all" ? [REVIEW_LANE.signals, REVIEW_LANE.notes, REVIEW_LANE.ingest] : [lane];
  const entries: PendingLaneEntry[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  for (const one of lanes) {
    for (const path of laneDirFiles(pendingLaneDir(vault, one))) {
      const entry = readLaneEntry(vault, one, path);
      if (entry.unreadableReason !== undefined) {
        unreadable.push({ path, reason: entry.unreadableReason });
      } else {
        entries.push(entry);
      }
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, unreadable: unreadable };
}

// ----- Apply / reject -------------------------------------------------------

export interface PendingLaneApplyOptions {
  /** True previews the move and writes nothing; false performs it. */
  readonly dryRun?: boolean;
}

export interface PendingLaneApplyResult {
  readonly id: string;
  readonly path: string;
  /** True when this was a preview and nothing moved. */
  readonly dryRun: boolean;
}

export interface PendingLaneRejectOptions {
  /** True previews the retire render and writes nothing. */
  readonly dryRun?: boolean;
  /** Injected clock for a deterministic `retired_at`. Defaults to now. */
  readonly now?: Date;
}

export interface PendingLaneRejectResult {
  readonly id: string;
  readonly path: string;
  /** True when this was a preview and nothing moved. */
  readonly dryRun?: boolean;
}

/**
 * Resolve a pending id to its staged file without writing. `forWrite`
 * selects the guarded directory resolver, following the one rule the
 * appliers share: the vault-identity assertion runs only when the call
 * will write. A dry run resolves the same paths ungated, because gating
 * a preview refuses the surface an operator reaches for to find out
 * what is wrong.
 */
function pendingLaneFilePath(vault: string, id: string, forWrite: boolean): string {
  if (!PENDING_LANE_ID_RE.test(id)) throw new InvalidPendingIdError(id);
  const dirs = forWrite ? brainDirsForWrite(vault) : brainDirs(vault);
  const laneDir = pendingLaneDirIn(dirs, laneOfId(id));
  return ensureInsideVault(join(laneDir, `${id}.md`), vault);
}

/**
 * Apply a staged entry: move it into its decoded publish target
 * UNCHANGED. The bytes are copied verbatim and the staged copy is
 * removed only after the target copy lands, behind an exclusive create
 * that refuses an occupied target. A missing id is a typed error.
 *
 * `dryRun` reports the move and writes nothing. The preview runs every
 * check the apply runs - id shape, staged file present, target free,
 * decoded target inside the vault - and stops before the two calls that
 * touch disk, so the report it gives is the move the apply would make
 * rather than a guess at it.
 */
export function applyPendingLane(
  vault: string,
  id: string,
  opts: PendingLaneApplyOptions = {},
): PendingLaneApplyResult {
  const dryRun = opts.dryRun === true;
  const src = pendingLaneFilePath(vault, id, !dryRun);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const target = publishTargetForId(vault, id);
  let dest: string;
  try {
    dest = ensureInsideVault(join(vault, target), vault);
  } catch (err) {
    throw new PendingTargetPathError(
      `pending id ${JSON.stringify(id)} decodes to ${JSON.stringify(target)}, which resolves ` +
        `outside the vault: ${err instanceof Error ? err.message : String(err)}`,
      target,
    );
  }
  if (existsSync(dest)) throw new PendingApplyConflictError(id, dest);
  if (dryRun) return { id, path: dest, dryRun: true };

  const contents = readFileSync(src, "utf8");
  mkdirSync(dirname(dest), { recursive: true });
  // Exclusive create: never clobber an existing target with the same
  // name. This is the real gate - the check above makes the preview
  // honest, it does not replace the atomic one.
  atomicCreateFileSyncExclusive(dest, contents);
  unlinkSync(src);
  return { id, path: dest, dryRun: false };
}

/**
 * Reject a staged entry: render it into `Brain/retired/` with
 * retire-shaped frontmatter (`_status: "retired"`, `retired_at`,
 * `retired_reason`), keeping the original fields for the audit trail and
 * stamping `osb_pending_lane` with the lane the entry came from - at
 * reject time only; publish never transforms. A missing id is a typed
 * error. `dryRun` runs the same checks and writes nothing.
 */
export function rejectPendingLane(
  vault: string,
  id: string,
  reason: string,
  opts: PendingLaneRejectOptions = {},
): PendingLaneRejectResult {
  const dryRun = opts.dryRun === true;
  const src = pendingLaneFilePath(vault, id, !dryRun);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const lane = laneOfId(id);
  const now = opts.now ?? new Date();

  const [meta, body] = parseFrontmatter(src);
  const nextMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "_status" || k === "retired_at" || k === "retired_reason") continue;
    if (k === "osb_pending_lane") continue;
    if (k === "tags") {
      const arr = Array.isArray(v) ? [...v] : [];
      nextMeta["tags"] = arr.map((t) => (t === "brain/signal" ? "brain/retired" : t));
      continue;
    }
    nextMeta[k] = v as never;
  }
  nextMeta["_status"] = "retired";
  nextMeta["retired_at"] = now.toISOString();
  nextMeta["retired_reason"] = reason;
  nextMeta["osb_pending_lane"] = lane;

  const retiredDir = (dryRun ? brainDirs(vault) : brainDirsForWrite(vault)).retired;
  const dest = ensureInsideVault(join(retiredDir, `${id}.md`), vault);
  if (dryRun) return { id, path: dest, dryRun: true };

  writeFrontmatterAtomic(dest, nextMeta, body, {
    overwrite: false,
    vaultForRelativePath: vault,
  });
  unlinkSync(src);
  return { id, path: dest };
}

/** The disposition source names, kept next to the resolvers that read them. */
export const WRITE_APPROVAL_SOURCES = Object.freeze({
  masterConfig: WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  masterEnv: WRITE_APPROVAL_ENABLED_ENV_KEY,
  notesConfig: WRITE_APPROVAL_NOTES_CONFIG_KEY,
  notesEnv: WRITE_APPROVAL_NOTES_ENV_KEY,
  ingestConfig: WRITE_APPROVAL_INGEST_CONFIG_KEY,
  ingestEnv: WRITE_APPROVAL_INGEST_ENV_KEY,
});
