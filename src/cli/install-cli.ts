/**
 * Install (and remove) CLI symlinks for `o2b` and `vault-log` in `~/.local/bin`.
 *
 * Mirrors `src/open_second_brain/install_cli.py`. Refuses to overwrite a
 * symlink that already points to a different repo's checkout — that's the
 * documented behavior across multi-runtime installs.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { InstallResult, UninstallResult } from "../core/types.ts";

const CLI_SCRIPTS = ["o2b", "vault-log", "o2b-hook"] as const;

function repoRoot(): string {
  // src/cli/install-cli.ts → repo/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function scriptsDir(): string {
  return join(repoRoot(), "scripts");
}

function findScript(name: string): string | null {
  const path = join(scriptsDir(), name);
  if (existsSync(path) && statSync(path).isFile()) return resolve(path);
  return null;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Match Python's `Path.resolve()` semantics, which follows symlinks. Plain
 * `path.resolve()` does not — it just normalises path components.
 */
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isValidSymlink(link: string, target: string): boolean {
  try {
    return realpath(link) === realpath(target);
  } catch {
    return false;
  }
}

/** Raw (possibly relative) target stored in the symlink, or null. */
function rawLinkTarget(link: string): string | null {
  try {
    return readlinkSync(link);
  } catch {
    return null;
  }
}

/** True when the symlink resolves to an existing file (i.e. is not dangling). */
function linkResolves(link: string): boolean {
  try {
    return existsSync(realpathSync(link));
  } catch {
    return false;
  }
}

/**
 * Does an absolute path look like one of OUR CLI scripts from some Open Second
 * Brain checkout, i.e. `<anything>/scripts/<name>`? Used to decide whether a
 * non-current symlink is safe to reclaim (ours, just stale) vs. owned by an
 * unrelated tool (leave it alone).
 */
function looksLikeOsbScript(absTarget: string, name: string): boolean {
  const parts = absTarget.split(sep);
  return parts[parts.length - 1] === name && parts[parts.length - 2] === "scripts";
}

/** Heuristic: the target lives inside a Claude Code plugin cache, which rotates
 * version directories on update (so the symlink is expected to go stale). */
function underPluginCache(absTarget: string): boolean {
  return absTarget.includes(`${sep}plugins${sep}cache${sep}`);
}

/** Absolute form of a symlink's stored target (resolved against the link dir). */
function absoluteTarget(link: string): string | null {
  const raw = rawLinkTarget(link);
  if (raw === null) return null;
  return resolve(dirname(link), raw);
}

/**
 * Explicit `install-cli` may reclaim a symlink that is dangling or that points
 * at any OSB checkout's `scripts/<name>` (the user ran install-cli on purpose,
 * so re-pointing to the running checkout is the intent). It must NOT clobber a
 * symlink owned by an unrelated tool or a real file.
 */
function canReclaimOnInstall(link: string, name: string): boolean {
  if (!linkResolves(link)) return true; // dangling
  const abs = absoluteTarget(link);
  return abs !== null && looksLikeOsbScript(abs, name);
}

export function installCli(bindir?: string): InstallResult {
  const dir = bindir ?? join(homedir(), ".local", "bin");
  mkdirSync(dir, { recursive: true });

  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];

  for (const name of CLI_SCRIPTS) {
    const link = join(dir, name);
    const source = findScript(name);
    if (source === null) {
      const msg = `error: script 'scripts/${name}' not found in ${scriptsDir()}`;
      outcomes.push([name, msg]);
      errors.push(msg);
      continue;
    }

    if (isLink(link)) {
      if (isValidSymlink(link, source)) {
        outcomes.push([name, `exists: ${link} → ${source}`]);
      } else if (canReclaimOnInstall(link, name)) {
        // Stale OSB symlink (e.g. pointing at a removed/old plugin version) or
        // a dangling link: re-point it to the current checkout instead of
        // forcing the user to delete it by hand. Idempotent across updates.
        try {
          unlinkSync(link);
          symlinkSync(source, link);
          outcomes.push([name, `repointed: ${link} → ${source}`]);
        } catch (exc) {
          const msg = `error: could not repoint symlink ${link}: ${(exc as Error).message ?? exc}`;
          outcomes.push([name, msg]);
          errors.push(msg);
        }
      } else {
        let existing = "unknown";
        try {
          existing = readlinkSync(link);
        } catch {
          // ignore
        }
        // Conflict with a symlink owned by an unrelated tool: refuse, and
        // report as an error so cmdInstallCli exits non-zero.
        const msg = `error: ${link} already points to ${existing} (not an Open Second Brain script), not overwriting`;
        outcomes.push([name, msg]);
        errors.push(msg);
      }
    } else if (existsSync(link)) {
      const msg = `error: ${link} exists and is not a symlink, not overwriting`;
      outcomes.push([name, msg]);
      errors.push(msg);
    } else {
      try {
        symlinkSync(source, link);
        outcomes.push([name, `created: ${link} → ${source}`]);
      } catch (exc) {
        const msg = `error: could not create symlink ${link}: ${(exc as Error).message ?? exc}`;
        outcomes.push([name, msg]);
        errors.push(msg);
      }
    }
  }
  return { bindir: dir, outcomes, errors };
}

