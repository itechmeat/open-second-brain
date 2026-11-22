/**
 * Vault resolution for the hooks (design D14 item 1, task 2.10).
 *
 * The vault is optional: a machine whose brain is the store runs with no
 * vault at all. Every hook resolves it here, once, and gets `null` both
 * when none is configured and when the machine config cannot be read, so
 * a hook never fails a host turn over vault resolution.
 *
 * A hook whose work needs vault pages returns quietly on `null`, exactly
 * as before, and its output does not change. A hook that audits without a
 * vault uses the store's device-local hook audit (`deviceHookAuditDir` in
 * `src/core/view/auto-render.ts`, as `view-render` does).
 *
 * {@link resolveHookVault} needs only the config reader. With no vault,
 * {@link resolveHookTarget} also asks whether this machine has a brain
 * store, the one extra read a store-side hook needs before its own work.
 */

import { resolveVault } from "../../src/core/config.ts";
import { noVaultRoot } from "../../src/core/platform-dirs.ts";
import { configuredStore } from "../../src/core/store/read/store-entities.ts";
import type { UnreachableVault } from "../../src/core/store/store-only.ts";
import { lookAtDirectory } from "../../src/core/vault-unexaminable.ts";

type StoreOnlyModule = typeof import("../../src/core/store/store-only.ts");

/**
 * The configured vault, or `null` when there is none, it cannot be
 * resolved, or this machine switched to the brain store and the vault
 * folder is gone or cannot be examined (`servedVault`): such a hook
 * serves the brain from the store, as with no vault.
 */
export function resolveHookVault(): string | null {
  return configuredHookVault().vault;
}

function configuredHookVault(): ServedHookVault {
  let vault: string | null;
  try {
    vault = resolveVault();
  } catch {
    return { vault: null, unreachable: null };
  }
  if (vault === null || vault.trim() === "") return { vault: null, unreachable: null };
  // The common case costs one look and loads nothing more: a hook runs on
  // every tool call, and the store-only module pulls in the lock modules.
  if (lookAtDirectory(vault) === "present") return { vault, unreachable: null };
  try {
    const storeOnly = require("../../src/core/store/store-only.ts") as StoreOnlyModule;
    const served = storeOnly.servedVault(vault);
    const missing = storeOnly.configuredVaultMissing(vault);
    return {
      vault: served.vault,
      unreachable: served.unreachable,
      ...(missing !== null ? { missing: { vault: missing.vault, notice: missing.notice } } : {}),
    };
  } catch {
    return { vault, unreachable: null };
  }
}

/** What the hook learned about the vault: where it is, and what is wrong with it. */
interface ServedHookVault {
  readonly vault: string | null;
  readonly unreachable: UnreachableVault | null;
  /** The configured vault's folder is not there, on a machine that has not switched. */
  readonly missing?: { readonly vault: string; readonly notice: string };
}

/** Where a hook does its work: a vault, or the brain store with none. */
export interface HookTarget {
  /**
   * The vault, or with none the no-vault stand-in path (`noVaultRoot`):
   * every store-only branch runs on it and no file is created under it.
   */
  readonly vault: string;
  /** Whether a vault is configured: the vault part of a hook runs only then. */
  readonly hasVault: boolean;
  /** Set when a switched machine's vault cannot be reached: what a hook could not read, and why. */
  readonly unreachable?: UnreachableVault;
  /**
   * Set when the configured vault's folder is not there, on a machine that
   * has NOT switched: the brain is not a fresh installation, and the hook
   * says so in its runtime notices.
   */
  readonly missing?: { readonly vault: string; readonly notice: string };
}

/**
 * The hook's target (design D14, task 2.10): the configured vault; with no
 * vault the brain store, when this machine has one, so the hook does the
 * store-side part of its job and skips the vault part; `null` when there is
 * neither, and the hook returns quietly. A switched machine whose vault
 * cannot be reached is served from the store, and the target names why.
 */
export function resolveHookTarget(): HookTarget | null {
  const { vault, unreachable, missing } = configuredHookVault();
  if (vault !== null) {
    return { vault, hasVault: true, ...(missing !== undefined ? { missing } : {}) };
  }
  try {
    if (configuredStore() === null) return null;
  } catch {
    return null;
  }
  return {
    vault: noVaultRoot(),
    hasVault: false,
    ...(unreachable !== null ? { unreachable } : {}),
  };
}
