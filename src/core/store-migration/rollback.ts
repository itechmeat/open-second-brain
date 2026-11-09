/**
 * `o2b brain migrate-store --rollback` (task 2.6, design D11 "Rollback"):
 * take this machine back to the legacy layout, until the legacy tree
 * leaves the vault.
 *
 *  1. Hold the device-local migration gate, so no content writer on this
 *     machine writes while the tree is rebuilt.
 *  2. Import the late legacy writes (design D11a: what a machine on the
 *     old release wrote into this tree since the last transition import),
 *     then restore `Brain/` from the migration snapshot (the copy kept in the
 *     backup when the archive is gone from `.snapshots/`), then every
 *     backed-up surface. The restore loses nothing the import could not
 *     take: an import that did not settle, or that held items back for a
 *     partition this machine does not hold, refuses the rollback; when it
 *     left unparseable items, the tree is first copied aside into the
 *     device-local migration folder and the copy is named in the report.
 *  3. Replay, in fold order, every store record whose identity is absent
 *     from the restored tree, through the legacy exporters
 *     (`exporters.ts`). An imported record is present when the restored
 *     tree holds its item with the same checksum; any other record is
 *     present when a restored item builds a record of the same kind and
 *     body (the multiset match the migration uses for dual-written
 *     copies). Both matches are per vault, as the migration journal's: a
 *     record another vault's import marked, or a dual write stamped with
 *     another vault's marker, is that vault's own occurrence and is
 *     written back beside this vault's. That covers records written after
 *     the switch and remote records that arrived late, from every device.
 *     Kinds with no legacy form stay in the store and are counted in the
 *     report.
 *  4. Record `device-unswitched` for this device (`isDeviceSwitched` then
 *     answers false), clear the sticky store-only marker for this device,
 *     and mark the migration rolled back.
 *
 * The run is journaled per replayed record in the device-local state (a
 * start line before each write, the id after it), so a resumed rollback
 * skips the restore it already did and every record it already replayed.
 *
 * Refused: once the legacy tree left the vault (this machine's removal
 * marker, or any device's `legacy-tree-removed` record for the vault),
 * for a vault the migration backup was not taken of (a vault configured
 * after the switch, imported by the transition, has none: its legacy tree
 * was never changed), and on a device that is not switched unless an unfinished rollback is
 * resumed, so a finished rollback run again never restores the old
 * snapshot over the legacy writes made since. Refused too, with the
 * shards named and the switch kept, while any held store shard cannot be
 * read in full (unreadable, gone since this machine read it, or read only
 * in part): a record in one would never be written back once the switch
 * is cleared. That is checked before anything is touched, and again over
 * the records the replay uses, before the restore.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { BRAIN_ROOT_REL, BRAIN_SNAPSHOT_EXCLUDED_ENTRIES } from "../brain/path-constants.ts";
import { snapshotPath } from "../brain/paths.ts";
import { extractSnapshotToTemp } from "../brain/snapshot.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import { appendRecord } from "../store/appender.ts";
import { AUTHORITY_FIELD, LEDGER_ROW_KIND } from "../store/constants.ts";
import { readPartition } from "../store/state-digest.ts";
import { partitionDir } from "../store/store-paths.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { clearSwitchMarker, deviceSwitchedHere } from "../store/store-only.ts";
import { unbindVaultFromStore } from "../vault-adapter/vault-binding.ts";
import type { StoreHandle } from "../store/store-open.ts";
import {
  backupVaultMismatch,
  journalScopeFor,
  readMigrationBackup,
  restoreMigrationBackups,
  snapshotCopyIn,
} from "./backup.ts";
import { removeDeviceTokens } from "./device-config.ts";
import { itemRecords, migrationCatalogue, recordDestination } from "./catalogue.ts";
import { contentKey, itemKey, itemSum } from "./convert.ts";
import { EXPORTED_KINDS, exportRecords, type RefusedRecord, type StartMark } from "./exporters.ts";
import {
  describeUnseen,
  migrationDir,
  readHeldRecords,
  readMigrationState,
  unseenHeldShards,
  writeMigrationState,
  type UnseenShards,
} from "./journal.ts";
import {
  copyNamesOtherVault,
  markVault,
  sameJournalVault,
  type JournalScope,
} from "./journal-scope.ts";
import { emptyTally, scanLocator } from "./legacy-scan.ts";
import {
  DEVICE_UNSWITCHED_KIND,
  legacyTreeRemovedRecords,
  MIGRATION_STREAM,
  migratedMark,
} from "./migration-records.ts";
import { holdGateFor, releaseGateFor } from "./quiesce.ts";
import { readRemovalInProgress } from "./removal.ts";
import { readRemovalMarker, sameVaultPath } from "./removal-marker.ts";
import {
  GATED_IMPORT_WAIT_MS,
  importLateLegacyWrites,
  type TransitionResult,
} from "./transition.ts";

const ROLLBACK_STATE = "rollback.json";
const ROLLBACK_JOURNAL = "rollback-journal.jsonl";
/** Where a rollback copies a legacy tree holding late items it could not import. */
const ROLLBACK_KEPT_DIR = "rollback-kept";

