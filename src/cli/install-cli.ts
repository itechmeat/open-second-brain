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

const CLI_SCRIPTS = ["o2b", "vault-log"] as const;

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
      } else {
        let existing = "unknown";
        try {
          existing = readlinkSync(link);
        } catch {
          // ignore
        }
        outcomes.push([
          name,
          `warning: ${link} already points to ${existing}, not overwriting`,
        ]);
      }
    } else if (existsSync(link)) {
      outcomes.push([name, `warning: ${link} exists and is not a symlink, not overwriting`]);
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
