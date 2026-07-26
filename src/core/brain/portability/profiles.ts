/**
 * Named multi-vault profiles (Vault portability suite, Feature 4).
 *
 * A profile registry (name -> vault path) stored as JSON in a
 * `profiles.json` beside the config file, with list / create / switch.
 * Activation is a pointer in that file - NOT a filesystem symlink, which
 * syncs inconsistently across devices under Syncthing. `resolveVault`
 * consults {@link resolveActiveProfileVault} before the bare config
 * `vault` key; with no profiles file the brain behaves exactly as before.
 *
 * This module is standalone (no import of config.ts) so config.ts can
 * depend on it without a cycle.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";

export interface VaultProfile {
  readonly name: string;
  readonly vault: string;
  readonly active: boolean;
}

export interface ProfilesListing {
  readonly profiles: ReadonlyArray<VaultProfile>;
  readonly active: string | null;
}

interface ProfilesFile {
  active: string | null;
  profiles: Record<string, { vault: string }>;
}

const EMPTY: ProfilesFile = { active: null, profiles: {} };

/** Path of the profiles registry that accompanies a config file. */
export function profilesPath(configPath: string): string {
  return join(dirname(configPath), "profiles.json");
}

function load(configPath: string, opts: { tolerateParseError?: boolean } = {}): ProfilesFile {
  const path = profilesPath(configPath);
  if (!existsSync(path)) return { active: null, profiles: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProfilesFile>;
    // Keep only well-shaped entries so a hand-edited file can't yield a
    // profile whose `vault` is undefined downstream.
    const profiles: Record<string, { vault: string }> = {};
    if (raw.profiles && typeof raw.profiles === "object") {
      for (const [name, entry] of Object.entries(raw.profiles)) {
        if (entry && typeof entry === "object" && typeof entry.vault === "string") {
          profiles[name] = { vault: entry.vault };
        }
      }
    }
    return { active: typeof raw.active === "string" ? raw.active : null, profiles };
  } catch (exc) {
    // Read-only callers tolerate a malformed registry (treat as empty);
    // mutating callers must fail fast so a save() does not clobber a file
    // we could not parse, silently dropping every stored profile.
    if (!opts.tolerateParseError) {
      throw new Error(`profiles registry is malformed: ${path}`, { cause: exc });
    }
    return { ...EMPTY };
  }
}

function save(configPath: string, data: ProfilesFile): void {
  const path = profilesPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  // Stable key order for byte-identical writes under Syncthing.
  const ordered: ProfilesFile = {
    active: data.active,
    profiles: Object.fromEntries(
      Object.keys(data.profiles)
        .toSorted()
        .map((k) => [k, data.profiles[k]!]),
    ),
  };
  atomicWriteFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
}

/** List every profile plus the active pointer. */
export function listProfiles(configPath: string): ProfilesListing {
  const data = load(configPath, { tolerateParseError: true });
  const profiles = Object.keys(data.profiles)
    .toSorted()
    .map((name) => ({
      name,
      vault: data.profiles[name]!.vault,
      active: data.active === name,
    }));
  return { profiles, active: data.active };
}

/** Create (or update) a named profile pointing at a vault path. */
export function createProfile(configPath: string, name: string, vault: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("profile name must not be empty");
  if (vault.trim().length === 0) throw new Error("profile vault must not be empty");
  const data = load(configPath);
  data.profiles[trimmed] = { vault: vault.trim() };
  save(configPath, data);
}

/**
 * Activate a named profile. Throws if the profile does not exist, or if
 * its recorded vault path is not an existing directory.
 *
 * The directory check exists because activation used to succeed against
 * a path that was never there, and the failure surfaced in a LATER
 * process - as a Brain tree materialized under the mis-resolved root by
 * the first write, which is indistinguishable from a vault where
 * nothing has been recorded yet (context-integrity-gates, Unit J). The
 * check is on the MUTATING call only; `resolveActiveProfileVault` stays
 * read-only and never throws.
 */
export function switchProfile(configPath: string, name: string): void {
  const data = load(configPath);
  const profile = data.profiles[name];
  if (!profile) {
    throw new Error(`unknown profile '${name}'`);
  }
  if (!isDirectory(profile.vault)) {
    throw new Error(`profile '${name}' points at a path that is not a directory: ${profile.vault}`);
  }
  data.active = name;
  save(configPath, data);
}

/** True when `path` exists and is a directory. Never throws. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Vault path of the active profile, or `null` when no profile is active
 * (or the active pointer dangles). Read-only; never throws.
 */
export function resolveActiveProfileVault(configPath: string): string | null {
  const data = load(configPath, { tolerateParseError: true });
  if (data.active === null) return null;
  return data.profiles[data.active]?.vault ?? null;
}
