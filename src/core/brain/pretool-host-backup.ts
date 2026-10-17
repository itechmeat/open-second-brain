/**
 * Pure decision core and fail-closed backup executor for the opt-in
 * PreToolUse host-settings backup hook (t_f4555087).
 *
 * When an agent's file-tool call targets a host client's Claude
 * settings file, the hook backs the current file up - into the stamped
 * backup root beside the target, per the trust conventions
 * (src/core/trust.ts), the stamp naming the backup file inside it -
 * appends one audit receipt, and only then
 * allows the write. A failed backup denies the call: if the snapshot
 * cannot be taken, the write never proceeds (the snapshot-gate
 * semantic, one level down).
 *
 * Split, with the PreToolUse orient precedent:
 *   - {@link decideHostBackup} is the I/O-free decision: collect every
 *     path the call would write (the direct path argument, or every
 *     `*** (Update|Add|Delete) File:` header of a Codex `apply_patch`
 *     body), canonicalize each (tilde, cwd-relative, symlink) and test
 *     the protected-path predicate on the lexical AND the canonical
 *     form - either match protects, so a symlinked settings file is
 *     covered too.
 *   - {@link executeHostBackup} is the executor: read, hash, exclusive
 *     create with a bounded collision ladder, then the audit receipt -
 *     and a best-effort `*`-ignore marker in the `.o2b-backups/` root,
 *     so a project-level backup is never left for the next
 *     `git add -A` to commit.
 *
 * The wrapper (hooks/pretool-host-backup.ts) stays stdlib-only and
 * re-states the receipt shape; this core module may import freely.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { atomicCreateFileSyncExclusive, isFileAlreadyExists } from "../fs-atomic.ts";
import { appendAuditRecord } from "../reliability/audit.ts";
import { backupFolderStamp, backupRootFor, ensureBackupRootIgnored } from "../trust.ts";
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

/**
 * Codex `apply_patch` carries its targets inside the patch body, not in
 * a path argument: every `*** Update File:` / `*** Add File:` /
 * `*** Delete File:` header names one write path. The same shape
 * hooks/post-write-reminder.ts and hooks/lib/detect.ts already parse.
 */
const APPLY_PATCH_FILE_HEADER_RE = /\*\*\* (?:Update File|Add File|Delete File): ([^\n]+)/g;

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
  | { readonly kind: "backup"; readonly targets: readonly string[] };

/**
 * Every path one tool call would write, in payload order: the direct
 * `file_path`/`path` argument when present, otherwise every
 * `*** (Update|Add|Delete) File:` header in an `apply_patch` body
 * (one patch can touch several files, so several backups may be due).
 */
function readCandidatePaths(toolInput: Readonly<Record<string, unknown>>): string[] {
  const direct: string[] = [];
  for (const key of FILE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) direct.push(value);
  }
  if (direct.length > 0) return direct;
  const paths: string[] = [];
  const input = toolInput["input"];
  if (typeof input !== "string") return paths;
  for (const m of input.matchAll(APPLY_PATCH_FILE_HEADER_RE)) {
    const p = m[1]?.trim();
    if (p) paths.push(p);
  }
  return paths;
}

/**
 * The structural decision for one tool call: which of the call's write
 * paths name a protected Claude settings file?
 *
 * Canonicalization: tilde expansion against `home`, cwd-relative join,
 * then `realpathSync` over the deepest existing ancestor - so a
 * symlinked settings dir and its real location resolve identically,
 * and a not-yet-existing target (a Write that would create the file)
 * still lands on the canonical path of the directory that exists.
 *
 * The predicate runs on BOTH the lexical and the canonical form: a
 * settings file that is itself a symlink (stow-style dotfiles) resolves
 * its final component into an unprotected directory, so the realpath
 * alone says not-protected for a file every operator would call
 * `~/.claude/settings.json`. Either match protects; the lexical path
 * wins as the backup target, because that is the path the tool call
 * names and the place a backup belongs beside.
 */
export function decideHostBackup(input: HostBackupInput): HostBackupDecision {
  if (!WRITE_TOOL_NAMES.has(input.toolName)) {
    return { kind: "allow", reason: `tool ${input.toolName} is not a file write` };
  }
  const raws = readCandidatePaths(input.toolInput);
  if (raws.length === 0) return { kind: "allow", reason: "no file path in tool input" };
  const targets: string[] = [];
  for (const raw of raws) {
    const lexical = lexicallyHostPath(raw, input.home, input.cwd);
    const canonical = canonicalizeHostPath(lexical);
    const target = isProtectedSettingsPath(lexical)
      ? lexical
      : isProtectedSettingsPath(canonical)
        ? canonical
        : null;
    if (target !== null && !targets.includes(target)) targets.push(target);
  }
  if (targets.length === 0) {
    return { kind: "allow", reason: `${raws[0]} is not a protected settings file` };
  }
  return { kind: "backup", targets };
}

/**
 * The call's path with `~` and a relative cwd resolved, normalized -
 * NO symlink resolution. This lexical form is what the protected-path
 * predicate tests first: it is the path the tool call names.
 */
function lexicallyHostPath(raw: string, home: string, cwd: string): string {
  const expanded =
    raw === "~" || raw.startsWith(`~${sep}`) || raw.startsWith("~/")
      ? join(home, raw.slice(1))
      : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return normalize(absolute);
}

/**
 * Symlink truth on top of the lexical path: realpath the deepest
 * existing ancestor and re-attach the unresolved tail, so a canonical
 * target comes out of a path that does not exist yet.
 */
function canonicalizeHostPath(lexical: string): string {
  let prefix = lexical;
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
  /**
   * Protected path, as {@link decideHostBackup} produced: the lexical
   * path when it is protected (a symlinked settings file backs up
   * beside the link, and reads through it), the canonical path when
   * only the realpath is protected.
   */
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

  // Git hygiene, best-effort: a project-level backup root sits inside
  // someone's repository, and a settings.local.json copy can hold
  // tokens - without the ignore marker the next `git add -A` commits
  // it. The marker is hygiene, not the guard: a failed write never
  // fails the backup (the ladder below still denies on failure).
  try {
    ensureBackupRootIgnored(root);
  } catch {
    // hygiene marker, not the guard
  }

  // Exclusive create with the shared collision ladder: a same-second
  // second backup takes `-2`, never overwrites, and a bound that trips
  // is a typed error instead of a silent overwrite. Private 0600, the
  // mode the stdlib wrapper twin creates with - a settings backup
  // carries the same secrets the settings file does.
  for (let attempt = 1; attempt <= HOST_BACKUP_ALLOC_MAX_ATTEMPTS; attempt++) {
    const candidate = join(root, collisionCandidateName(stamp, attempt));
    try {
      atomicCreateFileSyncExclusive(candidate, contents, { mode: 0o600 });
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
