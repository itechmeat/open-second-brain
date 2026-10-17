#!/usr/bin/env -S bun
/**
 * PreToolUse hook: opt-in backup of host Claude settings before agent
 * file writes (t_f4555087).
 *
 * With `host_settings_backup` on (default OFF), a file-tool call
 * (Write/Edit/MultiEdit/apply_patch) whose path canonically names a
 * `.claude/settings.json` or `.claude/settings.local.json` at any level
 * gets its current content backed up - into the sibling folder beside
 * the target (`<dir>/.o2b-backups/<name>/`), each backup a FILE named
 * with the UTC stamp - and one audit receipt appended, before the call
 * is allowed to proceed. A backup that cannot be taken DENIES the call:
 * if the snapshot cannot be written, the write never proceeds.
 *
 * Guarantees:
 *   - OPT-IN: the flag is checked FIRST; unset means an immediate
 *     no-op - no process ceiling, no payload read, zero output, so
 *     every tool call stays byte-identical to today.
 *   - FAIL-CLOSED (in-hook): the deny rides stdout as
 *     `hookSpecificOutput.permissionDecision: "deny"` naming the path -
 *     the only deny channel that survives the deliberately fail-soft
 *     `scripts/o2b-hook` dispatcher. A successful backup emits NOTHING:
 *     the call proceeds through the normal permission flow (an explicit
 *     allow here would pre-approve exactly the writes this hook exists
 *     to guard).
 *   - STDLIB-ONLY: this file imports no `src/core` behavior. The flag
 *     read, path predicate, backup executor, and receipt writer are
 *     restated here (their canonical twins live in
 *     `src/core/brain/pretool-host-backup.ts`, `src/core/trust.ts` and
 *     `src/core/reliability/audit.ts`), so a broken or absent core
 *     build cannot turn a failed backup into a failed hook load. The
 *     one sanctioned exception is the two directory-name constants
 *     from the leaf `src/core/brain/path-constants.ts` - names, not
 *     behavior - so the hook-audit root keeps its single spelling
 *     (`tests/hooks/audit-root.test.ts`). The receipt contract -
 *     actor, pid, before-hash, summary - is pinned against the trust
 *     conventions by tests, not by an import.
 *   - HARD FLOOR, stated honestly: the deny guarantee ends at this
 *     process. A missing bun, a missing hook script, or the fail-soft
 *     dispatcher swallowing a non-zero exit means no deny at all and
 *     the write proceeds unprotected. Documented, not hidden.
 *
 * Known gaps, recorded per the design:
 *   - Bash-class writes (redirections, `cp`, `tee`) are out of scope;
 *     the matcher is the file-tool family, and classifying shell
 *     commands is textual matching the repo avoids.
 *   - A temp-then-rename or symlink-swap write can land on a different
 *     path than the one that was canonicalized and backed up.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { DERIVED_STORE_DIR, HOOK_AUDIT_DIR } from "../src/core/brain/path-constants.ts";
import { detectHookRuntime } from "./lib/detect.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

/** Exact file-tool family the hooks.json matcher registers. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
]);
/** Keys under which a tool's file-path argument may appear. */
const FILE_PATH_KEYS: ReadonlyArray<string> = ["file_path", "path"];
/** The settings basenames protected, and the managed dir they sit in. */
const PROTECTED_SETTINGS_NAMES: ReadonlySet<string> = new Set([
  "settings.json",
  "settings.local.json",
]);
const PROTECTED_DIR_NAME = ".claude";
/** Same-second backups ladder (`<stamp>-2`, ...); a bound, never an overwrite. */
const ALLOC_MAX_ATTEMPTS = 128;

/** The trust-conventions backup layout, restated (stdlib twin). */
const BACKUP_DIR_NAME = ".o2b-backups";
const PRE_TOOL_USE_EVENT = "PreToolUse";

function backupFolderStamp(d: Date): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1, 2)}-${p(d.getUTCDate(), 2)}` +
    `-${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}`
  );
}

function backupRootFor(target: string): string {
  return join(join(dirname(target), BACKUP_DIR_NAME), basename(target));
}

// ─── Flag and vault, read stdlib-only ──────────────────────────────────

/**
 * The machine config path, matching the core default (XDG layout); the
 * env override wins. A missing file means every key is unset.
 */
function configPath(): string {
  const override = process.env["OPEN_SECOND_BRAIN_CONFIG"]?.trim();
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return join(xdg || join(homedir(), ".config"), "open-second-brain", "config.yaml");
}

/** Value of a top-level `key:` in the config file, quotes stripped; null when unset. */
function configValue(key: string): string | null {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch {
    return null;
  }
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*(?:#.*)?$`, "m").exec(text);
  if (m === null) return null;
  const value = m[1]!.trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

/** Default-OFF flag read: env `true`/`1` wins, then the config key. */
function hostBackupEnabled(): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP"]?.trim();
  if (env) return env === "true" || env === "1";
  const key = configValue("host_settings_backup");
  return key === "true" || key === "1";
}

/**
 * The vault root the audit receipt lives under, resolved without core:
 * the explicit env vars first, then the config `vault` key. Null skips
 * the receipt - a missing vault never denies.
 */
