/**
 * The one rule for "this vault keeps a legacy brain" (design D14 item 1,
 * D11): its `Brain/` folder holds a file a fresh bootstrap does not write.
 * A tree of only what bootstrap writes (its settings, the manual, the
 * identity marker, the Bases views, empty lane folders) and the metadata
 * files an operating system drops into folders is a fresh install: there
 * is nothing to migrate, and the machine is store-only.
 *
 * A leaf, so the fresh-install switch (`fresh-switch.ts`, run by `o2b
 * init` and `o2b store init`), `o2b init`'s store step and the migration
 * availability (status block and doctor) answer from the same rule.
 *
 * The write routing (`store-only.ts`) still reads an unswitched machine
 * with any `Brain/` folder as legacy: a bootstrapped vault becomes
 * store-only through its recorded switch, not by its folder's contents,
 * so a vault bootstrapped without a store keeps working as before.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import {
  BRAIN_BASES_REL,
  BRAIN_CONFIG_FILE,
  BRAIN_MANUAL_FILE,
  BRAIN_ROOT_REL,
} from "../brain/path-constants.ts";
import { VAULT_IDENTITY_FILE } from "../brain/vault-identity.ts";

const BASES_DIR_NAME = BRAIN_BASES_REL.slice(BRAIN_ROOT_REL.length + 1);

/** Files a fresh bootstrap writes at the root of `Brain/`, which hold no memory. */
const BOOTSTRAP_ROOT_FILES: ReadonlySet<string> = new Set([
  BRAIN_CONFIG_FILE,
  BRAIN_MANUAL_FILE,
  VAULT_IDENTITY_FILE,
]);

/**
 * Metadata files an operating system or a tool drops into any folder
 * (Finder, Explorer, empty-folder keepers). They hold no brain data; a
 * sync-conflict copy is not one of them.
 */
export const OS_METADATA_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitkeep",
]);

/**
 * Whether `brainRoot` holds a file a bootstrap does not write. Stops at
 * the first such file, so the probe is cheap on a real brain. A folder
 * that cannot be listed counts as holding data: a tree that cannot be
 * judged is never taken for a fresh one.
 */
export function holdsLegacyData(brainRoot: string): boolean {
  const walk = (dir: string, top: boolean): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (top && entry.name === BASES_DIR_NAME) continue;
        if (walk(join(dir, entry.name), false)) return true;
      } else if (OS_METADATA_NAMES.has(entry.name)) {
        continue;
      } else if (!(top && BOOTSTRAP_ROOT_FILES.has(entry.name))) {
        return true;
      }
    }
    return false;
  };
  return walk(brainRoot, true);
}

/** Whether `vault` keeps a legacy brain: a `Brain/` that holds legacy data. */
export function holdsLegacyBrain(vault: string | null): boolean {
  if (vault === null || vault.trim() === "") return false;
  return holdsLegacyData(join(vault, BRAIN_ROOT_REL));
}
