/**
 * Project vault pointers (Workspace Insight Suite, t_1375e69f).
 *
 * A `.o2b-vault.json` pointer file links any project directory - a repo,
 * a monorepo package, a sibling worktree - to its owning vault, so every
 * command launched from that directory resolves the right Brain without
 * copying vault files or pasting prompt snippets. `resolveVault` consults
 * {@link resolvePointerVault} after the `VAULT_DIR` env override and
 * before the profile/config chain: a pointer only exists when the
 * operator created one, so resolution stays artifact-gated.
 *
 * A linked-projects registry (`projects.json` beside the config file,
 * mirroring the `profiles.json` conventions: stable key order, atomic
 * writes, tolerant reads) lets `o2b brain project list|status` inspect
 * and repair every link without scanning the filesystem.
 *
 * Standalone module (no import of config.ts) so config.ts can depend on
 * it without a cycle - same constraint as `profiles.ts`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";

export const VAULT_POINTER_FILE = ".o2b-vault.json";

export interface VaultPointer {
  readonly vault: string;
  readonly linkedAt: string | null;
}

export interface PointerProbe {
  /** Pointer file location. */
  readonly path: string;
  /** Directory that contains the pointer file. */
  readonly dir: string;
  /** Parsed pointer, or null when the file is malformed. */
  readonly pointer: VaultPointer | null;
  /** Malformation reason, or null when the pointer parsed cleanly. */
  readonly error: string | null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertNotInsideVault(projectDir: string, vault: string): void {
  const project = resolve(projectDir);
  const vaultAbs = resolve(vault);
  if (project === vaultAbs || project.startsWith(vaultAbs + sep)) {
    throw new Error(
      `project directory is inside the vault it would point at (${vaultAbs}); ` +
        "a vault never needs a pointer to itself",
    );
  }
}

/** Write (or overwrite) the pointer file linking a project to a vault. */
export function writeVaultPointer(
  projectDir: string,
  vault: string,
  opts: { now?: Date } = {},
): string {
  if (!isDirectory(projectDir)) {
    throw new Error(`project directory does not exist: ${projectDir}`);
  }
  if (!isDirectory(vault)) {
    throw new Error(`vault directory does not exist: ${vault}`);
  }
  assertNotInsideVault(projectDir, vault);
  const path = join(resolve(projectDir), VAULT_POINTER_FILE);
  const linkedAt = (opts.now ?? new Date()).toISOString();
  atomicWriteFileSync(
    path,
    JSON.stringify({ vault: resolve(vault), linked_at: linkedAt }, null, 2) + "\n",
  );
  return path;
}

function probeAt(dir: string): PointerProbe | null {
  const path = join(dir, VAULT_POINTER_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const vault = raw["vault"];
    if (typeof vault !== "string" || vault.trim() === "") {
      return Object.freeze({ path, dir, pointer: null, error: "pointer has no vault field" });
    }
    const linkedAt = typeof raw["linked_at"] === "string" ? raw["linked_at"] : null;
    return Object.freeze({
      path,
      dir,
      pointer: Object.freeze({ vault, linkedAt }),
      error: null,
    });
  } catch (exc) {
    return Object.freeze({
      path,
      dir,
      pointer: null,
      error: `pointer is not valid JSON: ${(exc as Error).message}`,
    });
  }
}

/** Read the pointer file in exactly this directory (no walk-up). */
export function readVaultPointer(projectDir: string): PointerProbe | null {
  return probeAt(resolve(projectDir));
}