function resolveVaultPath(): string | null {
  const env = process.env["OPEN_SECOND_BRAIN_VAULT"]?.trim() || process.env["VAULT_DIR"]?.trim();
  const raw = env || configValue("vault");
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

// ─── Path predicate (stdlib twin of decideHostBackup) ─────────────────

function canonicalize(raw: string, home: string, cwd: string): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? join(home, raw.slice(1)) : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  let prefix = normalize(absolute);
  const tail: string[] = [];
  for (;;) {
    try {
      prefix = realpathSync(prefix);
      break;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) break;
      tail.unshift(basename(prefix));
      prefix = parent;
    }
  }
  return normalize(join(prefix, ...tail));
}

function isProtectedSettingsPath(canonical: string): boolean {
  if (basename(dirname(canonical)) !== PROTECTED_DIR_NAME) return false;
  return PROTECTED_SETTINGS_NAMES.has(basename(canonical));
}

function protectedTarget(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (!WRITE_TOOL_NAMES.has(toolName)) return null;
  let raw: string | null = null;
  for (const key of FILE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) {
      raw = value;
      break;
    }
  }
  if (raw === null) return null;
  const canonical = canonicalize(raw, homedir(), process.cwd());
  return isProtectedSettingsPath(canonical) ? canonical : null;
}

// ─── Fail-closed backup + receipt (stdlib twins) ──────────────────────

function executeBackup(
  target: string,
  now: Date,
): { kind: "backed-up"; backupPath: string; beforeHash: string; bytes: number } {
  let contents: string;
  try {
    contents = readFileSync(target, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${target} for backup: ${(err as Error).message}`);
  }
  const beforeHash = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  const root = backupRootFor(target);
  const stamp = backupFolderStamp(now);
  mkdirSync(root, { recursive: true });
  for (let attempt = 1; attempt <= ALLOC_MAX_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? stamp : `${stamp}-${attempt}`;
    const candidate = join(root, name);
    // Exclusive create (O_EXCL): a same-second second backup ladders
    // its name; an exhausted ladder refuses rather than overwrites.
    let fd: number;
    try {
      fd = openSync(candidate, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "EEXIST") continue;
      throw new Error(`cannot write backup for ${target}: ${(err as Error).message}`);
    }
    try {
      writeSync(fd, contents);
    } finally {
      closeSync(fd);
    }
    return { kind: "backed-up", backupPath: candidate, beforeHash, bytes: contents.length };
  }
  throw new Error(
    `host settings backup allocation exhausted for ${target} ` +
      `(${ALLOC_MAX_ATTEMPTS} candidates taken for ${stamp}); refusing to overwrite`,
  );
}

function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The audit receipt, restated against the trust conventions (actor,
 * pid, before-hash, summary plus the backup path). Best-effort: a
 * failed append must not turn a completed backup into a deny.
 */
function appendReceipt(
  vault: string | null,
  target: string,
  backup: { backupPath: string; beforeHash: string; bytes: number },
  actor: string,
  now: Date,
): void {
  if (vault === null) return;
  try {
    const dir = join(vault, DERIVED_STORE_DIR, HOOK_AUDIT_DIR);
    mkdirSync(dir, { recursive: true });
    const record = {
      timestamp: now.toISOString(),
      actor,
      action: "host-settings-backup",
      target,
      ok: true,
      details: {
        pid: process.pid,
        before_hash: backup.beforeHash,
        summary: `backed up ${basename(target)} (${backup.bytes} bytes) before an agent file write`,
        backup: backup.backupPath,
      },
    };
    const path = join(dir, `${isoWeekLabel(now)}.jsonl`);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw err;
      fd = openSync(path, "a");
    }
    try {
      writeSync(fd, JSON.stringify(record) + "\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort: the receipt is evidence, not the guard
  }
}

// ─── Wrapper ───────────────────────────────────────────────────────────

function emitPermission(permissionDecision: "deny" | "allow", reason: string): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: PRE_TOOL_USE_EVENT,
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op - no
  // process ceiling, no payload read, zero output.
  if (!hostBackupEnabled()) return;

  // Armed only after the flag check, and imported only here, so the off
  // path (and a broken plumbing helper) stays a byte-identical no-op.
  const { armProcessCeiling, resolveHookCeilingMs } = await import("./lib/process-ceiling.ts");
  const disarm = armProcessCeiling({ ceilingMs: resolveHookCeilingMs() });
  try {
    let raw: unknown;
    try {
      raw = await readHookInput();
    } catch {
      return; // unreadable payload -> nothing to guard, fail open
    }
    const payload = asHookPayload(raw);
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const toolInput =
      payload.tool_input !== null && typeof payload.tool_input === "object"
        ? (payload.tool_input as Record<string, unknown>)
        : {};

    const target = protectedTarget(toolName, toolInput);
    if (target === null) return; // not a protected settings file: silent allow

    const now = new Date();
    try {
      const backup = executeBackup(target, now);
      appendReceipt(resolveVaultPath(), target, backup, `hook:${detectHookRuntime(raw)}`, now);
      // Silent success: the call proceeds through the normal permission
      // flow; the backup already happened. An explicit allow here would
      // pre-approve the very write this hook guards.
    } catch (err) {
      emitPermission(
        "deny",
        `host settings backup failed for ${target}; write refused: ${(err as Error).message}`,
      );
    }
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; a hook misbehaviour must not break the tool
  // call beyond the deny this hook can still have emitted.
});