/**
 * Best-effort, non-interactive repair of the `~/.local/bin` CLI symlinks,
 * meant to run from a SessionStart hook. Unlike `installCli`, this is automatic
 * and therefore conservative: it only touches a symlink that is
 *   - dangling (its target was removed by a plugin update), or
 *   - an OSB `scripts/<name>` link that lives inside a Claude Code plugin cache
 *     (which rotates version dirs on update) and is not already current.
 * It NEVER repoints a stable-directory install (e.g. `/srv/projects/...` used by
 * Hermes/Codex on a server), never touches a foreign symlink, and never touches
 * a real file. Resolves the current checkout from this module's own location,
 * so it heals even when the on-PATH `o2b` is the stale one.
 */
export function healCliSymlinks(bindir?: string): InstallResult {
  const dir = bindir ?? join(homedir(), ".local", "bin");
  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];

  for (const name of CLI_SCRIPTS) {
    const link = join(dir, name);
    const source = findScript(name);
    if (source === null) continue; // cannot heal what we cannot source
    if (!isLink(link)) continue; // absent, or a real file we must not touch
    if (isValidSymlink(link, source)) continue; // already current

    // Only auto-heal a link whose stored target is clearly OURS and lives in a
    // version-rotating plugin cache (works for dangling links too, since the
    // stored target is read via readlink). A dangling link that points at a
    // stable-dir or foreign install is left alone - automatic repair must not
    // hijack installs it does not own.
    const abs = absoluteTarget(link);
    const reclaimable = abs !== null && looksLikeOsbScript(abs, name) && underPluginCache(abs);
    if (!reclaimable) continue;

    try {
      unlinkSync(link);
      symlinkSync(source, link);
      outcomes.push([name, `healed: ${link} → ${source}`]);
    } catch (exc) {
      errors.push(`could not heal ${link}: ${(exc as Error).message ?? exc}`);
    }
  }
  return { bindir: dir, outcomes, errors };
}

export function uninstallCli(bindir?: string): UninstallResult {
  const dir = bindir ?? join(homedir(), ".local", "bin");
  const repoScripts = scriptsDir();
  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];

  for (const name of CLI_SCRIPTS) {
    const link = join(dir, name);
    if (!isLink(link)) {
      if (existsSync(link)) {
        outcomes.push([name, `skipped: ${link} is not a symlink — refusing to remove`]);
      } else {
        outcomes.push([name, `skipped: ${link} does not exist`]);
      }
      continue;
    }

    let target: string;
    try {
      target = realpath(link);
    } catch (exc) {
      const msg = `error: cannot resolve ${link}: ${(exc as Error).message ?? exc}`;
      outcomes.push([name, msg]);
      errors.push(msg);
      continue;
    }

    const repoScriptsReal = realpath(repoScripts);
    if (!target.startsWith(repoScriptsReal + sep) && target !== repoScriptsReal) {
      outcomes.push([
        name,
        `skipped: ${link} → ${target} is outside this repo's scripts/ — refusing to remove`,
      ]);
      continue;
    }

    try {
      unlinkSync(link);
      outcomes.push([name, `removed: ${link}`]);
    } catch (exc) {
      const msg = `error: cannot unlink ${link}: ${(exc as Error).message ?? exc}`;
      outcomes.push([name, msg]);
      errors.push(msg);
    }
  }
  return { bindir: dir, outcomes, errors };
}

export function renderInstallResult(result: InstallResult): string {
  const lines: string[] = [];
  lines.push(`o2b install-cli — ${result.bindir}`);
  lines.push("-".repeat(40));
  for (const [name, msg] of result.outcomes) {
    lines.push(`  ${name}: ${msg}`);
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`${result.errors.length} error(s).`);
  }
  return lines.join("\n").replace(/\s+$/g, "") + "\n";
}

export function renderUninstallResult(result: UninstallResult): string {
  const lines: string[] = [];
  lines.push(`o2b uninstall --remove-cli — ${result.bindir}`);
  lines.push("-".repeat(40));
  for (const [name, msg] of result.outcomes) {
    lines.push(`  ${name}: ${msg}`);
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`${result.errors.length} error(s).`);
  }
  return lines.join("\n").replace(/\s+$/g, "") + "\n";
}
