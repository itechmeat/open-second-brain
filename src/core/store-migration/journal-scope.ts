/**
 * The vault a migration journal row belongs to (design D11, step 5). The
 * same legacy item can exist in two vaults: vault A and vault B each hold
 * an identical first log row at the same relative path. A row keyed only
 * by path and checksum would let B's item count as imported from A, and
 * B's tree could be bound and removed while its item has no record. So
 * every new row, and the `migrated` mark of every record it names, carries
 * the identity of the vault it came from:
 *
 *   { vault_id, path_sum }
 *
 * `vault_id` is the vault's identity marker id (null without a marker),
 * `path_sum` the SHA-256 of its real path (a hash, so the store, which
 * syncs to every device, never holds a machine's folder names). Two
 * identities name the same vault by the rule a rollback uses
 * ({@link sameVault}): the marker decides when both carry one, otherwise
 * the paths do.
 *
 * Rows and marks written before the identity existed name no vault. They
 * belong to the first vault this machine migrated, the one its migration
 * backup names (or, before this machine took a backup, the vault the run
 * imports), and never to another vault:
 *
 *  - a mark without an identity whose record carries a `vault_id` came
 *    from the vault with that marker;
 *  - otherwise it, and every journal row on disk without one, came from
 *    that first vault.
 *
 * A path is a device's own: a mark whose identity is a path alone, or no
 * identity at all, is trusted only on the device that wrote it, and only
 * for the vault at that path. Another device's mark proves a vault only by
 * a marker id ({@link markVault}). So every migration gives its vault a
 * marker before it writes a mark (`migrate.ts`); only the transition on a
 * switched machine, which writes nothing into a vault's legacy tree
 * (design D14), still writes a path-only mark for a vault with no marker.
 */

import { sha256Hex } from "../integrity/digest.ts";
import { parseJournalVault, type JournalVault } from "./migration-records.ts";

export { parseJournalVault, type JournalVault };

/** What a run needs to tell its own vault's rows from another vault's. */
export interface JournalScope {
  /** The vault the run imports. */
  readonly vault: JournalVault;
  /** This machine's device id. */
  readonly device: string;
  /** The vault a row or a mark that names none came from. */
  readonly unscoped: JournalVault;
}

/** A vault by its marker id and its real path, as a migration backup records it. */
export interface VaultByPath {
  readonly vault_id: string | null;
  readonly path: string;
}

/**
 * Whether two vault identities name the same vault: the identity marker
 * decides when both carry one (a vault moved to another path is the same
 * vault); otherwise the paths do.
 */
export function sameVault(a: VaultByPath, b: VaultByPath): boolean {
  return a.vault_id !== null && b.vault_id !== null ? a.vault_id === b.vault_id : a.path === b.path;
}

function journalVaultOf(vault: VaultByPath): JournalVault {
  return { vault_id: vault.vault_id, path_sum: sha256Hex(vault.path) };
}

/**
 * The scope of a run that imports the vault `here` on `device`, where
 * `migrated` is the vault this machine's migration backup names (null
 * before it took one). Built by `backup.ts` `journalScopeFor`.
 */
export function journalScope(
  here: VaultByPath,
  migrated: VaultByPath | null,
  device: string,
): JournalScope {
  const vault = journalVaultOf(here);
  return { vault, device, unscoped: migrated === null ? vault : journalVaultOf(migrated) };
}

/** Whether two journal identities name the same vault. */
export function sameJournalVault(a: JournalVault, b: JournalVault): boolean {
  return sameVault(
    { vault_id: a.vault_id, path: a.path_sum },
    { vault_id: b.vault_id, path: b.path_sum },
  );
}

/**
 * A path sum that only the device that wrote a mark can trust. It never
 * equals a real path sum, so a path-only comparison with it fails.
 */
function elsewhere(device: string, pathSum: string): string {
  return `\u0000${device}\u0000${pathSum}`;
}

/**
 * The vault a `migrated` mark's record came from.
 *
 * On the device that wrote it: the mark's identity, else the record's
 * `vault_id`, else the scope's first vault. From another device only a
 * marker id proves a vault: the mark's, else the record's `vault_id`.
 * Its path is that device's own, so it never matches a path here, and a
 * mark with no marker id matches no vault at all (its item is imported
 * again here rather than merged with another vault's).
 */
export function markVault(
  scope: JournalScope,
  mark: JournalVault | null,
  record: { readonly device: string; readonly body: Readonly<Record<string, unknown>> },
): JournalVault {
  const body = record.body["vault_id"];
  const bodyId = mark === null && typeof body === "string" ? body : null;
  if (record.device === scope.device) {
    if (mark !== null) return mark;
    return bodyId !== null ? { vault_id: bodyId, path_sum: "" } : scope.unscoped;
  }
  return {
    vault_id: mark?.vault_id ?? bodyId,
    path_sum: elsewhere(record.device, mark?.path_sum ?? ""),
  };
}

/**
 * Whether a dual-written copy (a record with no `migrated` mark) came from
 * the vault the run imports, so it may stand in for one of its items. A
 * dual write stamps the vault's marker id as `vault_id` when the vault
 * has one: such a copy counts only for the vault with that marker. A copy
 * without one names no vault: it counts only on the device that wrote it,
 * and only for the vault that device migrated (`scope.unscoped`, the run's
 * own vault before this machine took a backup). Anything else is imported
 * again rather than merged with another vault's item.
 */
export function dualWriteFromVault(
  scope: JournalScope,
  record: { readonly device: string; readonly body: Readonly<Record<string, unknown>> },
): boolean {
  const id = record.body["vault_id"];
  if (typeof id === "string") return scope.vault.vault_id === id;
  return record.device === scope.device && sameJournalVault(scope.vault, scope.unscoped);
}

/**
 * Whether a dual-written copy (a record with no `migrated` mark) names a
 * vault other than the one the run works on: a dual write stamped another
 * vault's marker id as `vault_id`. Such a copy is never this vault's
 * occurrence of an item. A copy that names no vault proves nothing either
 * way; the caller decides (the import imports again,
 * {@link dualWriteFromVault}; the rollback keeps its content match).
 */
export function copyNamesOtherVault(
  scope: JournalScope,
  record: { readonly body: Readonly<Record<string, unknown>> },
): boolean {
  const id = record.body["vault_id"];
  return typeof id === "string" && scope.vault.vault_id !== id;
}

/** The vault a journal row on this machine's disk came from. */
export function rowVault(scope: JournalScope, row: JournalVault | null): JournalVault {
  return row ?? scope.unscoped;
}
