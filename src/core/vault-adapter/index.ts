/**
 * The vault adapter (design D14 item 8, task 2.10): the one module that
 * owns everything Obsidian-specific, active only when a vault is
 * configured.
 *
 * The brain itself lives in the store and needs no vault. What still
 * needs one is user-note territory:
 *
 *  - `.base` view files for user notes (`./bases.ts`); none queries
 *    store data.
 *  - Wikilink audits over vault pages (`./wikilink-audits.ts`).
 *  - The note tools: their vault requirement and their vault identity
 *    guard ({@link assertNoteVaultForWrite}). The store writes check the
 *    store identity instead (`../store/store-identity.ts`, D14 item 13).
 *
 * "Active" is decided here once: a non-empty vault path. Every surface
 * that needs the adapter asks {@link requireVaultAdapter} and gets the
 * same `vault_required` refusal when there is none, so a machine with no
 * vault refuses note work cleanly instead of failing somewhere deep.
 */

import { assertVaultIdentityForWrite, vaultMarkerAbsentNotice } from "../brain/vault-identity.ts";
import type { DegradationNotice } from "../integrity/degradation.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import { VAULT_ADAPTER_REQUIRED_CODE } from "./codes.ts";
import {
  assertVaultBindingForWrite,
  VaultBindingMismatchError,
  vaultBindingStatus,
} from "./vault-binding.ts";

export { VAULT_ADAPTER_REQUIRED_CODE } from "./codes.ts";

/** A vault-adapter feature was asked for on a machine with no vault. */
export class VaultAdapterRequiredError extends Error {
  readonly code = VAULT_ADAPTER_REQUIRED_CODE;
  constructor(readonly feature: string) {
    super(
      `${feature} needs a vault: it works on Obsidian notes, and no vault is configured. ` +
        "Run `o2b init --vault <path>` to use one; the brain itself works without it.",
    );
    this.name = "VaultAdapterRequiredError";
  }
}

/** Whether the vault adapter is active for `vault`: a vault is configured. */
export function vaultAdapterActive(vault: string | null | undefined): vault is string {
  return typeof vault === "string" && vault.trim() !== "";
}

/** The vault, or a {@link VaultAdapterRequiredError} naming `feature`. */
export function requireVaultAdapter(vault: string | null | undefined, feature: string): string {
  if (!vaultAdapterActive(vault)) throw new VaultAdapterRequiredError(feature);
  return vault;
}

/**
 * The note tools' write guard: a vault is required, and it must be the
 * vault this machine uses.
 *
 *  - The vault of an unswitched machine (one with a `Brain/` tree) keeps
 *    the vault identity guard: the `Brain/vault-id.json` marker pinned for
 *    this process, and the freeze marker on the content lane. A tree with
 *    no readable marker proves nothing about which vault it is, so such a
 *    vault is also compared against the binding; a binding file that
 *    cannot be read refuses nothing there (it is store-only state, and the
 *    marker notice already reports the missing marker), so an unswitched
 *    machine is never refused for a file it does not use.
 *  - The vault of a store-only machine (switched, its legacy tree kept or
 *    removed, or a vault with no tree) is compared against the vault bound
 *    to the store in the device-local state (`./vault-binding.ts`), and a
 *    swapped vault is refused. The freeze and migration gates of the
 *    identity guard still run; the absent marker is not reported, since a
 *    store-only vault needs none.
 */
export function assertNoteVaultForWrite(
  vault: string | null | undefined,
  feature: string,
  sink?: DegradationNotice[],
): string {
  const root = requireVaultAdapter(vault, feature);
  if (!storeOnlyMode({ vault: root }).storeOnly) {
    assertVaultIdentityForWrite(root, sink);
    if (vaultMarkerAbsentNotice(root) !== null) {
      const status = vaultBindingStatus(root);
      if (status.state === "mismatch") {
        throw new VaultBindingMismatchError(root, status.detail, status.reason);
      }
    }
    return root;
  }
  assertVaultIdentityForWrite(root);
  assertVaultBindingForWrite(root);
  return root;
}

export {
  BASE_TEMPLATES,
  BASES_TEMPLATE_DIR,
  basesFor,
  stampBaseTemplates,
  type BaseTemplate,
  type BaseStampResult,
} from "./bases.ts";
export { WIKILINK_AUDIT, type WikilinkAudit } from "./wikilink-audits.ts";
export {
  assertVaultBindingForWrite,
  bindVaultToStore,
  vaultBindingStatus,
  VAULT_BINDING_MISMATCH_CODE,
  VaultBindingMismatchError,
  VaultBindingsUnreadableError,
  type VaultBinding,
  type VaultBindingStatus,
} from "./vault-binding.ts";
