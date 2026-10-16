/**
 * Pure decision core and fail-closed backup executor for the opt-in
 * PreToolUse host-settings backup hook (t_f4555087).
 *
 * When an agent's file-tool call targets a host client's Claude
 * settings file, the hook backs the current file up - into a
 * timestamped folder beside the target, per the trust conventions
 * (src/core/trust.ts) - appends one audit receipt, and only then
 * allows the write. A failed backup denies the call: if the snapshot
 * cannot be taken, the write never proceeds (the snapshot-gate
 * semantic, one level down).
 *
 * Split, with the PreToolUse orient precedent:
 *   - {@link decideHostBackup} is the I/O-free decision: canonicalize
 *     the tool-call path (tilde, cwd-relative, symlink) and test the
 *     protected-path predicate.
 *   - {@link executeHostBackup} is the executor: read, hash, exclusive
 *     create with a bounded collision ladder, then the audit receipt.
 *
 * The wrapper (hooks/pretool-host-backup.ts) stays stdlib-only and
 * re-states the receipt shape; this core module may import freely.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { atomicCreateFileSyncExclusive, isFileAlreadyExists } from "../fs-atomic.ts";
import { appendAuditRecord } from "../reliability/audit.ts";
import { backupFolderStamp, backupRootFor } from "../trust.ts";
import { collisionCandidateName, hookAuditDir } from "./paths.ts";

/**
 * Exact set of file-tool names the hook matcher registers. Membership,
 * not a substring test, per the hooks/lib/detect.ts structural-matching
 * rule; the hooks.json matcher is the first gate, this is the second.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
]);

/** Keys under which a tool's file-path argument may appear. */
const FILE_PATH_KEYS: ReadonlyArray<string> = ["file_path", "path"];

/** Basenames of the settings files the predicate protects, in one place. */
export const PROTECTED_SETTINGS_NAMES: ReadonlySet<string> = new Set([
  "settings.json",
  "settings.local.json",
]);

/**
 * The managed directory the predicate requires the file to sit in:
 * `.claude`. Covers the user-level `~/.claude/settings*.json` and every
 * project-level `.claude/settings*.json` - the write lanes of the
 * client the hook itself runs under.
 */
const PROTECTED_DIR_NAME = ".claude";

/**
 * Bound on distinct backup-file names one allocation tries within one
 * stamp second (`<stamp>`, `<stamp>-2`, ... via
 * {@link collisionCandidateName}). Exhaustion is a typed error, never
 * an overwrite.
 */
export const HOST_BACKUP_ALLOC_MAX_ATTEMPTS = 128;

/** Input to {@link decideHostBackup}; the wrapper resolves each field. */
export interface HostBackupInput {
  readonly runtime: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** The host home, for tilde expansion. */
  readonly home: string;
  /** The working directory a relative `file_path` resolves against. */
  readonly cwd: string;
}

export type HostBackupDecision =
  | { readonly kind: "allow"; readonly reason: string }
  | { readonly kind: "backup"; readonly target: string };

/**
 * The structural decision for one tool call: does the call's file path
 * canonically name a protected Claude settings file?
 *
 * Canonicalization: tilde expansion against `home`, cwd-relative join,
 * then `realpathSync` over the deepest existing ancestor - so a
 * symlinked settings dir and its real location resolve identically,
 * and a not-yet-existing target (a Write that would create the file)
 * still lands on the canonical path of the directory that exists.
 */
export function decideHostBackup(input: HostBackupInput): HostBackupDecision {
  if (!WRITE_TOOL_NAMES.has(input.toolName)) {
    return { kind: "allow", reason: `tool ${input.toolName} is not a file write` };
  }
  const raw = readFilePath(input.toolInput);
  if (raw === null) return { kind: "allow", reason: "no file path in tool input" };
  const target = canonicalizeHostPath(raw, input.home, input.cwd);
  if (!isProtectedSettingsPath(target)) {
    return { kind: "allow", reason: `${target} is not a protected settings file` };
  }
  return { kind: "backup", target };
}