/**
 * Fault-injection point; the CLI never sets it. It stays because the crash
 * test must kill a rollback between two replayed records (the kill-child
 * test SIGKILLs itself here), which a kill from outside cannot time.
 */
export interface RollbackHooks {
  readonly afterReplayed?: (count: number) => void;
}

export interface RollbackResult {
  readonly device: string;
  readonly restored_files: number;
  readonly restored_backups: number;
  /** Ids of the records written back this run, in fold order. */
  readonly replayed: ReadonlyArray<string>;
  /** Records left in the store because their kind has no legacy form, by kind. */
  readonly no_legacy_form: Readonly<Record<string, number>>;
  /**
   * Ledger rows written after the switch (or arrived late) that stay in the
   * store only, by ledger: the legacy ledgers do not get them back, so the
   * old release does not see them (idempotency receipts, continuity,
   * truth claims). Reported as a warning.
   */
  readonly ledger_rows_kept: Readonly<Record<string, number>>;
  /**
   * Records not written back because a path they name leaves `Brain/` (or
   * a log timestamp is no date, a preference id no slug), with the reason:
   * a synced peer can write any body (`exporters.ts`).
   */
  readonly refused: ReadonlyArray<RefusedRecord>;
  readonly unswitched: string;
  /**
   * The device-config MCP token map the migration copied, set aside
   * because it changed since (null when it was removed or there was none):
   * the per-vault file is the token map again.
   */
  readonly device_tokens_aside: string | null;
  /**
   * Where the legacy tree was copied before the restore because the late
   * import left items it could not read (null when it left none): those
   * items are in neither the store nor the snapshot.
   */
  readonly legacy_tree_kept: string | null;
}

/** A rollback that cannot run, with the reason. */
export class RollbackRefusedError extends Error {
  override readonly name = "RollbackRefusedError";
}

interface RollbackState {
  readonly restored: boolean;
  readonly restored_files: number;
  readonly restored_backups: number;
}

function readState(dir: string): RollbackState | null {
  try {
    return JSON.parse(readFileSync(join(dir, ROLLBACK_STATE), "utf8")) as RollbackState;
  } catch {
    return null;
  }
}

/** The journal line a record gets before its write; its id alone follows the write. */
const STARTED_PREFIX = "start ";
/** The tail a start line names for a shard that had no chained row yet. */
const NO_TAIL = "-";

/** The records an earlier run wrote back, and those it began without finishing. */
function replayJournal(dir: string): { done: Set<string>; started: Map<string, StartMark> } {
  let lines: string[] = [];
  try {
    lines = readFileSync(join(dir, ROLLBACK_JOURNAL), "utf8").split("\n").filter(Boolean);
  } catch {
    // no journal: a fresh run
  }
  const done = new Set(lines.filter((l) => !l.startsWith(STARTED_PREFIX)));
  const started = new Map<string, StartMark>();
  for (const line of lines) {
    if (!line.startsWith(STARTED_PREFIX)) continue;
    // `start <id> <tail hash, or - for an empty shard>`; an older line has no tail.
    const [id, tail] = line.slice(STARTED_PREFIX.length).split(" ");
    if (id === undefined || done.has(id)) continue;
    started.set(id, tail === undefined ? {} : { tail: tail === NO_TAIL ? null : tail });
  }
  return { done, started };
}

