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

import type { FrontmatterValue } from "../types.ts";
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
  /**
   * Flattened trigger keywords from frontmatter `triggers` field.
   * Empty string when no triggers are declared.
   */
  readonly triggers: string;
  /** Absolute path to the skill directory. */
  readonly path: string;
  /** Absolute path to the SKILL.md file. */
  readonly skillFile: string;
  /**
   * Absolute paths of same-named skill directories this entry overrode, in
   * discovery order (earliest first). Empty means discovery checked and
   * found nothing shadowed; `undefined` means the entry did not come from
   * {@link discoverSkills} and therefore carries no shadow information at
   * all. Those are different answers and are not collapsed.
   */
  readonly shadowed?: ReadonlyArray<string>;
}

/**
 * A {@link SkillEntry} that came out of {@link discoverSkills}, where the
 * shadow list is always present. Narrowing it here means a caller reading
 * discovery output never needs a fallback for a field discovery always sets -
 * and a fallback there would be exactly the "absent read as empty" collapse
 * the optional field exists to prevent.
 */
export interface DiscoveredSkill extends SkillEntry {
  readonly shadowed: ReadonlyArray<string>;
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

/**
 * Flatten the frontmatter `triggers` field into a space-separated
 * keyword string. The vault frontmatter parser yields only the two
 * shapes a SKILL.md author can write - a scalar string or an inline
 * array - so those are the cases handled:
 *
 *   triggers: "research lookup 调研"        → "research lookup 调研"
 *   triggers: [research, lookup, 调研]      → "research lookup 调研"
 *
 * A non-string scalar (number/boolean) is not a meaningful keyword
 * source and flattens to the empty string.
 */
function flattenTriggers(raw: FrontmatterValue): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(" ");
  return "";
}

function readSkillEntry(root: string, dir: string): DiscoveredSkill | null {
  const path = join(root, dir);
  const skillFile = join(path, SKILL_FILE_NAME);
  if (!existsSync(skillFile)) return null;
  const [meta, body] = parseFrontmatter(skillFile);
  const metaName = typeof meta["name"] === "string" ? meta["name"].trim() : "";
  const metaDescription = typeof meta["description"] === "string" ? meta["description"].trim() : "";
  const rawTriggers = meta["triggers"];
  const triggers = rawTriggers !== undefined ? flattenTriggers(rawTriggers) : "";
  return Object.freeze({
    name: metaName.length > 0 ? metaName : dir,
    description: metaDescription.length > 0 ? metaDescription : firstBodyLine(body),
    triggers,
    path,
    skillFile,
    shadowed: Object.freeze([] as string[]),
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
 *
 * The override RETAINS the loser: the winning entry lists every path it
 * shadowed in `shadowed`, so an operator reading a surprising skill body can
 * see that a second copy exists and where it lives. Dropping that path was
 * the whole of the defect - the collapse itself is correct and deliberate.
 *
 * Directory entries are sorted within each root so a collision between two
 * same-named skills in ONE root resolves the same way on every filesystem;
 * `readdirSync` order is not specified, and an unordered winner would make
 * both the surviving entry and the recorded shadow list arbitrary.
 */
export function discoverSkills(roots: ReadonlyArray<string>): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root)
        .filter((d) => {
          try {
            return statSync(join(root, d)).isDirectory();
          } catch {
            return false;
          }
        })
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      try {
        const entry = readSkillEntry(root, dir);
        if (entry === null) continue;
        const shadowedEntry = byName.get(entry.name);
        byName.set(
          entry.name,
          shadowedEntry === undefined
            ? entry
            : Object.freeze({
                ...entry,
                shadowed: Object.freeze([...shadowedEntry.shadowed, shadowedEntry.path]),
              }),
        );
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
