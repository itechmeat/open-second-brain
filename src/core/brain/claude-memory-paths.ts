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
