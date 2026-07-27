/**
 * Write-approval pending queue (A3 / t_e540b093).
 *
 * When `write_approval.enabled` is on, extracted signals are STAGED into
 * `Brain/pending/` instead of `Brain/inbox/` (the frontmatter document is
 * byte-for-byte identical - staging is purely a change of directory). An
 * operator then reviews the queue:
 *
 *   - {@link listPending}    enumerate staged signals;
 *   - {@link applyPending}   move a staged file into `Brain/inbox/` UNCHANGED
 *                            (entity anchors and dedup hash preserved verbatim -
 *                            they were resolved at extraction time), or, with
 *                            `dryRun`, report the move and write nothing;
 *   - {@link rejectPending}  move a staged file into `Brain/retired/` with
 *                            retire-shaped frontmatter (`_status`, `retired_at`,
 *                            `retired_reason`), following the retire conventions.
 *
 * Applying or rejecting a missing / already-processed id raises the typed
 * {@link PendingSignalNotFoundError}; it is never a silent no-op.
 *
 * The document schema is unchanged - staging and applying reuse the exact
 * signal file that `writeSignal` produces.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicCreateFileSyncExclusive } from "../fs-atomic.ts";
import { discoverConfig } from "../config.ts";
import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { brainDirs, brainDirsForWrite, ensureInsideVault } from "./paths.ts";
import { parseSignal, writeSignal, type WriteSignalInput } from "./signal.ts";
import type { BrainSignal } from "./types.ts";

/** Config key / env twin for the opt-in write-approval queue (default off). */
export const WRITE_APPROVAL_ENABLED_CONFIG_KEY = "write_approval.enabled";
export const WRITE_APPROVAL_ENABLED_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED";

/**
 * Resolve the write-approval toggle (env wins over config file), mirroring
 * the A1/A2 flat-key resolvers. Default OFF: absent / any non-`true` value
 * keeps the direct-to-inbox behaviour byte-for-byte.
 */
export function resolveWriteApprovalEnabled(configPath?: string): boolean {
  const env = process.env[WRITE_APPROVAL_ENABLED_ENV_KEY];
  const raw =
    env !== undefined && env !== ""
      ? env
      : discoverConfig(configPath).data[WRITE_APPROVAL_ENABLED_CONFIG_KEY];
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/** A signal basename shape: `sig-<YYYY-MM-DD>-<slug>` (no path separators). */
const SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Typed error for a missing / already-processed pending id (never a no-op). */
export class PendingSignalNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`pending signal not found: ${JSON.stringify(id)}`);
    this.name = "PendingSignalNotFoundError";
    this.id = id;
  }
}

/** Typed error for an id whose shape could not be a signal basename. */
export class InvalidPendingIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`invalid pending signal id ${JSON.stringify(id)} - expected sig-<date>-<slug>`);
    this.name = "InvalidPendingIdError";
    this.id = id;
  }
}

/**
 * The inbox slot this id would move into is already occupied.
 *
 * The exclusive create in {@link applyPending} has always refused this,
 * as a raw filesystem error. It is a named error now because the dry run
 * added in no-dead-ends task 11 has to refuse it too: a preview that
 * reported a move the apply would then reject would be a preview that
 * lied, which is the defect class this release exists to remove. The
 * exclusive create stays as the actual race gate.
 */
export class PendingApplyConflictError extends Error {
  readonly id: string;
  readonly path: string;
  constructor(id: string, path: string) {
    super(`inbox already holds a signal named ${JSON.stringify(id)}: ${path}`);
    this.name = "PendingApplyConflictError";
    this.id = id;
    this.path = path;
  }
}

/** One staged signal: its id, absolute path, and parsed frontmatter. */
export interface PendingEntry {
  readonly id: string;
  readonly path: string;
  readonly signal: BrainSignal;
}

export interface StageResult {
  readonly id: string;
  readonly path: string;
}

/**
 * Stage a signal into `Brain/pending/`. Delegates to {@link writeSignal} with
 * the pending directory as the target so the staged document is byte-for-byte
 * identical to what the inbox would have received.
 */
export function stagePendingSignal(vault: string, input: WriteSignalInput): StageResult {
  const res = writeSignal(vault, input, { targetDir: brainDirsForWrite(vault).pending });
  return { id: res.id, path: res.path };
}

