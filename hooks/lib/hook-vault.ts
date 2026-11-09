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

/** The configured vault, or `null` when there is none or it cannot be resolved. */
export function resolveHookVault(): string | null {
  try {
    const vault = resolveVault();
    return vault === null || vault.trim() === "" ? null : vault;
  } catch {
    return null;
  }
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
}

/**
 * The hook's target (design D14, task 2.10): the configured vault; with no
 * vault the brain store, when this machine has one, so the hook does the
 * store-side part of its job and skips the vault part; `null` when there is
 * neither, and the hook returns quietly.
 */
export function resolveHookTarget(): HookTarget | null {
  const vault = resolveHookVault();
  if (vault !== null) return { vault, hasVault: true };
  try {
    if (configuredStore() === null) return null;
  } catch {
    return null;
  }
  return { vault: noVaultRoot(), hasVault: false };
}