/** Delete the pointer file in this directory. Returns false when absent. */
export function removeVaultPointer(projectDir: string): boolean {
  const path = join(resolve(projectDir), VAULT_POINTER_FILE);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Walk up from `startDir` to the filesystem root and return the first
 * pointer file found - malformed pointers included (with `error` set),
 * so callers like `project status` can report them. Null when no
 * pointer exists anywhere up the tree.
 */
export function findVaultPointer(startDir: string): PointerProbe | null {
  let dir = resolve(startDir);
  for (;;) {
    const probe = probeAt(dir);
    if (probe !== null) return probe;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Fail-soft pointer resolution for `resolveVault`: the nearest pointer's
 * vault when it parses cleanly AND the vault directory exists; null
 * otherwise. A malformed pointer or a dangling target never throws here -
 * `project status` is the surface that reports those.
 */
export function resolvePointerVault(startDir: string): string | null {
  const probe = findVaultPointer(startDir);
  if (probe === null || probe.pointer === null) return null;
  if (!isDirectory(probe.pointer.vault)) return null;
  return probe.pointer.vault;
}

// ── Linked-projects registry ────────────────────────────────────────────────

export interface LinkedProject {
  readonly path: string;
  readonly vault: string;
}

export type LinkedPointerState = "ok" | "missing" | "malformed" | "mismatch";

export interface LinkedProjectStatus extends LinkedProject {
  readonly pointer: LinkedPointerState;
  readonly vaultExists: boolean;
}

interface ProjectsFile {
  projects: Record<string, { vault: string }>;
}

/** Path of the linked-projects registry that accompanies a config file. */
export function projectsRegistryPath(configPath: string): string {
  return join(dirname(configPath), "projects.json");
}

function loadRegistry(
  configPath: string,
  opts: { tolerateParseError?: boolean } = {},
): ProjectsFile {
  const path = projectsRegistryPath(configPath);
  if (!existsSync(path)) return { projects: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectsFile>;
    const projects: Record<string, { vault: string }> = {};
    if (raw.projects && typeof raw.projects === "object") {
      for (const [projectPath, entry] of Object.entries(raw.projects)) {
        if (entry && typeof entry === "object" && typeof entry.vault === "string") {
          projects[projectPath] = { vault: entry.vault };
        }
      }
    }
    return { projects };
  } catch (exc) {
    // Read-only callers tolerate a malformed registry (treat as empty);
    // mutating callers must fail fast so a save() does not clobber a
    // file we could not parse, silently dropping every other project
    // (same contract as profiles.ts).
    if (!opts.tolerateParseError) {
      throw new Error(`projects registry is malformed: ${path}`, { cause: exc });
    }
    return { projects: {} };
  }
}

function saveRegistry(configPath: string, data: ProjectsFile): void {
  const path = projectsRegistryPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  // Stable key order for byte-identical writes under Syncthing.
  const ordered: ProjectsFile = {
    projects: Object.fromEntries(
      Object.keys(data.projects)
        .toSorted()
        .map((k) => [k, data.projects[k]!]),
    ),
  };
  atomicWriteFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
}

/** Record (or update) a project link in the registry. */
export function registerLinkedProject(configPath: string, projectDir: string, vault: string): void {
  const data = loadRegistry(configPath);
  data.projects[resolve(projectDir)] = { vault: resolve(vault) };
  saveRegistry(configPath, data);
}

/** Drop a project link from the registry. Returns false when absent. */
export function unregisterLinkedProject(configPath: string, projectDir: string): boolean {
  const data = loadRegistry(configPath);
  const key = resolve(projectDir);
  if (!(key in data.projects)) return false;
  delete data.projects[key];
  saveRegistry(configPath, data);
  return true;
}

/** Every registered project link, sorted by path. */
export function listLinkedProjects(configPath: string): ReadonlyArray<LinkedProject> {
  const data = loadRegistry(configPath, { tolerateParseError: true });
  return Object.freeze(
    Object.keys(data.projects)
      .toSorted()
      .map((path) => Object.freeze({ path, vault: data.projects[path]!.vault })),
  );
}

/**
 * Health of every registered link: whether the pointer file is present,
 * parseable, and agrees with the registry, and whether the vault it
 * names still exists.
 */
export function linkedProjectsStatus(configPath: string): ReadonlyArray<LinkedProjectStatus> {
  return Object.freeze(
    listLinkedProjects(configPath).map((project) => {
      const probe = readVaultPointer(project.path);
      let pointer: LinkedPointerState;
      if (probe === null) pointer = "missing";
      else if (probe.pointer === null) pointer = "malformed";
      else if (resolve(probe.pointer.vault) !== resolve(project.vault)) pointer = "mismatch";
      else pointer = "ok";
      return Object.freeze({
        path: project.path,
        vault: project.vault,
        pointer,
        vaultExists: isDirectory(project.vault),
      });
    }),
  );
}
