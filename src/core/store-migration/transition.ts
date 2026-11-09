/**
 * The transition (task 2.4, design D11a): until the legacy tree leaves the
 * vault, machines still on an old release keep writing into it and file
 * sync delivers those files to machines that switched. A switched machine
 * imports them line by line through the same journal the migration uses:
 * an item already in the store (by key and checksum, from any device) is
 * skipped, a new or grown one is imported once. It never writes into the
 * legacy tree and holds no migration gate.
 *
 * The report names the devices still on the legacy layout: the migration
 * cohort and the devices seen in legacy shard names (in any pass), minus
 * every device that switched or was retired.
 *
 * One import runs at a time on a machine: the session-start and dream
 * hooks, `migrate-store`, the removal and the rollback all call it, and
 * two concurrent imports would both find an item missing and both append
 * it. A device-local lock in the migration folder serialises them. An
 * import is one synchronous run that can take minutes on a large vault,
 * and the lock's age is never refreshed while it runs, so it counts as
 * abandoned only after {@link TRANSITION_LOCK_STALE_MS}. A hook waits the
 * short shared budget for it; the removal and the rollback, which hold
 * the migration gate and need the import, wait {@link GATED_IMPORT_WAIT_MS}.
 */

import { dirname, join } from "node:path";

import { mkdirSync } from "node:fs";

import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { acquireDirLock } from "../store/local-lock.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { convertPass, dualWritePool, type ConvertHooks } from "./convert.ts";
import { loadJournal, migrationDir } from "./journal.ts";
import { journalScopeFor } from "./backup.ts";
import type { JournalScope } from "./journal-scope.ts";
import { legacyDevices } from "./migration-records.ts";
import { legacyFileStamps, recordImportWatermark } from "./transition-watermark.ts";

/** The most passes one transition import takes. */
const TRANSITION_MAX_PASSES = 20;

/** Age after which the import lock counts as abandoned by a crashed holder. */
export const TRANSITION_LOCK_STALE_MS = 30 * 60 * 1000;

/** How long a run holding the migration gate waits for an import in progress. */
export const GATED_IMPORT_WAIT_MS = 10 * 60 * 1000;

export interface TransitionImportOptions {
  readonly hooks?: ConvertHooks;
  /** Longest wait for another import on this machine (the shared lock budget by default). */
  readonly waitMs?: number;
  /**
   * The vault whose items these are, when the tree read is not the vault
   * itself (the removal's import from its device-local archive). The
   * journal keys every import by that vault (`journal-scope.ts`).
   */
  readonly identityOf?: string;
  /**
   * Record the legacy-file watermark of the automatic import from the
   * stamps taken before the final pass (`transition-watermark.ts`): the
   * automatic import and the transition that binds a vault do; an import
   * from an archive, or under a rollback, does not.
   */
  readonly recordWatermark?: boolean;
}

export interface TransitionResult {
  readonly imported: number;
  readonly passes: number;
  /**
   * Whether the last pass imported nothing: false when the pass limit was
   * reached while the legacy tree still changed, so something may be left.
   */
  readonly converged: boolean;
  readonly unparseable: number;
  /** Of `unparseable`, the items of a partition this machine does not hold (retried later). */
  readonly held_back: number;
  /** Devices still writing the legacy layout. */
  readonly legacy_devices: ReadonlyArray<string>;
}

/** Import late legacy writes into the store of a switched machine. */
export function importLateLegacyWrites(
  vault: string,
  store: StoreHandle,
  agent: string,
  vaultId: string | null,
  options: TransitionImportOptions = {},
): TransitionResult {
  const dir = migrationDir(store);
  const lockTarget = join(dir, TRANSITION_LOCK);
  mkdirSync(dirname(lockTarget), { recursive: true });
  const release = acquireDirLock(lockTarget, {
    staleMs: TRANSITION_LOCK_STALE_MS,
    budgetMs: options.waitMs ?? resolveLockWaitBudgetMs(),
    label: "transition import lock",
    remedy: "another import of late legacy writes is running on this machine; retry once it ends",
  });
  try {
    // `vaultId` is the vault's marker id, read by the caller before the
    // removal moved the marker into its archive with the rest of the tree.
    const scope = journalScopeFor(options.identityOf ?? vault, store.device, dir, vaultId);
    return importUnderLock(vault, store, agent, vaultId, dir, scope, options);
  } finally {
    release();
  }
}

/** The lock target that serialises transition imports on this machine. */
const TRANSITION_LOCK = "transition-import";

function importUnderLock(
  vault: string,
  store: StoreHandle,
  agent: string,
  vaultId: string | null,
  dir: string,
  scope: JournalScope,
  options: TransitionImportOptions,
): TransitionResult {
  const hooks = options.hooks;
  const journal = loadJournal(dir, store, scope);
  const ctx = {
    vault,
    store,
    vaultId,
    agent,
    dir,
    journal,
    scope,
    pool: dualWritePool(store, journal, scope),
    ...(hooks !== undefined ? { hooks } : {}),
  };
  let imported = 0;
  let passes = 0;
  let unparseable = 0;
  let heldBack = 0;
  let converged = false;
  // Every pass's devices: a shard renamed or removed between passes, or a
  // stop at the cap, must not drop a device from the removal gate.
  const seen = new Set<string>();
  // The stamps taken before the latest pass: what that pass read, at the
  // latest, so the watermark never claims content no pass imported.
  let stamps: Record<string, string> = {};
  for (passes = 1; passes <= TRANSITION_MAX_PASSES; passes++) {
    if (options.recordWatermark === true) stamps = legacyFileStamps(vault);
    const pass = convertPass(ctx);
    imported += pass.imported;
    unparseable = pass.problems.length;
    heldBack = pass.heldBack;
    for (const device of pass.devices) seen.add(device);
    if (pass.imported === 0) {
      converged = true;
      break;
    }
  }
  const legacy = legacyDevices(store, [...seen]);
  if (options.recordWatermark === true) {
    recordImportWatermark(store, { stamps, devices: legacy, converged, heldBack });
  }
  return {
    imported,
    passes: Math.min(passes, TRANSITION_MAX_PASSES),
    converged,
    unparseable,
    held_back: heldBack,
    legacy_devices: legacy,
  };
}
