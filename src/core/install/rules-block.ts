/**
 * The shared marker-fenced rules-block writer for agent instruction files.
 *
 * ONE writer owns every byte that enters a managed block in a vault-root
 * agent rules file (AGENTS.md / CLAUDE.md / GEMINI.md). Two producers call
 * it and neither writes such a file any other way:
 *
 *   - the `usage` producer (the installer, `src/core/install/
 *     instruction-block.ts`) writes the ambient write-back gate block,
 *   - the `lessons` producer (the operator verbs over
 *     `src/core/brain/lessons-promotion.ts`) promotes approved lessons
 *     into a sibling block.
 *
 * The two producers coexist in ONE file because each block id carries its
 * OWN marker spelling: `usage` keeps the settled default managed-block
 * markers (the write-back contract's contract spellings,
 * `src/core/brain/writeback-contract.ts`), `lessons` uses a distinct
 * HTML-comment pair. The editor below validates one pair per spelling, so
 * a second block never fights the first (t_1e952e43, section 3.3).
 *
 * Invariants, each pinned by `tests/core/install/rules-block.test.ts`:
 *
 *   - every operator byte OUTSIDE the block is preserved (the
 *     `managed-block.ts` editor guarantee);
 *   - a re-apply with the canonical body is a byte no-op (`changed:
 *     false`), so producers can run on every render;
 *   - CRLF files keep CRLF line endings, detected and restored by the
 *     editor;
 *   - the first write to an existing file takes an exclusive-create,
 *     collision-laddered backup beside the file and returns its path; a
 *     no-op takes none;
 *   - a block whose body diverges from the canonical body on a file
 *     NEWER than the recorded install time is a hand edit: refused with
 *     kind `user-modified-block` unless `force` (the aider adapter's
 *     safety net, generalised here so both producers share it). A
 *     diverged block on a file OLDER than the install time is a canonical
 *     body that moved under an untouched file: rewritten, not refused.
 *     No install time at all refuses too - a block nobody recorded cannot
 *     be proven ours, and silently replacing it would clobber operator
 *     text;
 *   - symbolic links are refused before any read or write: a writer that
 *     follows a link has left the file the audit measures;
 *   - multiple, unpaired or reversed markers of the block's OWN spelling
 *     refuse with a wrapped `ManagedBlockError`; a different spelling's
 *     stray markers never block this block;
 *   - `dryRun` computes and refuses exactly like a real run and writes
 *     nothing on every path.
 *
 * This module reads and writes single files named by the caller and
 * reaches the disk only through the shared atomic writers
 * (`src/core/fs-atomic.ts`): it joins no vault path, keeps no state, and
 * never removes a file - removal means rewriting the file without the
 * block.
 */

import { lstatSync, readFileSync, statSync } from "node:fs";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  isFileAlreadyExists,
} from "../fs-atomic.ts";
import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
  ManagedBlockError,
  extractManagedBlock,
  insertManagedBlock,
  removeManagedBlock,
  type BlockOpts,
} from "./managed-block.ts";

// ----- Errors ---------------------------------------------------------------

/** Why a rules-block operation refused, as a closed vocabulary. */
export const RULES_BLOCK_ERROR_KIND = Object.freeze({
  /** The path could not be stat'ed or read as a file. */
  unreadable: "unreadable",
  /** The path is a symbolic link; the operation refuses to follow it. */
  symlink: "symlink",
  /** The block's own markers are multiple, unpaired or reversed. */
  markers: "markers",
  /** The block diverged from the canonical body on a hand-edited file. */
  userModifiedBlock: "user-modified-block",
  /**
   * The on-disk bytes moved since the caller's approved preview. Thrown
   * by the installer's plan/apply binding
   * (`src/core/install/instruction-block.ts`), which re-derives the
   * preview at apply time and must refuse a write of anything else.
   */
  previewDrift: "preview-drift",
} as const);

/** Closed union over {@link RULES_BLOCK_ERROR_KIND}. */
export type RulesBlockErrorKind =
  (typeof RULES_BLOCK_ERROR_KIND)[keyof typeof RULES_BLOCK_ERROR_KIND];

/**
 * A rules-block refusal, named so callers branch on `kind` and never on
 * message text. Marker-shape refusals carry the editor's own
 * `ManagedBlockError` as their `cause`: one validation vocabulary, two
 * error surfaces.
 */
export class RulesBlockError extends Error {
  constructor(
    message: string,
    public readonly kind: RulesBlockErrorKind,
    public readonly path: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "RulesBlockError";
  }
}

// ----- Block identity -------------------------------------------------------

/** The managed blocks this writer installs into agent rules files. */
export const RULES_BLOCK_ID = Object.freeze({
  /** The ambient write-back gate block, the write-back contract's subject. */
  usage: "usage",
  /** The operator-approved lessons block (t_1e952e43). */
  lessons: "lessons",
} as const);

