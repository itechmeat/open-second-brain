/**
 * Skill discovery (Agent Surface Suite).
 *
 * Open Second Brain ships agent skills as `skills/<name>/SKILL.md`
 * inside the plugin checkout; an operator can add vault-local skills
 * under `<vault>/Brain/skills/`. Discovery is read-only and fail-soft:
 * a missing root or an unreadable skill directory yields nothing and
 * never crashes a session. File access inside a skill directory is
 * path-traversal-guarded - agents read skill content, not the host
 * filesystem.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { firstLine } from "./descriptor.ts";

export type SkillErrorCode = "NOT_FOUND" | "INVALID_PATH";

export class SkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
  }
}

export interface SkillEntry {
  /** Frontmatter `name`, falling back to the directory name. */
  readonly name: string;
  /** Frontmatter `description`, falling back to the first body line. */
  readonly description: string;
  /** Absolute path to the skill directory. */
  readonly path: string;
  /** Absolute path to the SKILL.md file. */
  readonly skillFile: string;
}

export interface SkillRootsOptions {
  /** Plugin checkout root containing `skills/`. */
  readonly repoRoot?: string | null;
  /** Vault root; vault-local skills live at `Brain/skills/`. */
  readonly vault?: string | null;
  /**
   * Explicit skills directory override. When set, takes precedence over
   * the vault-local `Brain/skills/` path, letting operators point the
   * skill surface at an external directory (e.g. `~/.hermes/skills/`)
   * without symlinks. Supports ~ expansion via the caller.
   */
  readonly skillsDir?: string | null;
}

export const SKILL_FILE_NAME = "SKILL.md";

/** Existing skill roots in precedence order (repo first, vault last). */
export function skillRoots(opts: SkillRootsOptions): string[] {
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, "skills"));
  if (opts.skillsDir) {
    candidates.push(opts.skillsDir);
  } else if (opts.vault) {
    candidates.push(join(opts.vault, "Brain", "skills"));
  }
  return candidates.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function readSkillEntry(root: string, dir: string): SkillEntry | null {
  const path = join(root, dir);
  const skillFile = join(path, SKILL_FILE_NAME);
  if (!existsSync(skillFile)) return null;
  const [meta, body] = parseFrontmatter(skillFile);
  const metaName = typeof meta["name"] === "string" ? meta["name"].trim() : "";
  const metaDescription = typeof meta["description"] === "string" ? meta["description"].trim() : "";
  return Object.freeze({
    name: metaName.length > 0 ? metaName : dir,
    description: metaDescription.length > 0 ? metaDescription : firstBodyLine(body),
    path,
    skillFile,
  });
}

/** First non-empty, non-heading line of the SKILL.md body. */
function firstBodyLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return firstLine(trimmed);
  }
  return "";
}

/**
 * Discover skills across roots. A later root overrides an earlier one
 * on name collision (vault-local skills shadow shipped ones). Output
 * is sorted by name. Fail-soft: unreadable roots/directories skip.
 */
export function discoverSkills(roots: ReadonlyArray<string>): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root).filter((d) => {
        try {
          return statSync(join(root, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      try {
        const entry = readSkillEntry(root, dir);
        if (entry !== null) byName.set(entry.name, entry);
      } catch {
        // One malformed skill never hides the rest.
      }
    }
  }
  return [...byName.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read a file inside a skill directory. Default: SKILL.md. A relative
 * `filePath` may name an auxiliary file (reference docs, templates)
 * but can never escape the skill directory.
 */
export function readSkillFile(entry: SkillEntry, filePath?: string): string {
  if (filePath === undefined) return readFileSync(entry.skillFile, "utf8");
  if (isAbsolute(filePath)) {
    throw new SkillError("INVALID_PATH", "skill file path must be relative");
  }
  const abs = resolve(entry.path, filePath);
  if (abs !== entry.path && !abs.startsWith(entry.path + sep)) {
    throw new SkillError("INVALID_PATH", "skill file path must stay inside the skill directory");
  }
  if (!existsSync(abs)) {
    throw new SkillError("NOT_FOUND", `skill file not found: ${filePath}`);
  }
  // Re-check after symlink resolution: a link inside the skill
  // directory must not smuggle reads outside it.
  const realDir = realpathSync(entry.path);
  const realTarget = realpathSync(abs);
  if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) {
    throw new SkillError("INVALID_PATH", "skill file path must stay inside the skill directory");
  }
  return readFileSync(realTarget, "utf8");
}
