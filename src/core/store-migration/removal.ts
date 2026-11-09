/**
 * Removing the legacy tree from the vault (task 2.5, design D11a): once
 * every device of the migration cohort has switched to the store or been
 * retired, the legacy tree leaves the vault. It is moved, never deleted,
 * into a dated archive in this machine's device-local state, together
 * with the device-local originals the migration copied but left in place
 * (the derived store folder beside `Brain/`).
 *
 *  - The gate is the cohort, with no age limit: a device that has been
 *    offline for months keeps the tree in place, because removing it would
 *    leave that device writing into a tree no store imports any more.
 *  - `--force` removes the tree anyway and names the devices that will
 *    stop reaching the store.
 *  - A `settings` shard of `shared` that cannot be read refuses the
 *    removal; one read only in part (a pending blob, a bad line in the
 *    middle) refuses it unless `--force`: either may hide a cohort record.
 *  - Any other held shard (but `digests`) follows the same rule: the
 *    journal may count an item as imported whose record sits in it, and
 *    the tree would be that record's only readable copy.
 *  - The transition import runs first, so late legacy writes reach the
 *    store before the files move.
 *  - A `legacy-tree-removed` record in `shared`, and a device-local marker,
 *    let the doctor report a legacy directory that comes back.
 *
 * A move falls back to copy, verify and remove when the archive is on
 * another filesystem, and rides out a transient Windows sharing refusal.
 *
 * The removal holds this machine's migration gate, so no content writer
 * here writes into the tree while it moves. After the moves it imports
 * once more from the archive itself, so a file sync delivered between the
 * first import and the moves still reaches the store. A first import that
 * did not converge (the tree kept changing past the pass limit) stops the
 * removal before anything moves.
 *
 * Nothing is removed while an item is held back for a store partition
 * this machine does not hold (a private page on a machine with only
 * `shared`), the rule that keeps a vault unbound in the transition. Not
 * even `--force` overrides it: once the tree has left the vault a
 * rollback is refused, so the archive in this machine's device-local
 * state would be the item's only copy. An item the import from the
 * archive holds back puts the moved roots back into the vault.
 *
 * A removal is journaled in device-local state (`removal.json`, naming its
 * archive) before the first root moves and cleared once its record and
 * marker are written, so a removal interrupted part way is finished by the
 * next run into the same archive, and a rollback refuses until then.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { atomicWriteFileSync, renameWithRetry } from "../fs-atomic.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import { appendRecord } from "../store/appender.ts";
import { AUTHORITY_FIELD, STORE_PARTITIONS, type StorePartition } from "../store/constants.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { legacyRootNames, migrationCatalogue } from "./catalogue.ts";
import { describeUnseen, migrationDir, unseenHeldShards } from "./journal.ts";
import { claims } from "./legacy-claims.ts";
import { holdGateFor, releaseGateFor } from "./quiesce.ts";
import { sameVaultPath, writeRemovalMarker } from "./removal-marker.ts";
import {
  isDeviceSwitched,
  unseenSettingsShards,
  LEGACY_TREE_REMOVED_KIND,
  MIGRATION_STREAM,
} from "./migration-records.ts";
import type { ConvertHooks } from "./convert.ts";
import { GATED_IMPORT_WAIT_MS, importLateLegacyWrites } from "./transition.ts";

/** Where archives of removed legacy trees go, inside the device-local state. */
export const LEGACY_ARCHIVE_DIR = "legacy-archive";

export type RemovalResult =
  | {
      readonly removed: false;
      readonly reason: "not-switched" | "cohort-pending" | "no-legacy-tree";
      /** Devices still on the legacy layout. */
      readonly pending: ReadonlyArray<string>;
    }
  | {
      readonly removed: false;
      readonly reason: "held-back";
      /** Devices still on the legacy layout. */
      readonly pending: ReadonlyArray<string>;
      /** Legacy items the store cannot take on this machine. */
      readonly held_back: number;
      /** The store partitions this machine does not hold. */
      readonly missing: ReadonlyArray<StorePartition>;
    }
  | {
      readonly removed: true;
      readonly archive: string;
      readonly moved: ReadonlyArray<string>;
      /** Vault-relative files left out of the archive: the index, caches, generated pages. */
      readonly skipped: ReadonlyArray<string>;
      readonly forced: boolean;
      /** Devices still on the legacy layout that a forced removal leaves behind. */
      readonly stopped: ReadonlyArray<string>;
      readonly imported: number;
    };

function digestTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(
        `${relative(root, path).split(sep).join("/")}\u0000${stat.isDirectory() ? "d" : stat.size}\n`,
      );
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

/**
 * Take out of the archive every file a rebuildable mapping reads (the
 * search index and its journal files, caches, generated pages): the index
 * or a rebuild recreates them, so the archive keeps only what cannot be
 * recreated. Returns their vault-relative paths.
 */
function dropRebuildable(
  vault: string,
  archive: string,
  catalogue: ReturnType<typeof migrationCatalogue>,
): string[] {
  const locators = catalogue
    .filter((e) => e.mapping.rebuildable === true)
    .flatMap((e) => e.locators);
  const skipped: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      const rel = relative(archive, path).split(sep).join("/");
      const asInVault = join(vault, ...rel.split("/"));
      const stat = lstatSync(path);
      const claimed = locators.some((l) => claims(l, asInVault, name));
      if (claimed) {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        skipped.push(rel);
      } else if (stat.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(archive);
  return skipped;
}

/** Move `from` to `to`; across filesystems, copy, verify and remove. */
function moveTree(from: string, to: string): void {
  try {
    renameWithRetry(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (digestTree(from) !== digestTree(to)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(`the archive copy of ${from} does not match it; nothing was removed`);
  }
  rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const REMOVAL_JOURNAL = "removal.json";

/** The refusal for items held back for a partition this machine lacks. */
function heldBackRefusal(
  store: StoreHandle,
  heldBack: number,
  pending: ReadonlyArray<string>,
): RemovalResult {
  return {
    removed: false,
    reason: "held-back",
    pending,
    held_back: heldBack,
    missing: STORE_PARTITIONS.filter((p) => !store.partitions.has(p)),
  };
}

/**
 * Undo the moves of a removal that may not finish: every root in the
 * archive goes back into the vault, and the removal journal is cleared.
 * A root the vault holds again (sync recreated it) cannot go back; then
 * the journal stays, so the archive is named and a rollback still refuses.
 */
function putBack(vault: string, archive: string, journal: string): void {
  const blocked: string[] = [];
  for (const top of readdirSync(archive).toSorted()) {
    if (existsSync(join(vault, top))) blocked.push(top);
    else moveTree(join(archive, top), join(vault, top));
  }
  if (blocked.length > 0) {
    throw new Error(
      `the legacy tree could not be put back from ${archive}: the vault holds ` +
        `${blocked.join(", ")} again; move them back by hand, then run the removal again`,
    );
  }
  rmSync(journal, { force: true });
  rmSync(archive, { recursive: true, force: true });
}

/** Prefix of the migration gate run id a removal holds. */
const REMOVAL_RUN_PREFIX = "remove-legacy-";

/** A removal that moved part of the tree and has not recorded itself yet. */
export interface RemovalInProgress {
  readonly vault: string;
  readonly at: string;
  readonly archive: string;
}

/** The removal of a legacy tree this machine began and did not finish, or null. */
export function readRemovalInProgress(store: StoreHandle): RemovalInProgress | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(migrationDir(store), REMOVAL_JOURNAL), "utf8"),
    ) as Partial<RemovalInProgress>;
    if (
      typeof parsed.vault === "string" &&
      typeof parsed.at === "string" &&
      typeof parsed.archive === "string"
    ) {
      return { vault: parsed.vault, at: parsed.at, archive: parsed.archive };
    }
  } catch {
    // none
  }
  return null;
}

