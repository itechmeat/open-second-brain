/**
 * `o2b install-cli` on native Windows: `.cmd` launchers instead of symlinks.
 *
 * A symlink on Windows needs Developer Mode or an elevated token, and
 * `cmd.exe` cannot run the bash launchers a POSIX symlink would point at.
 * So each CLI name gets a two-line batch file in the bin directory that
 * hands over to the checkout's own `scripts\<name>.cmd`:
 *
 *     @echo off
 *     rem open-second-brain launcher -> C:\...\scripts\o2b.cmd
 *     "C:\...\scripts\o2b.cmd" %*
 *
 * Jumping to another batch file without `call` transfers control, so the
 * target's exit code and stdin (the MCP stdio stream) pass straight
 * through. The `rem` line is the ownership marker: it is how install,
 * heal and uninstall tell a launcher this tool wrote from a file somebody
 * else put there, the job `readlink` does on POSIX. The policy mirrors the
 * symlink one exactly - create, repoint our own stale launcher, refuse a
 * foreign file, heal only a dangling or plugin-cache launcher, uninstall
 * only a launcher that points into this checkout.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { atomicWriteFileSync } from "../core/fs-atomic.ts";
import type { InstallResult, UninstallResult } from "../core/types.ts";

/** The first words of the ownership marker line. */
export const LAUNCHER_MARKER = "rem open-second-brain launcher -> ";

/** File name of the launcher for CLI name `name`. */
export function launcherFileName(name: string): string {
  return `${name}.cmd`;
}

/** The launcher body that hands over to `target`. CRLF: it is a batch file. */
export function launcherBody(target: string): string {
  return ["@echo off", `${LAUNCHER_MARKER}${target}`, `"${target}" %*`, ""].join("\r\n");
}

/**
 * The target a launcher this tool wrote points at, or `null` when `file`
 * is absent, unreadable, or not one of ours.
 */
export function launcherTarget(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(LAUNCHER_MARKER)) {
      const target = line.slice(LAUNCHER_MARKER.length).trim();
      return target.length > 0 ? target : null;
    }
  }
  return null;
}

function samePath(a: string, b: string): boolean {
  // NTFS is case-insensitive; compare the way the filesystem does.
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** `<anything>\scripts\<name>.cmd` - a launcher target from some OSB checkout. */
function looksLikeOsbLauncherTarget(target: string, name: string): boolean {
  const parts = resolve(target).split(sep);
  return (
    parts[parts.length - 1]?.toLowerCase() === launcherFileName(name).toLowerCase() &&
    parts[parts.length - 2]?.toLowerCase() === "scripts"
  );
}

function underPluginCache(target: string): boolean {
  return resolve(target).toLowerCase().includes(`${sep}plugins${sep}cache${sep}`);
}

/** Where the checkout's own `scripts\<name>.cmd` lives, or `null` if absent. */
function sourceFor(scriptsDir: string, name: string): string | null {
  const path = join(scriptsDir, launcherFileName(name));
  return existsSync(path) ? resolve(path) : null;
}

function write(file: string, target: string): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, launcherBody(target));
}

export function installCliWindows(
  names: ReadonlyArray<string>,
  scriptsDir: string,
  dir: string,
): InstallResult {
  mkdirSync(dir, { recursive: true });
  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];

  for (const name of names) {
    const file = join(dir, launcherFileName(name));
    const source = sourceFor(scriptsDir, name);
    if (source === null) {
      const msg = `error: launcher 'scripts\\${launcherFileName(name)}' not found in ${scriptsDir}`;
      outcomes.push([name, msg]);
      errors.push(msg);
      continue;
    }
    const current = launcherTarget(file);
    try {
      if (current !== null && samePath(current, source)) {
        outcomes.push([name, `exists: ${file} → ${source}`]);
      } else if (
        current !== null &&
        (!existsSync(current) || looksLikeOsbLauncherTarget(current, name))
      ) {
        write(file, source);
        outcomes.push([name, `repointed: ${file} → ${source}`]);
      } else if (current !== null) {
        const msg = `error: ${file} already points to ${current} (not an Open Second Brain launcher), not overwriting`;
        outcomes.push([name, msg]);
        errors.push(msg);
      } else if (existsSync(file)) {
        const msg = `error: ${file} exists and is not an Open Second Brain launcher, not overwriting`;
        outcomes.push([name, msg]);
        errors.push(msg);
      } else {
        write(file, source);
        outcomes.push([name, `created: ${file} → ${source}`]);
      }
    } catch (exc) {
      const msg = `error: could not write launcher ${file}: ${(exc as Error).message ?? exc}`;
      outcomes.push([name, msg]);
      errors.push(msg);
    }
  }
  return { bindir: dir, outcomes, errors };
}

export function healCliWindows(
  names: ReadonlyArray<string>,
  scriptsDir: string,
  dir: string,
): InstallResult {
  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];
  for (const name of names) {
    const file = join(dir, launcherFileName(name));
    const source = sourceFor(scriptsDir, name);
    if (source === null) continue;
    const current = launcherTarget(file);
    if (current === null) continue; // absent, or not ours
    if (samePath(current, source)) continue;
    const reclaimable = looksLikeOsbLauncherTarget(current, name) && underPluginCache(current);
    if (!reclaimable) continue;
    try {
      write(file, source);
      outcomes.push([name, `healed: ${file} → ${source}`]);
    } catch (exc) {
      errors.push(`could not heal ${file}: ${(exc as Error).message ?? exc}`);
    }
  }
  return { bindir: dir, outcomes, errors };
}

export function uninstallCliWindows(
  names: ReadonlyArray<string>,
  scriptsDir: string,
  dir: string,
): UninstallResult {
  const outcomes: Array<readonly [string, string]> = [];
  const errors: string[] = [];
  const root = resolve(scriptsDir).toLowerCase();
  for (const name of names) {
    const file = join(dir, launcherFileName(name));
    if (!existsSync(file)) {
      outcomes.push([name, `skipped: ${file} does not exist`]);
      continue;
    }
    const current = launcherTarget(file);
    if (current === null) {
      outcomes.push([
        name,
        `skipped: ${file} is not an Open Second Brain launcher — refusing to remove`,
      ]);
      continue;
    }
    if (
      !resolve(current)
        .toLowerCase()
        .startsWith(root + sep)
    ) {
      outcomes.push([name, `skipped: ${file} points to ${current}, not this checkout`]);
      continue;
    }
    try {
      unlinkSync(file);
      outcomes.push([name, `removed: ${file}`]);
    } catch (exc) {
      const msg = `error: could not remove ${file}: ${(exc as Error).message ?? exc}`;
      outcomes.push([name, msg]);
      errors.push(msg);
    }
  }
  return { bindir: dir, outcomes, errors };
}