function readFilePath(toolInput: Readonly<Record<string, unknown>>): string | null {
  for (const key of FILE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Tilde expansion, cwd-relative join, then symlink truth: realpath the
 * deepest existing ancestor and re-attach the unresolved tail, so a
 * canonical target comes out of a path that does not exist yet.
 */
function canonicalizeHostPath(raw: string, home: string, cwd: string): string {
  const expanded =
    raw === "~" || raw.startsWith(`~${sep}`) || raw.startsWith("~/")
      ? join(home, raw.slice(1))
      : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  let prefix = normalize(absolute);
  const tail: string[] = [];
  for (;;) {
    try {
      prefix = realpathSync(prefix);
      break;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) break; // reached the root: keep lexical form
      tail.unshift(basename(prefix));
      prefix = parent;
    }
  }
  return normalize(join(prefix, ...tail));
}

/**
 * The protected-path predicate: a `.claude` settings file at any level.
 * `.codex/config.toml` is deliberately NOT matched - protect's own
 * fence manages that file, and double-guarding a file Open Second
 * Brain itself edits would make its apply lane fight this hook.
 */
function isProtectedSettingsPath(canonical: string): boolean {
  const dir = dirname(canonical);
  if (basename(dir) !== PROTECTED_DIR_NAME) return false;
  return PROTECTED_SETTINGS_NAMES.has(basename(canonical));
}

// ─── Fail-closed backup executor ──────────────────────────────────────

export interface HostBackupExecuteOptions {
  /** Canonical protected path, as {@link decideHostBackup} produced. */
  readonly target: string;
  /** Vault root for the audit receipt; `null` skips the receipt. */
  readonly vault: string | null;
  readonly now: Date;
  /** Receipt actor, e.g. `hook:claudecode`. */
  readonly actor: string;
}

export type HostBackupOutcome =
  | { readonly kind: "allow-no-source"; readonly reason: string }
  | {
      readonly kind: "backed-up";
      readonly backupPath: string;
      readonly beforeHash: string;
      /** Audit file the receipt landed in; `null` when skipped/failed. */
      readonly receiptPath: string | null;
    };

/** Typed failure of a backup: the write must not proceed. */
export class HostBackupError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "HostBackupError";
  }
}

/**
 * Back one protected file up before a write lands, or refuse.
 *
 * Fail-closed: a missing source is nothing to protect (allow, no
 * receipt); an unreadable source, a failed copy, or an exhausted
 * collision ladder raises {@link HostBackupError} naming the path - the
 * wrapper turns that into a stdout deny. A same-second second backup
 * ladders its name and never overwrites the first. Success appends
 * exactly one audit receipt carrying the trust receipt head (actor,
 * pid, before-hash, summary) plus the backup path.
 */
export function executeHostBackup(opts: HostBackupExecuteOptions): HostBackupOutcome {
  if (!existsSync(opts.target)) {
    return { kind: "allow-no-source", reason: `${opts.target} does not exist yet` };
  }

  let contents: string;
  try {
    contents = readFileSync(opts.target, "utf8");
  } catch (err) {
    throw new HostBackupError(
      `cannot read host settings file for backup: ${(err as Error).message}`,
      opts.target,
    );
  }

  const beforeHash = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  const root = backupRootFor(opts.target);
  const stamp = backupFolderStamp(opts.now);

  // Exclusive create with the shared collision ladder: a same-second
  // second backup takes `-2`, never overwrites, and a bound that trips
  // is a typed error instead of a silent overwrite.
  for (let attempt = 1; attempt <= HOST_BACKUP_ALLOC_MAX_ATTEMPTS; attempt++) {
    const candidate = join(root, collisionCandidateName(stamp, attempt));
    try {
      atomicCreateFileSyncExclusive(candidate, contents);
    } catch (err) {
      if (isFileAlreadyExists(err)) continue;
      throw new HostBackupError(
        `cannot write host settings backup for ${opts.target}: ${(err as Error).message}`,
        opts.target,
      );
    }
    return {
      kind: "backed-up",
      backupPath: candidate,
      beforeHash,
      receiptPath: appendReceipt(opts, beforeHash, candidate, contents),
    };
  }
  throw new HostBackupError(
    `host settings backup allocation exhausted for ${opts.target} ` +
      `(${HOST_BACKUP_ALLOC_MAX_ATTEMPTS} candidates taken for ${stamp}); refusing to overwrite`,
    opts.target,
  );
}

/** Best-effort receipt: one audit record, skipped without a vault. */
function appendReceipt(
  opts: HostBackupExecuteOptions,
  beforeHash: string,
  backupPath: string,
  contents: string,
): string | null {
  if (opts.vault === null) return null;
  try {
    return appendAuditRecord(hookAuditDir(opts.vault), {
      timestamp: opts.now.toISOString(),
      actor: opts.actor,
      action: "host-settings-backup",
      target: opts.target,
      ok: true,
      details: {
        pid: process.pid,
        before_hash: beforeHash,
        summary: `backed up ${basename(opts.target)} (${contents.length} bytes) before an agent file write`,
        backup: backupPath,
      },
    });
  } catch {
    // The receipt is evidence, not the guard: a failed append must not
    // turn a completed backup into a deny (the orient precedent).
    return null;
  }
}