export interface RemovalOptions {
  readonly force?: boolean;
  readonly agent: string;
  readonly now?: Date;
  /** Convert hooks of the final import from the archive (crash and race tests). */
  readonly archiveImportHooks?: ConvertHooks;
}

/** Remove the legacy tree of `vault` into the device-local archive, when the cohort allows. */
export function removeLegacyTree(
  vault: string,
  store: StoreHandle,
  options: RemovalOptions,
): RemovalResult {
  if (!isDeviceSwitched(store, store.device)) {
    return { removed: false, reason: "not-switched", pending: [] };
  }
  // The cohort and the peers' switches are read from the `settings`
  // shards; one that cannot be read, or is read only in part, could hide a
  // device still on the legacy layout, and the gate would open over it.
  const unseen = unseenSettingsShards(store);
  if (unseen.unreadable.length > 0) {
    throw new Error(
      `${unseen.unreadable.length} settings shard(s) of the brain store cannot be read ` +
        `(${unseen.unreadable.slice(0, 5).join(", ")}); nothing was moved. Let sync finish or fix ` +
        "their permissions, then run the removal again",
    );
  }
  // A bad line in the middle of a shard may never read again, so `--force`
  // goes past it, as it goes past a cohort device still on the legacy layout.
  if (unseen.partial.length > 0 && options.force !== true) {
    throw new Error(
      `${unseen.partial.length} settings shard(s) of the brain store cannot be read in full ` +
        `(${unseen.partial.slice(0, 5).join(", ")}): a record in one may name a device still ` +
        "on the legacy layout; nothing was moved. Let sync deliver the missing blobs and run " +
        "the removal again, or remove the tree anyway with --force",
    );
  }
  // Every other held shard: the journal can count an item as imported
  // whose record sits in a shard this machine cannot see, and the tree
  // would be its only readable copy. A shard that cannot be read at all,
  // or is gone since this machine read it, refuses even with `--force`; one
  // read only in part (a bad line may never read again) refuses without it.
  const data = unseenHeldShards(store);
  if (data.unreadable.length > 0) {
    throw new Error(
      `${describeUnseen({ unreadable: data.unreadable, partial: [] })}: a record the legacy ` +
        "tree is the only other copy of may be in one; nothing was moved. Let sync finish or " +
        "fix their permissions, then run the removal again",
    );
  }
  if (data.partial.length > 0 && options.force !== true) {
    throw new Error(
      `${describeUnseen({ unreadable: [], partial: data.partial })}: a record the legacy tree ` +
        "is the only other copy of may be in one; nothing was moved. Let sync deliver the " +
        "missing blobs and run the removal again, or remove the tree anyway with --force",
    );
  }
  const runId = `${REMOVAL_RUN_PREFIX}${(options.now ?? new Date()).toISOString()}`;
  // An interrupted migration or rollback's gate keeps its writers stopped
  // until that run resumes; only an earlier removal's gate is taken over.
  // The gate is held before the journal and the tree are read: a second
  // removal on this machine is refused while the first runs, and one that
  // comes after it sees what the first left, never a stale list of roots.
  holdGateFor(vault, runId, { takeOver: (held) => held.startsWith(REMOVAL_RUN_PREFIX) });
  try {
    const catalogue = migrationCatalogue(vault);
    const roots = legacyRootNames(vault, catalogue).filter((top) => existsSync(join(vault, top)));
    const resumed = readRemovalInProgress(store);
    // One removal journal per machine: another vault's unfinished removal
    // would lose its journal (and its resumable archive) to this one.
    if (resumed !== null && !sameVaultPath(resumed.vault, vault)) {
      throw new Error(
        `an interrupted removal of the legacy tree of ${resumed.vault} is unfinished on this ` +
          "machine; nothing was moved. Finish that removal first",
      );
    }
    if (roots.length === 0 && resumed === null) {
      return { removed: false, reason: "no-legacy-tree", pending: [] };
    }
    return removeUnderGate(vault, store, options, { catalogue, roots, resumed });
  } finally {
    releaseGateFor(vault, runId);
  }
}