/**
 * Validate a pending id and resolve its absolute path inside
 * `Brain/pending/`.
 *
 * `forWrite` selects the guarded directory resolver, following the one
 * rule the appliers share: the vault-identity assertion runs only when
 * the call will write (see the write-guard section of
 * `applier-capability.ts`). A dry run resolves the same paths ungated,
 * because gating a preview refuses the surface an operator reaches for
 * to find out what is wrong.
 */
function pendingFilePath(vault: string, id: string, forWrite: boolean): string {
  if (!SIGNAL_ID_RE.test(id)) throw new InvalidPendingIdError(id);
  const dirs = forWrite ? brainDirsForWrite(vault) : brainDirs(vault);
  return ensureInsideVault(join(dirs.pending, `${id}.md`), vault);
}

/** List the staged signals in `Brain/pending/`, sorted by id. */
export function listPending(vault: string): PendingEntry[] {
  const dir = brainDirs(vault).pending;
  if (!existsSync(dir)) return [];
  const out: PendingEntry[] = [];
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.startsWith("sig-") || !file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      out.push({ id: file.slice(0, -".md".length), path, signal: parseSignal(path) });
    } catch {
      // A corrupt staged file must not break the whole listing; skip it.
    }
  }
  return out;
}

export interface PendingApplyOptions {
  /** True previews the move and writes nothing; false performs it. */
  readonly dryRun?: boolean;
}

export interface PendingApplyResult extends StageResult {
  /** True when this was a preview and nothing moved. */
  readonly dryRun: boolean;
}

/**
 * Apply a staged signal: move it into `Brain/inbox/` UNCHANGED. The bytes are
 * copied verbatim (anchors + dedup hash preserved) and the pending copy is
 * removed only after the inbox copy lands. A missing id is a typed error.
 *
 * `dryRun` reports the move and writes nothing (no-dead-ends, task 11).
 * This was the only applier in the codebase without a preview, so an
 * operator working the approval queue could apply a staged signal but
 * could not be told what applying would do first. The preview runs every
 * check the apply runs - id shape, staged file present, destination free
 * - and stops before the two calls that touch disk, so the report it
 * gives is the move the apply would make rather than a guess at it.
 */
export function applyPending(
  vault: string,
  id: string,
  opts: PendingApplyOptions = {},
): PendingApplyResult {
  const dryRun = opts.dryRun === true;
  const src = pendingFilePath(vault, id, !dryRun);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const dirs = dryRun ? brainDirs(vault) : brainDirsForWrite(vault);
  const dest = ensureInsideVault(join(dirs.inbox, `${id}.md`), vault);
  if (existsSync(dest)) throw new PendingApplyConflictError(id, dest);
  if (dryRun) return { id, path: dest, dryRun: true };

  const contents = readFileSync(src, "utf8");
  // Exclusive create: never clobber an existing inbox file with the same
  // id. This is the real gate - the check above makes the preview honest,
  // it does not replace the atomic one.
  atomicCreateFileSyncExclusive(dest, contents);
  unlinkSync(src);
  return { id, path: dest, dryRun: false };
}

export interface RejectPendingOptions {
  /** Injected clock for a deterministic `retired_at`. Defaults to now. */
  readonly now?: Date;
}

/**
 * Reject a staged signal: move it into `Brain/retired/` with retire-shaped
 * frontmatter (`_status: "retired"`, `retired_at`, `retired_reason`), keeping
 * the original signal fields for the audit trail. A missing id is a typed
 * error. The `brain/signal` tag is swapped for `brain/retired` so the moved
 * file reads as a retired artifact.
 */
export function rejectPending(
  vault: string,
  id: string,
  reason: string,
  opts: RejectPendingOptions = {},
): StageResult {
  const src = pendingFilePath(vault, id, true);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const now = opts.now ?? new Date();

  const [meta, body] = parseFrontmatter(src);
  const nextMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "_status" || k === "retired_at" || k === "retired_reason") continue;
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

  const dest = ensureInsideVault(join(brainDirsForWrite(vault).retired, `${id}.md`), vault);
  writeFrontmatterAtomic(dest, nextMeta, body, {
    overwrite: false,
    vaultForRelativePath: vault,
  });
  unlinkSync(src);
  return { id, path: dest };
}