/** Closed union over {@link RULES_BLOCK_ID}. */
export type RulesBlockId = (typeof RULES_BLOCK_ID)[keyof typeof RULES_BLOCK_ID];

/**
 * Each block id's marker spelling. The `usage` entry IS the settled
 * default managed-block pair - the write-back contract audits those exact
 * lines, so they are re-exported rather than re-spelled. The `lessons`
 * entry is a distinct HTML-comment pair so both blocks can live in one
 * file: the editor holds one pair per spelling, and spellings never share
 * a marker line.
 */
export const RULES_BLOCK_MARKERS: Readonly<
  Record<RulesBlockId, { readonly begin: string; readonly end: string }>
> = Object.freeze({
  usage: Object.freeze({ begin: DEFAULT_BEGIN_MARKER, end: DEFAULT_END_MARKER }),
  lessons: Object.freeze({
    begin: "<!-- >>> open-second-brain lessons >>> -->",
    end: "<!-- >>> open-second-brain lessons <<< -->",
  }),
});

/** The markers for `blockId`, as the editor's option shape. */
function blockOpts(blockId: RulesBlockId): BlockOpts {
  const markers = RULES_BLOCK_MARKERS[blockId];
  return { beginMarker: markers.begin, endMarker: markers.end };
}

// ----- Rendering ------------------------------------------------------------

export interface RenderedRulesBlock {
  readonly beginMarker: string;
  readonly endMarker: string;
  /** The full file a NEW rules file starts as, trailing newline included. */
  readonly document: string;
}

/**
 * Render the fenced document `body` becomes in a rules file. The document
 * is produced by the same editor call a write to an absent file takes, so
 * a rendered preview and a real first write cannot disagree.
 */
export function renderRulesBlock(blockId: RulesBlockId, body: string): RenderedRulesBlock {
  const markers = RULES_BLOCK_MARKERS[blockId];
  return {
    beginMarker: markers.begin,
    endMarker: markers.end,
    document: insertManagedBlock("", body, blockOpts(blockId)),
  };
}

// ----- Reading --------------------------------------------------------------

interface ReadResult {
  /** Whether any file exists at the path. */
  readonly exists: boolean;
  /** The file's bytes as read; the empty string when it does not exist. */
  readonly content: string;
  /** The file's mtime in ms, from the same lstat the refusal used. */
  readonly mtimeMs: number;
  /** True when a well-formed pair of this spelling exists. */
  readonly present: boolean;
  /** The extracted body; null unless `present`. */
  readonly body: string | null;
}

/**
 * lstat the file, refusing symbolic links and absent paths by name, then
 * read it and decide whether a well-formed pair of this spelling exists.
 *
 * The marker shapes are decided here so the refusals can be NAMED rather
 * than collapsed into a null: multiple, unpaired or reversed markers of
 * this spelling throw {@link RulesBlockError} wrapping the editor's
 * `ManagedBlockError`, while a file with no marker line of this spelling
 * at all is simply `present: false`. Extraction itself stays the editor's
 * (`extractManagedBlock`), so reading can never disagree with writing.
 */
function readRulesFile(file: string, blockId: RulesBlockId): ReadResult {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: "", mtimeMs: 0, present: false, body: null };
    }
    throw new RulesBlockError(
      `${file} could not be stat'ed: ${reason(err)}`,
      RULES_BLOCK_ERROR_KIND.unreadable,
      file,
      { cause: err },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new RulesBlockError(
      `${file} is a symbolic link - the rules-block writer refuses to follow symlinks, ` +
        "because a write through a link lands outside the file the audit measures",
      RULES_BLOCK_ERROR_KIND.symlink,
      file,
    );
  }
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    throw new RulesBlockError(
      `${file} could not be read: ${reason(err)}`,
      RULES_BLOCK_ERROR_KIND.unreadable,
      file,
      { cause: err },
    );
  }
  return { exists: true, content, mtimeMs: stat.mtimeMs, ...blockStateIn(content, blockId, file) };
}

/**
 * Whether `content` carries this block, and its body, without touching
 * the filesystem. Absent is silent; a malformed pair of this spelling is
 * a named refusal wrapping `ManagedBlockError`.
 */
