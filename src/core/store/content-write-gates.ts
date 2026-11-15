/**
 * The content-write gate of a store-only write (design D14 item 13).
 *
 * On an unswitched machine every content writer passes the vault identity
 * guard (`../brain/vault-identity.ts`), which holds the freeze marker and
 * the migration gate before it checks the vault's identity marker. On a
 * store-only machine the store write checks the store identity in place of
 * the vault marker, and a migration gate left naming the vault is a
 * leftover of the migration that switched it, which refuses nothing. The
 * freeze still holds: its marker lives in the device-local state there
 * and freezes this machine. A writer that skips the vault guard on a
 * store-only machine calls {@link assertStoreContentWrite} instead. With
 * no vault, the freeze is read from the device-local state through the
 * no-vault root, so no vault is needed.
 */

import { assertVaultNotFrozen } from "../brain/freeze-marker.ts";
import { noVaultRoot } from "../platform-dirs.ts";

/** Refuse a store-only content write while this machine is frozen (`VaultFrozenError`). */
export function assertStoreContentWrite(vault: string | null): void {
  assertVaultNotFrozen(vault ?? noVaultRoot());
}
