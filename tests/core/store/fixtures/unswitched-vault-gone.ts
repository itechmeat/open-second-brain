/**
 * The fixture table of a machine that has NOT switched to the brain store,
 * whose configured vault folder is gone, and the machine beside it that
 * has no vault configured at all.
 *
 * Both shapes are the ones the product must tell apart:
 *
 *  - a vault configured, the folder gone: the brain is NOT a fresh
 *    installation, and every surface says so before it says "there is
 *    nothing here yet";
 *  - no vault configured: a genuinely new installation, which keeps
 *    today's guidance word for word.
 *
 * The table is shared by the MCP, the command line and the hook files, so
 * the three surfaces are pinned against the same fixtures.
 */
import { renameSync } from "node:fs";

import { makeStoreEnv, type StoreEnv } from "./store-env.ts";

/** One case of the table: whether this machine holds a brain store. */
export interface VaultShape {
  /** The case name, used in the test names. */
  readonly label: string;
  /** Whether the machine holds a brain store. */
  readonly withStore: boolean;
}

/** The two store shapes every surface is pinned against. */
export const STORE_SHAPES: ReadonlyArray<VaultShape> = Object.freeze([
  { label: "with a brain store", withStore: true },
  { label: "without a brain store", withStore: false },
]);

/**
 * A machine that has NOT switched, with a vault configured and a legacy
 * tree, whose vault folder is then renamed away: an unmounted disk.
 *
 * The renamed folder stays inside the fixture's own parent, so the
 * teardown removes it with the rest.
 */
export function unswitchedVaultGone(prefix: string, withStore: boolean): StoreEnv {
  const env = makeStoreEnv(prefix, withStore ? {} : { partitions: [] });
  renameSync(env.vault, `${env.vault}-away`);
  return env;
}

/**
 * A machine with no vault configured: the machine config names none, so
 * there is no folder that could be missing.
 */
export function noVaultConfigured(prefix: string, withStore: boolean): StoreEnv {
  return makeStoreEnv(prefix, {
    ...(withStore ? {} : { partitions: [] }),
    configureVault: false,
    legacyTree: false,
  });
}

/** The words the notice carries, checked at every surface. */
export const MISSING_VAULT_WORDS = [
  "is missing",
  "may be on a disk that is not mounted",
  "point the machine config at the vault",
  "before initialising a new brain",
] as const;