function blockStateIn(
  content: string,
  blockId: RulesBlockId,
  file: string,
): { present: boolean; body: string | null } {
  const markers = RULES_BLOCK_MARKERS[blockId];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let begins = 0;
  let ends = 0;
  for (const line of lines) {
    if (line === markers.begin) begins += 1;
    if (line === markers.end) ends += 1;
  }
  if (begins === 0 && ends === 0) return { present: false, body: null };
  // The editor's validator refuses every non-single-pair shape; drive it
  // through a pure re-insert so the message vocabulary stays the editor's.
  try {
    insertManagedBlock(content, "shape probe", blockOpts(blockId));
  } catch (err) {
    if (err instanceof ManagedBlockError) {
      throw new RulesBlockError(
        `${markers.begin} / ${markers.end}: ${err.message} - fix or remove the broken ` +
          "block before this operation can run",
        RULES_BLOCK_ERROR_KIND.markers,
        file,
        { cause: err },
      );
    }
    throw err;
  }
  const body = extractManagedBlock(content, blockOpts(blockId));
  if (body === null) {
    // One begin, one end, in order - yet the editor could not extract.
    // Unreachable per the editor's contract; refused rather than guessed.
    throw new RulesBlockError(
      `${markers.begin} / ${markers.end}: a well-formed pair validated but extracted no body`,
      RULES_BLOCK_ERROR_KIND.markers,
      file,
    );
  }
  return { present: true, body };
}

/** One line an fs error message, so a multi-line reason stays one detail. */
function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

/**
 * The block body `file` carries for `blockId`, or null when the file (or
 * the pair of this spelling) does not exist. Malformed pairs and symlinks
 * refuse by name - a reader that silently ignored either would report a
 * block absent that is in fact broken or unreadable.
 */
export function readRulesBlock(file: string, blockId: RulesBlockId): string | null {
  return readRulesFile(file, blockId).body;
}

// ----- Drift ----------------------------------------------------------------

/** How a managed block compares to the canonical body it should carry. */
export const RULES_BLOCK_STATE = Object.freeze({
  /** No file, or no pair of this spelling in it. */
  absent: "absent",
  /** The pair exists and its body matches the canonical body. */
  current: "current",
  /** The pair exists but its body diverged from the canonical body. */
  drifted: "drifted",
} as const);

/** Closed union over {@link RULES_BLOCK_STATE}. */
export type RulesBlockState = (typeof RULES_BLOCK_STATE)[keyof typeof RULES_BLOCK_STATE];

export interface RulesBlockDriftResult {
  readonly state: RulesBlockState;
  /** The extracted body; null unless the pair exists. */
  readonly extracted: string | null;
}

/** True when two block bodies are the same text, ignoring the fence-adjacent trailing newline. */
function sameBlockBody(extracted: string, canonical: string): boolean {
  return stripTrailingNewline(extracted) === stripTrailingNewline(canonical);
}

