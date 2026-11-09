/**
 * Moving this machine's device-local surfaces into its device-local state
 * (design D11 "Later machines", D14 item 6): every surface the map sends
 * to `device-local` or `backup` is copied, file by file and verified by
 * hash, into `<device state>/migration/local/<vault-relative path>`, where
 * the store-only mode reads it. A backup-class surface (secrets, signing
 * keys, checkpoints, lockfiles) lives there after the switch as well as in
 * the verified backup. A rebuildable surface (the search index and the
 * caches) is not copied: the switched machine rebuilds it in its own place. The originals stay in the legacy tree, which
 * leaves the vault only through the removal step (task 2.5) and is
 * archived then, never deleted.
 */

import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { CatalogueEntry } from "./catalogue.ts";
import { DESTINATION_KIND } from "./destinations.ts";
import { MIGRATION_LOCAL_DIR as LOCAL_DIR } from "./device-state-layout.ts";
import { copyOwnerOnly, ensureOwnerOnlyRoot } from "./owner-only-copy.ts";
import { realpathInsideVault } from "../path-safety.ts";
import { SWITCHED_SKILLS_DIR } from "../surface/skills-dir.ts";

function filesBelow(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path)
    .toSorted()
    .flatMap((name) => filesBelow(join(path, name)));
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** A copy that did not verify. */
export class LocalStateMoveError extends Error {
  override readonly name = "LocalStateMoveError";
}

/**
 * Copy every device-local and backup-class surface of `vault`, except the
 * rebuildable ones, into `migrationDir/local`.
 * Returns the vault-relative paths copied; throws {@link LocalStateMoveError}
 * when a copy does not match its original.
 */
export function moveDeviceLocalState(
  vault: string,
  catalogue: ReadonlyArray<CatalogueEntry>,
  migrationDir: string,
): string[] {
  const copied: string[] = [];
  const root = join(migrationDir, LOCAL_DIR);
  let rootReady = false;
  for (const entry of catalogue) {
    const to = entry.mapping.destination.to;
    if (to !== DESTINATION_KIND.deviceLocal && to !== DESTINATION_KIND.backup) continue;
    if (entry.mapping.rebuildable === true) continue;
    for (const locator of entry.locators) {
      if (locator.shape !== "tree") continue;
      // A device-local locator with a grammar names rows, not files to copy;
      // a backup-class one is copied whole, as the backup copies it.
      if (to === DESTINATION_KIND.deviceLocal && locator.grammar !== undefined) continue;
      for (const file of filesBelow(locator.path)) {
        const rel = relative(vault, file).split(sep).join("/");
        const target = join(root, ...rel.split("/"));
        // Secrets and signing keys among them: owner-only whatever mode
        // the source had (`owner-only-copy.ts`).
        if (!rootReady) ensureOwnerOnlyRoot(root);
        rootReady = true;
        copyOwnerOnly(file, target, root);
        if (sha256(target) !== sha256(file)) {
          throw new LocalStateMoveError(`the device-local copy of ${rel} does not match it`);
        }
        copied.push(rel);
      }
    }
  }
  return copied;
}

/** What {@link placeVaultFiles} did with each legacy file. */
export interface VaultFilesPlacement {
  /** Vault-relative paths written to their switched location. */
  readonly placed: ReadonlyArray<string>;
  /** Vault-relative paths left alone: the switched location already held a different file. */
  readonly kept: ReadonlyArray<string>;
}

/** Whether `target` or a folder between `vault` and it is a symbolic link (or junction). */
function linkBelowVault(target: string, vault: string): boolean {
  const root = resolve(vault);
  for (let path = resolve(target); path !== root; path = dirname(path)) {
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch {
      // Not there yet: nothing to follow.
    }
    if (dirname(path) === path) return false;
  }
  return false;
}

/**
 * Copy every surface the map sends to `vault-files` (accepted skills) from
 * the legacy tree to its place in the user's vault, outside `Brain/`:
 * `Brain/skills/<rest>` lands at `<vault>/skills/<rest>`, verified by hash.
 * A file already there with the same bytes counts as placed; one with
 * different bytes is kept as the user's and named. The originals stay in
 * the legacy tree, which leaves the vault only through the removal step.
 */
export function placeVaultFiles(
  vault: string,
  catalogue: ReadonlyArray<CatalogueEntry>,
): VaultFilesPlacement {
  const placed: string[] = [];
  const kept: string[] = [];
  for (const entry of catalogue) {
    if (entry.mapping.destination.to !== DESTINATION_KIND.vaultFiles) continue;
    for (const locator of entry.locators) {
      if (locator.shape !== "tree") continue;
      for (const file of filesBelow(locator.path)) {
        const inLane = relative(locator.path, file);
        const target = join(vault, SWITCHED_SKILLS_DIR, inLane);
        const rel = relative(vault, file).split(sep).join("/");
        let present = false;
        try {
          present = lstatSync(target).isFile();
        } catch {
          present = false;
        }
        if (present) {
          (sha256(target) === sha256(file) ? placed : kept).push(rel);
          continue;
        }
        // Vault content syncs, so a link planted at `skills/` or below it
        // must not carry these writes out of the vault. A dangling link
        // slips past the real-path walk (it "does not exist"), so every
        // entry between the vault and the target is checked for a link too.
        if (linkBelowVault(target, vault) || !realpathInsideVault(target, vault)) {
          throw new LocalStateMoveError(
            `the vault place of ${rel} leads out of the vault by a link`,
          );
        }
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(file, target);
        if (sha256(target) !== sha256(file)) {
          throw new LocalStateMoveError(`the vault copy of ${rel} does not match it`);
        }
        placed.push(rel);
      }
    }
  }
  return { placed, kept };
}
