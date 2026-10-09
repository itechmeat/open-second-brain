import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Claude Code projects directory uses a single leading-dash slug — e.g.
 * vault `/srv/projects/foo` maps to `~/.claude/projects/-srv-projects-foo/`.
 * The leading `/` of the absolute path is stripped first, then the
 * remaining slashes become dashes. Verified against
 * `ls /root/.claude/projects/` on the VPS where slugs are `-root`,
 * `-srv-projects-open-second-brain`, etc.
 */
export function defaultMemoryDir(vault: string): string {
  const slug = "-" + vault.replace(/^\/+/, "").replace(/\//g, "-");
  return resolve(homedir(), ".claude", "projects", slug, "memory");
}

/**
 * Render a path under the operator's home directory home-relative (`~/...`),
 * any other path verbatim. The default memory location is derived from
 * `homedir()`, so a refusal about that location must not expand the home
 * into output - the sibling safety refusal already spells the directory as
 * `~/.claude/projects/`, and operator-supplied arguments keep their verbatim
 * echo.
 */
export function homeRelativePath(p: string): string {
  const home = resolve(homedir());
  const abs = resolve(p);
  if (abs === home) return "~";
  if (abs.startsWith(home + sep)) {
    // Display form: forward slashes on every platform, matching the
    // `~/.claude/projects/` spelling this refusal's siblings use.
    return `~${abs.slice(home.length).split(sep).join("/")}`;
  }
  return p;
}

/**
 * Refuse to import from anywhere outside `~/.claude/projects/`. The
 * comparison runs after `realpathSync` so a symlink pointing to a
 * sensitive system directory cannot smuggle reads — the realpath is
 * what matters, not the link path. Non-existent paths get the lexical
 * `resolve()` treatment (caller will hit ENOENT next anyway).
 */
export function assertSafeMemoryPath(path: string, override: boolean): void {
  if (override) return;
  const root = realResolveDir(resolve(homedir(), ".claude", "projects")) + sep;
  const norm = realResolveDir(resolve(path));
  if (!norm.startsWith(root)) {
    throw new Error(
      `refusing to import from ${path}: it is not under ~/.claude/projects/.\n` +
        `Pass --allow-arbitrary-memory-path to override.`,
    );
  }
}

function realResolveDir(p: string): string {
  if (!existsSync(p)) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