function stripTrailingNewline(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

/**
 * Compare `file`'s block for `blockId` against `canonicalBody`. READ-ONLY:
 * producers call it to decide whether a write is owed, and doctor and
 * status surfaces call it to grade a managed block without writing.
 * Malformed pairs and symlinks refuse by name, as in
 * {@link readRulesBlock}.
 */
export function rulesBlockDrift(
  file: string,
  blockId: RulesBlockId,
  canonicalBody: string,
): RulesBlockDriftResult {
  const read = readRulesFile(file, blockId);
  if (!read.present) return { state: RULES_BLOCK_STATE.absent, extracted: null };
  return {
    state: sameBlockBody(read.body as string, canonicalBody)
      ? RULES_BLOCK_STATE.current
      : RULES_BLOCK_STATE.drifted,
    extracted: read.body,
  };
}

// ----- Writing --------------------------------------------------------------

export interface RulesBlockWriteOptions {
  /** Plan the write and touch nothing. Refusals still fire. */
  readonly dryRun?: boolean;
  /** Override the hand-edit refusal and write the canonical body. */
  readonly force?: boolean;
  /**
   * The install time recorded for this block, in ms. A diverged block on
   * a file newer than this (plus a small clock slack) is a hand edit and
   * refuses unless `force`; a diverged block on an older file is a
   * canonical body that moved and is rewritten. `null` or omitted means
   * no ownership record exists, so every diverged block refuses - a block
   * nobody recorded cannot be proven ours.
   */
  readonly installedAtMs?: number | null;
}

export interface RulesBlockWriteResult {
  /** True when the file's bytes changed (or would, under `dryRun`). */
  readonly changed: boolean;
  /** The exclusive-create backup of the prior bytes; null when none was taken. */
  readonly backupPath: string | null;
}

/**
 * Bound on distinct backup names one stamp tries (`<file>.bak.<ms>`,
 * `-2`, ...). Exhaustion is a typed refusal, never an overwrite.
 */
export const RULES_BLOCK_BACKUP_MAX_ATTEMPTS = 128;

/**
 * Clock slack between the recorded install time and the file mtime, in
 * ms. The aider adapter's precedent: a write that lands within a second
 * of its own record must not read as a later hand edit.
 */
const MTIME_SLACK_MS = 1000;

/** Candidate `attempt` of the backup-name ladder. */
function collisionCandidate(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`;
}

/**
 * Back the current bytes up beside `file` before the first rewrite.
 * Exclusive create (`link(2)`, `src/core/fs-atomic.ts`), private 0600,
 * same-millisecond collisions ladder the name, and an exhausted ladder is
 * a typed refusal rather than a silent overwrite.
 */
function backupRulesFile(file: string, before: string): string {
  const base = `${file}.bak.${Date.now()}`;
  for (let attempt = 1; attempt <= RULES_BLOCK_BACKUP_MAX_ATTEMPTS; attempt++) {
    try {
      atomicCreateFileSyncExclusive(collisionCandidate(base, attempt), before, { mode: 0o600 });
      return collisionCandidate(base, attempt);
    } catch (err) {
      if (!isFileAlreadyExists(err)) throw err;
    }
  }
  throw new RulesBlockError(
    `backup allocation exhausted for ${file} (${RULES_BLOCK_BACKUP_MAX_ATTEMPTS} candidates ` +
      "taken); refusing to overwrite",
    RULES_BLOCK_ERROR_KIND.unreadable,
    file,
  );
}

/**
 * Write (or plan) the managed block for `blockId` in `file`, carrying
 * `canonicalBody` between the markers.
 *
 * Absent file: the file is created with just the rendered block - no
 * backup, because there are no prior bytes. Existing file: the editor
 * inserts or replaces the pair of this spelling, every byte outside it
 * preserved; the first byte-changing write takes an exclusive-create
 * backup of the current bytes and returns its path. A byte-identical
 * re-apply reports `changed: false` and takes no backup.
 *
 * Refusals, all named: symlinks (`symlink`), unreadable paths
 * (`unreadable`), malformed marker pairs of this spelling (`markers`,
 * wrapping `ManagedBlockError`), and a hand-edited block
 * (`user-modified-block`) when the body diverged from the canonical body
 * and the file mtime is newer than `installedAtMs` - or when no install
 * time is known at all. `force` overrides only the hand-edit refusal.
 */
export function writeRulesBlock(
  file: string,
  blockId: RulesBlockId,
  canonicalBody: string,
  opts: RulesBlockWriteOptions = {},
): RulesBlockWriteResult {
  const read = readRulesFile(file, blockId);
  const absent = !read.exists;
  const next = absent
    ? renderRulesBlock(blockId, canonicalBody).document
    : insertManagedBlock(read.content, canonicalBody, blockOpts(blockId));
  if (next === read.content) return { changed: false, backupPath: null };

  // The hand-edit safety net: a diverged block on a file the operator
  // touched after the install (or with no recorded install) is theirs
  // until `force` says otherwise.
  if (read.present) {
    const diverged = !sameBlockBody(read.body as string, canonicalBody);
    const recorded = typeof opts.installedAtMs === "number" && Number.isFinite(opts.installedAtMs);
    const mtime = fileMtimeMs(file);
    const touchedAfterInstall =
      !recorded || (mtime !== null && mtime > (opts.installedAtMs as number) + MTIME_SLACK_MS);
    if (diverged && touchedAfterInstall && !opts.force) {
      throw new RulesBlockError(
        `${file} appears hand-edited after the last install (the ${blockId} block diverges ` +
          "from canonical content); refusing to overwrite. " +
          "Re-run with --force to overwrite, or uninstall first",
        RULES_BLOCK_ERROR_KIND.userModifiedBlock,
        file,
      );
    }
  }

  if (opts.dryRun) {
    return { changed: true, backupPath: null };
  }
  const backupPath = absent ? null : backupRulesFile(file, read.content);
  atomicWriteFileSync(file, next);
  return { changed: true, backupPath };
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? null;
  } catch {
    return null;
  }
}

export interface RulesBlockRemoveOptions {
  /** Plan the removal and touch nothing. */
  readonly dryRun?: boolean;
}

export interface RulesBlockRemoveResult {
  /**
   * True when the file will change (or changed): the pair of this
   * spelling existed and the file is rewritten without it.
   */
  readonly removed: boolean;
}

/**
 * Remove the managed block for `blockId` from `file`: rewrite the file
 * without that marker pair and its body, collapsing the padding the pair
 * carried, every other byte preserved. A file with no pair of this
 * spelling is a NAMED SKIP (`removed: false`), not an error, so
 * uninstalling an install that never landed stays quiet. The file itself
 * is never removed. Symlinks refuse by name, as everywhere above.
 */
export function removeRulesBlock(
  file: string,
  blockId: RulesBlockId,
  opts: RulesBlockRemoveOptions = {},
): RulesBlockRemoveResult {
  const read = readRulesFile(file, blockId);
  const state = blockStateIn(read.content, blockId, file);
  if (!state.present) return { removed: false };
  const next = removeManagedBlock(read.content, blockOpts(blockId));
  if (next === read.content) return { removed: false };
  if (opts.dryRun) return { removed: true };
  atomicWriteFileSync(file, next);
  return { removed: true };
}
