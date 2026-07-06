/**
 * Read-only recall sources (Workspace Insight Suite, t_1375e69f).
 *
 * Another vault can be attached to the active Brain as a READ-ONLY
 * recall origin: cross-vault search may read it, write tools never
 * touch it. The registry (`recall-sources.json` beside the config
 * file, mirroring the `profiles.json` conventions) is keyed by the
 * OWNING vault, so each Brain keeps its own source list and switching
 * profiles never leaks one vault's sources into another. Keeping the
 * registry out of the synced vault also keeps one machine's
 * filesystem paths off every replica.
 *
 * Standalone module (no import of config.ts), same as `profiles.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { isDir as isDirectory } from "../../fs-utils.ts";

export interface RecallSource {
  readonly alias: string;
  readonly vault: string;
}

export interface RecallSourceStatus extends RecallSource {
  /** True when the target vault directory no longer exists. */
  readonly broken: boolean;
}

interface SourcesFile {
  sources: Record<string, Record<string, { vault: string }>>;
}

/** Path of the recall-sources registry that accompanies a config file. */
export function recallSourcesPath(configPath: string): string {
  return join(dirname(configPath), "recall-sources.json");
}

function loadRegistry(
  configPath: string,
  opts: { tolerateParseError?: boolean } = {},
): SourcesFile {
  const path = recallSourcesPath(configPath);
  if (!existsSync(path)) return { sources: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SourcesFile>;
    const sources: SourcesFile["sources"] = {};
    if (raw.sources && typeof raw.sources === "object") {
      for (const [ownerVault, entries] of Object.entries(raw.sources)) {
        if (!entries || typeof entries !== "object") continue;
        const cleaned: Record<string, { vault: string }> = {};
        for (const [alias, entry] of Object.entries(entries)) {
          if (entry && typeof entry === "object" && typeof entry.vault === "string") {
            cleaned[alias] = { vault: entry.vault };
          }
        }
        sources[ownerVault] = cleaned;
      }
    }
    return { sources };
  } catch (exc) {
    // Read-only callers tolerate a malformed registry; mutating callers
    // must fail fast so a save() cannot truncate sources it could not
    // parse (same contract as profiles.ts).
    if (!opts.tolerateParseError) {
      throw new Error(`recall-sources registry is malformed: ${path}`, { cause: exc });
    }
    return { sources: {} };
  }
}

function saveRegistry(configPath: string, data: SourcesFile): void {
  const path = recallSourcesPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  // Stable key order at both levels for byte-identical writes.
  const ordered: SourcesFile = {
    sources: Object.fromEntries(
      Object.keys(data.sources)
        .toSorted()
        .map((ownerVault) => [
          ownerVault,
          Object.fromEntries(
            Object.keys(data.sources[ownerVault]!)
              .toSorted()
              .map((alias) => [alias, data.sources[ownerVault]![alias]!]),
          ),
        ]),
    ),
  };
  atomicWriteFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
}

/**
 * Attach an external vault as a read-only recall source of `ownerVault`.
 * Validation is concentrated here: alias shape and uniqueness, target
 * existence, self-links, duplicate paths, and direct circular links
 * (the target already sources the owner).
 */
export function addRecallSource(
  configPath: string,
  ownerVault: string,
  alias: string,
  vault: string,
): void {
  const trimmedAlias = alias.trim();
  if (trimmedAlias === "") throw new Error("source alias must not be empty");
  const owner = resolve(ownerVault);
  const target = resolve(vault);
  if (!isDirectory(target)) {
    throw new Error(`source vault does not exist: ${target}`);
  }
  if (target === owner) {
    throw new Error("a vault cannot be a recall source of itself");
  }
  const data = loadRegistry(configPath);
  const ownEntries = data.sources[owner] ?? {};
  if (trimmedAlias in ownEntries) {
    throw new Error(`source alias already registered: ${trimmedAlias}`);
  }
  for (const [existingAlias, entry] of Object.entries(ownEntries)) {
    if (resolve(entry.vault) === target) {
      throw new Error(`source vault already registered under alias '${existingAlias}'`);
    }
  }
  const reverse = data.sources[target] ?? {};
  for (const entry of Object.values(reverse)) {
    if (resolve(entry.vault) === owner) {
      throw new Error(`refusing a direct circular source: ${target} already sources ${owner}`);
    }
  }
  data.sources[owner] = { ...ownEntries, [trimmedAlias]: { vault: target } };
  saveRegistry(configPath, data);
}

/** Detach a recall source by alias. Returns false when absent. */
export function removeRecallSource(configPath: string, ownerVault: string, alias: string): boolean {
  const owner = resolve(ownerVault);
  const data = loadRegistry(configPath);
  const ownEntries = data.sources[owner];
  if (!ownEntries || !(alias in ownEntries)) return false;
  delete ownEntries[alias];
  if (Object.keys(ownEntries).length === 0) delete data.sources[owner];
  saveRegistry(configPath, data);
  return true;
}

/**
 * Every recall source of `ownerVault`, sorted by alias, with a broken
 * flag for targets that no longer exist (reported, never dropped - the
 * operator decides whether to remove or restore them).
 */
export function listRecallSources(
  configPath: string,
  ownerVault: string,
): ReadonlyArray<RecallSourceStatus> {
  const owner = resolve(ownerVault);
  const data = loadRegistry(configPath, { tolerateParseError: true });
  const ownEntries = data.sources[owner] ?? {};
  return Object.freeze(
    Object.keys(ownEntries)
      .toSorted()
      .map((alias) =>
        Object.freeze({
          alias,
          vault: ownEntries[alias]!.vault,
          broken: !isDirectory(ownEntries[alias]!.vault),
        }),
      ),
  );
}