function removeUnderGate(
  vault: string,
  store: StoreHandle,
  options: RemovalOptions,
  plan: {
    readonly catalogue: ReturnType<typeof migrationCatalogue>;
    readonly roots: ReadonlyArray<string>;
    readonly resumed: RemovalInProgress | null;
  },
): RemovalResult {
  const { catalogue, roots, resumed } = plan;
  const vaultId = readVaultIdentity(vault)?.vault_id ?? null;
  const transition = importLateLegacyWrites(vault, store, options.agent, vaultId, {
    waitMs: GATED_IMPORT_WAIT_MS,
  });
  const pending = transition.legacy_devices;
  const forced = options.force === true;
  // A resumed removal already moved part of the tree: it finishes.
  if (resumed === null && pending.length > 0 && !forced) {
    return { removed: false, reason: "cohort-pending", pending };
  }
  if (!transition.converged) {
    throw new Error(
      `the legacy tree kept changing through ${transition.passes} import passes; nothing was ` +
        "moved. Run the removal again once the machines on the old release are quiet",
    );
  }
  const journal = join(migrationDir(store), REMOVAL_JOURNAL);
  // Held back: the item is in no store this machine writes, and the tree
  // would be its only copy. A resumed removal puts back what it moved.
  if (transition.held_back > 0) {
    if (resumed !== null) putBack(vault, resumed.archive, journal);
    return heldBackRefusal(store, transition.held_back, pending);
  }

  const at = resumed?.at ?? (options.now ?? new Date()).toISOString();
  const archive =
    resumed?.archive ?? join(store.deviceStateDir, LEGACY_ARCHIVE_DIR, at.replace(/[:.]/g, "-"));
  mkdirSync(archive, { recursive: true });
  if (resumed === null) {
    mkdirSync(migrationDir(store), { recursive: true });
    const entry: RemovalInProgress = { vault: resolve(vault), at, archive };
    atomicWriteFileSync(journal, `${JSON.stringify(entry)}\n`);
  }
  for (const top of roots) moveTree(join(vault, top), join(archive, top));
  // Every root in the archive, a resumed run's earlier moves included.
  const moved = readdirSync(archive).toSorted();
  // What sync delivered between the import above and the moves is in the
  // archive now; the journal skips everything already imported.
  const final = importLateLegacyWrites(archive, store, options.agent, vaultId, {
    waitMs: GATED_IMPORT_WAIT_MS,
    // The archive holds the vault's items: they are journaled as the vault's.
    identityOf: vault,
    ...(options.archiveImportHooks !== undefined ? { hooks: options.archiveImportHooks } : {}),
  });
  if (final.held_back > 0) {
    putBack(vault, archive, journal);
    return heldBackRefusal(store, final.held_back, pending);
  }
  // A legacy writer that opened a file before the move keeps appending to
  // it in the archive (POSIX moves an open file with its handle). Recording
  // the removal now would leave what it wrote after the last pass only in
  // this machine's archive: the tree goes back, and the next run retries.
  if (!final.converged) {
    putBack(vault, archive, journal);
    throw new Error(
      `the moved legacy tree kept changing through ${final.passes} import passes; it was put ` +
        "back. Run the removal again once the machines on the old release are quiet",
    );
  }
  const skipped = dropRebuildable(vault, archive, catalogue);
  appendRecord(store, {
    partition: "shared",
    stream: MIGRATION_STREAM,
    kind: LEGACY_TREE_REMOVED_KIND,
    agent: options.agent,
    body: {
      [AUTHORITY_FIELD]: "human",
      vault_id: vaultId,
      device: store.device,
      forced,
      stopped: [...pending],
    },
  });
  writeRemovalMarker(store, { vault: resolve(vault), at, archive, forced, stopped: pending });
  rmSync(journal, { force: true });
  return {
    removed: true,
    archive,
    moved,
    skipped,
    forced,
    stopped: pending,
    imported: transition.imported + final.imported,
  };
}