/** Replace `Brain/` (minus the snapshot folders) with the snapshot's tree. */
function restoreBrain(vault: string, runId: string, archiveCopy: string | null): number {
  const archive = snapshotPath(vault, runId);
  if (!existsSync(archive)) {
    if (archiveCopy === null)
      throw new RollbackRefusedError(`the migration snapshot ${runId} is gone`);
    mkdirSync(join(archive, ".."), { recursive: true });
    cpSync(archiveCopy, archive);
  }
  const extracted = extractSnapshotToTemp(vault, runId);
  try {
    const brain = join(vault, BRAIN_ROOT_REL);
    for (const name of readdirSync(brain)) {
      if (BRAIN_SNAPSHOT_EXCLUDED_ENTRIES.includes(name)) continue;
      rmSync(join(brain, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    let files = 0;
    for (const name of readdirSync(extracted.brainRoot)) {
      if (BRAIN_SNAPSHOT_EXCLUDED_ENTRIES.includes(name)) continue;
      cpSync(join(extracted.brainRoot, name), join(brain, name), { recursive: true });
      files += 1;
    }
    return files;
  } finally {
    extracted.cleanup();
  }
}

/** What the restored tree already holds: item keys with checksums, and record contents. */
function restoredIdentity(vault: string): { items: Set<string>; contents: Map<string, number> } {
  const items = new Set<string>();
  const contents = new Map<string, number>();
  for (const entry of migrationCatalogue(vault)) {
    const destination = recordDestination(entry);
    if (destination === null) continue;
    const tally = emptyTally();
    for (const locator of entry.locators) {
      scanLocator(locator, tally, (item) => {
        items.add(`${itemKey(vault, item)}\u0000${itemSum(item)}`);
        for (const record of itemRecords(vault, destination, item)) {
          const key = contentKey(record.kind, record.body);
          contents.set(key, (contents.get(key) ?? 0) + 1);
        }
      });
    }
  }
  return { items, contents };
}

/**
 * Records absent from the restored tree, in fold order. A record is
 * present only as an occurrence of THIS vault (`journal-scope.ts`, the
 * rule the migration journal matches by): a `migrated` mark counts when
 * it names this vault and the tree holds its item with the same checksum;
 * a mark of another vault is that vault's own occurrence of an identical
 * item, and is written back beside this vault's. An unmarked copy that a
 * dual write stamped with another vault's marker is never matched by
 * content either. An unmarked copy that names no vault keeps the content
 * match: it may be this vault's own copy, and writing it back would
 * duplicate the row the restored tree already holds.
 */
function recordsToReplay(
  vault: string,
  scope: JournalScope,
  all: ReadonlyArray<StoreRecord>,
): StoreRecord[] {
  const { items, contents } = restoredIdentity(vault);
  const out: StoreRecord[] = [];
  for (const record of [...all].toSorted(compareRecords)) {
    const mark = migratedMark(record);
    if (mark !== null) {
      const own = sameJournalVault(markVault(scope, mark.vault, record), scope.vault);
      if (!own || !items.has(`${mark.key}\u0000${mark.sum}`)) out.push(record);
      continue;
    }
    if (copyNamesOtherVault(scope, record)) {
      out.push(record);
      continue;
    }
    const key = contentKey(record.kind, record.body);
    const left = contents.get(key) ?? 0;
    if (left > 0) contents.set(key, left - 1);
    else out.push(record);
  }
  return out;
}

/** The ledger each held `ledgers` record sits in (`ledgers/<name>/...`), by record id. */
function ledgerOfRecords(store: StoreHandle): Map<string, string> {
  const out = new Map<string, string>();
  for (const partition of store.partitions) {
    for (const shard of readPartition(partitionDir(store.root, partition), {
      onUnreadable: () => {},
    })) {
      if (shard.stream !== "ledgers") continue;
      const ledger = shard.rel.split("/")[1] ?? "unknown";
      for (const record of shard.all) out.set(record.id, ledger);
    }
  }
  return out;
}

/** Refuse while a held shard's records cannot all be seen, naming the shards. */
function refuseUnseen(unseen: UnseenShards, done: string): void {
  const named = describeUnseen(unseen);
  if (named === null) return;
  throw new RollbackRefusedError(
    `${named}; a record in one would never be written back, so ${done} and this machine ` +
      "stays switched. Let sync finish, fix their permissions or repair the shard, then run " +
      "the rollback again",
  );
}

/** Every held record, once every shard reads in full (see {@link refuseUnseen}). */
function completeRecords(store: StoreHandle, done: string): StoreRecord[] {
  const read = readHeldRecords(store);
  refuseUnseen(read.unseen, done);
  return read.records;
}

export interface RollbackOptions {
  readonly agent: string;
  readonly hooks?: RollbackHooks;
}

/**
 * Refuse a restore that would lose late legacy writes the import could not
 * take (see the module header); when it left unparseable items, copy the
 * tree aside first and return where.
 */
function guardLateImport(vault: string, dir: string, late: TransitionResult): string | null {
  if (!late.converged) {
    throw new RollbackRefusedError(
      `the legacy tree kept changing through ${late.passes} import passes; nothing was ` +
        "restored. Run the rollback again once the machines on the old release are quiet",
    );
  }
  if (late.held_back > 0) {
    throw new RollbackRefusedError(
      `${late.held_back} late legacy item(s) belong to a store partition this machine does ` +
        "not hold, and the restore would delete them; nothing was restored. Roll back on a " +
        "machine that holds every partition, or bring the missing partition here first",
    );
  }
  if (late.unparseable === 0) return null;
  const kept = join(dir, ROLLBACK_KEPT_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  cpSync(join(vault, BRAIN_ROOT_REL), kept, { recursive: true });
  return kept;
}

/** Roll this machine back to the legacy layout; see the module header. */
export function rollbackMigration(
  vault: string,
  store: StoreHandle,
  options: RollbackOptions,
): RollbackResult {
  const dir = migrationDir(store);
  const vaultId = readVaultIdentity(vault)?.vault_id ?? null;
  // Another device's removal counts too: its record may arrive before
  // sync deletes the tree here, and a tree rebuilt now would sync back to
  // every device while no switched device imports from it any more.
  const removedElsewhere = legacyTreeRemovedRecords(store).some(
    (r) => r.body["vault_id"] === vaultId,
  );
  const removing = readRemovalInProgress(store);
  if (
    readRemovalMarker(store, vault) !== null ||
    removedElsewhere ||
    (removing !== null && sameVaultPath(removing.vault, vault)) ||
    !existsSync(join(vault, BRAIN_ROOT_REL))
  ) {
    throw new RollbackRefusedError(
      "the legacy tree has left the vault; a rollback is only possible until then",
    );
  }
  const migration = readMigrationState(dir);
  const backup = readMigrationBackup(dir);
  if (migration === null || backup === null || backup.snapshot === null) {
    throw new RollbackRefusedError("this machine holds no migration backup to roll back to");
  }
  // The backup is device-wide but of one vault: a vault configured after
  // the switch was imported by the transition, which never changes its
  // legacy tree and takes no backup of it. Restoring another vault's
  // snapshot into it would replace its tree, so it is refused before
  // anything is touched.
  const mismatch = backupVaultMismatch(backup, vault);
  if (mismatch !== null) {
    throw new RollbackRefusedError(
      `${mismatch}; nothing was restored. A vault whose legacy data the transition imported ` +
        "keeps its legacy tree unchanged and has no backup of its own to roll back to; roll " +
        "back with the vault this machine migrated",
    );
  }
  // Only an unfinished rollback (its state file is still there) runs on a
  // device that is not switched: a finished one, run again, would restore
  // the old snapshot over everything written to the legacy tree since.
  if (readState(dir) === null && !deviceSwitchedHere(store, store.device)) {
    throw new RollbackRefusedError(
      migration.phase === "rolled-back"
        ? "this machine was already rolled back to the legacy layout"
        : "this machine has not switched to the brain store; there is nothing to roll back",
    );
  }
  // Every record of the store is written back or counted, so a shard
  // whose records this machine cannot all see refuses the rollback before
  // anything is touched: the switch would be cleared over a legacy tree
  // that lacks them, and nothing would write them back later.
  refuseUnseen(unseenHeldShards(store), "nothing was restored");
  const scope = journalScopeFor(vault, store.device, dir, vaultId);
  const gateRun = `rollback-${migration.run_id}`;
  holdGateFor(vault, gateRun);
  try {
    let state = readState(dir);
    let legacyTreeKept: string | null = null;
    let all: StoreRecord[] | null = null;
    if (state === null || !state.restored) {
      // Late legacy writes first, as the removal does (design D11a): what a
      // machine on the old release wrote into this tree since the last
      // transition import is in neither the snapshot nor the store yet, so
      // the restore below would wipe it. Imported now, the replay writes it
      // back.
      const late = importLateLegacyWrites(vault, store, options.agent, vaultId, {
        waitMs: GATED_IMPORT_WAIT_MS,
      });
      all = completeRecords(store, "nothing was restored");
      legacyTreeKept = guardLateImport(vault, dir, late);
      const restored_files = restoreBrain(vault, backup.snapshot, snapshotCopyIn(backup));
      const restored_backups = restoreMigrationBackups(vault, backup);
      state = { restored: true, restored_files, restored_backups };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ROLLBACK_STATE), JSON.stringify(state));
    }

    // A resumed rollback reads them now; the tree it restored waits.
    all ??= completeRecords(store, "the restored tree waits for a resumed rollback");
    const absent = recordsToReplay(vault, scope, all);
    const replayed: string[] = [];
    const refused = exportRecords(
      vault,
      store.device,
      { records: absent.filter((r) => EXPORTED_KINDS.has(r.kind)), all },
      {
        ...replayJournal(dir),
        onStart: (record, tail) => {
          appendFileSync(
            join(dir, ROLLBACK_JOURNAL),
            `${STARTED_PREFIX}${record.id} ${tail ?? NO_TAIL}\n`,
          );
        },
        onRecord: (record) => {
          appendFileSync(join(dir, ROLLBACK_JOURNAL), `${record.id}\n`);
          replayed.push(record.id);
          options.hooks?.afterReplayed?.(replayed.length);
        },
      },
    );

    // Absent from the restored tree with no exporter: they stay in the store.
    const noLegacy: Record<string, number> = {};
    const ledgerKept: Record<string, number> = {};
    const ledgers = ledgerOfRecords(store);
    for (const record of absent) {
      if (EXPORTED_KINDS.has(record.kind)) continue;
      noLegacy[record.kind] = (noLegacy[record.kind] ?? 0) + 1;
      if (record.kind === LEDGER_ROW_KIND) {
        const ledger = ledgers.get(record.id) ?? "unknown";
        ledgerKept[ledger] = (ledgerKept[ledger] ?? 0) + 1;
      }
    }

    let unswitched = "";
    if (deviceSwitchedHere(store, store.device)) {
      unswitched = appendRecord(store, {
        partition: "shared",
        stream: MIGRATION_STREAM,
        kind: DEVICE_UNSWITCHED_KIND,
        agent: options.agent,
        body: { [AUTHORITY_FIELD]: "human", device: store.device, run_id: migration.run_id },
      }).record.id;
    }
    clearSwitchMarker(store.root, store.device);
    unbindVaultFromStore(store.root);
    const tokensAside = removeDeviceTokens(dir, vault);
    writeMigrationState(dir, {
      ...migration,
      phase: "rolled-back",
      updated_at: new Date().toISOString(),
    });
    rmSync(join(dir, ROLLBACK_STATE), { force: true });
    rmSync(join(dir, ROLLBACK_JOURNAL), { force: true });
    return {
      device: store.device,
      restored_files: state.restored_files,
      restored_backups: state.restored_backups,
      replayed,
      no_legacy_form: noLegacy,
      ledger_rows_kept: ledgerKept,
      refused,
      unswitched,
      device_tokens_aside: tokensAside,
      legacy_tree_kept: legacyTreeKept,
    };
  } finally {
    releaseGateFor(vault, gateRun);
  }
}
