/**
 * `o2b store move-into-vault` (patch 2.0.1): the one way a store that
 * release 2.0.0 left at the per-user default, outside the vault, moves
 * into the vault's reserved folder, where the vault's sync carries it to
 * the other machines.
 *
 * Nothing starts the move by itself. A move that races live writers,
 * processes of an older release and the sync tool cannot be made safe at
 * a session start, so a person runs it, with the agent sessions of this
 * machine closed. The command:
 *
 *  - refuses unless the store sits at the default root outside the vault
 *    and a vault is configured (a `store_root` the person set is theirs
 *    and never moved);
 *  - takes the relocation lock (a second run is refused, not queued) and
 *    refuses, without waiting, while a shard lock is held or another
 *    writer of the store runs (a dream pass, the automatic migration or
 *    the automatic legacy removal), naming each and telling the person to
 *    close the agent sessions;
 *  - copies, verifies, binds and commits (`../store/store-relocation.ts`)
 *    and says where the store went and where the recovery copy is;
 *  - carries over what a process of an older release wrote to the old
 *    root after the move, at the end of the move and at every later run
 *    (`--carry` runs only that).
 *
 * The surfaces (the session line once a day, the status block and the
 * doctor) say the same thing in the same words while the store is outside
 * the vault, while late writes wait in the old root, and while the old
 * root's marker cannot be read ({@link relocationSurface}). The last
 * refusal or failure of the command, and a carry that could not finish,
 * are kept in a small device-local record those surfaces add to their line.
 */

import { type Dirent, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { resolveVault } from "../config.ts";
import { DREAM_OWNER_STATE_DIR, DREAM_PASS_LOCK } from "../brain/dream-owner/constants.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import {
  MOVE_INTO_VAULT_COMMAND,
  STORE_FORMAT_FILE,
  STORE_PARTITIONS,
  STORE_VAULT_DIR,
  type StorePartition,
} from "../store/constants.ts";
import { processLockHeld } from "../store/process-lock.ts";
import {
  readRelocationMarker,
  relocationOf,
  relocationUnavailableReason,
} from "../store/relocation-target.ts";
import { heldPartitions, heldPartitionsChecked } from "../store/store-open.ts";
import {
  defaultStoreRoot,
  deviceStateDirFor,
  resolveConfiguredStoreRoot,
  storesStateDir,
} from "../store/store-paths.ts";
import {
  carryLateWrites,
  lateWritesPending,
  liveShardLocks,
  pendingRelocation,
  relocateStore,
  type CarryResult,
  type RelocationStep,
} from "../store/store-relocation.ts";
import { autoLegacyRemovalRunning } from "./auto-removal.ts";
import { describeAutoMigrationRunning, readAutoMigrationRunning } from "./auto-state.ts";

export { MOVE_INTO_VAULT_COMMAND } from "../store/constants.ts";

/** The flag that runs only the carry of late writes. */
export const MOVE_INTO_VAULT_CARRY_COMMAND = `${MOVE_INTO_VAULT_COMMAND} --carry`;

/** What the person is told to do before a run, in every refusal and line. */
const CLOSE_SESSIONS =
  "close every agent session on this machine (Claude Code, Codex, Hermes, OpenClaw and any " +
  "other client that runs Open Second Brain) and wait for running o2b commands to finish";

/** {@link CLOSE_SESSIONS} at the start of a sentence. */
const CLOSE_SESSIONS_SENTENCE = `C${CLOSE_SESSIONS.slice(1)}`;

// ----- The device-local record ---------------------------------------------

/** Device-local record of the command's last refusal or failure, or of a carry that did not finish. */
export const RELOCATION_STATE_FILE = "relocation-state.json";

export interface RelocationState {
  /** `refused`/`failed`: the last move; `carry-failed`: the last carry of late writes. */
  readonly kind: "refused" | "failed" | "carry-failed";
  readonly from: string | null;
  readonly to: string | null;
  readonly reason: string;
  readonly at: string;
}

export function relocationStatePath(): string {
  return join(storesStateDir(processDirsEnv()), RELOCATION_STATE_FILE);
}

/** The record, or null when there is none (or it cannot be read). */
export function readRelocationState(): RelocationState | null {
  try {
    const parsed = JSON.parse(readFileSync(relocationStatePath(), "utf8")) as RelocationState;
    if (
      (parsed.kind === "refused" || parsed.kind === "failed" || parsed.kind === "carry-failed") &&
      typeof parsed.reason === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeState(state: RelocationState): void {
  try {
    const path = relocationStatePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // The record is for the surfaces; the relocation's own state is the marker.
  }
}

/** Drop the record when it is of one of `kinds` (a later run settled it). */
function clearState(kinds: ReadonlyArray<RelocationState["kind"]>): void {
  const state = readRelocationState();
  if (state === null || !kinds.includes(state.kind)) return;
  try {
    rmSync(relocationStatePath(), { force: true });
  } catch {
    // left for the next run
  }
}

// ----- Who writes the store now ----------------------------------------------

/**
 * Writers of this store that run now and hold no shard lock this instant:
 * a dream pass, the automatic store migration, the automatic legacy
 * removal. One description each. An MCP server or a hook that is idle
 * holds nothing and cannot be seen; that is why the person closes the
 * agent sessions, and why a write it makes later is redirected (this
 * release) or carried over (an older release).
 */
export function storeWritersRunning(vault: string, deviceStateDir: string, now: Date): string[] {
  const out: string[] = [];
  if (processLockHeld(join(deviceStateDir, DREAM_OWNER_STATE_DIR, DREAM_PASS_LOCK))) {
    out.push("a dream pass runs");
  }
  const migration = readAutoMigrationRunning(vault, now);
  if (migration !== null) {
    out.push(`the automatic store migration runs (${describeAutoMigrationRunning(migration)})`);
  }
  if (autoLegacyRemovalRunning(vault, now)) {
    out.push("the automatic removal of the legacy tree runs");
  }
  return out;
}

// ----- Where this machine stands ----------------------------------------------

/** Where this machine's store stands with regard to the move (read-only). */
type Standing =
  /** No vault is configured: there is nowhere to move to. */
  | { readonly kind: "no-vault" }
  /** A store root the person set (environment or machine config): never moved. */
  | { readonly kind: "explicit"; readonly root: string }
  /** The store sits at the 2.0.0 default outside the vault: the move is owed. */
  | { readonly kind: "outside"; readonly from: string; readonly to: string; readonly vault: string }
  /** The old root's marker names a move this machine cannot follow now. */
  | { readonly kind: "blocked"; readonly from: string; readonly reason: string }
  /** The store moved into the vault from the old root (late writes may wait there). */
  | { readonly kind: "moved"; readonly from: string; readonly to: string }
  /** The store is in the vault, and no store was moved from the old root. */
  | { readonly kind: "in-vault"; readonly root: string };

function standing(configPath: string | undefined): Standing {
  const vault = resolveVault(configPath);
  if (vault === null || vault.trim() === "") return { kind: "no-vault" };
  const resolved = resolveConfiguredStoreRoot(configPath, vault);
  if (resolved.origin !== "default") return { kind: "explicit", root: resolved.root };
  const pending = pendingRelocation(configPath);
  if (pending !== null) return { kind: "outside", ...pending };
  const from = defaultStoreRoot(processDirsEnv());
  if (resolved.placement === "external") {
    // The default root outside the vault with no move owed: its marker
    // cannot be read, or names a move whose destination does not hold the
    // store now (`store-paths.ts`).
    return { kind: "blocked", from, reason: blockedReason(from) };
  }
  const read = readRelocationMarker(from);
  if (read.kind === "valid") return { kind: "moved", from, to: read.marker.to };
  return { kind: "in-vault", root: resolved.root };
}

function blockedReason(from: string): string {
  const read = readRelocationMarker(from);
  if (read.kind === "unreadable") {
    return relocationUnavailableReason(from, {
      kind: "unreadable",
      marker: read.path,
      why: read.why,
    });
  }
  if (read.kind === "valid") {
    const state = relocationOf(from, read.marker.store_id);
    if (state.kind === "unavailable" || state.kind === "unreadable") {
      return relocationUnavailableReason(from, state);
    }
  }
  return `the brain store at ${from} cannot be moved now`;
}

// ----- The plan (--dry-run) ----------------------------------------------------

export type MoveIntoVaultPlan =
  | {
      readonly kind: "move";
      readonly from: string;
      readonly to: string;
      readonly storeId: string | null;
      readonly partitions: ReadonlyArray<StorePartition>;
      readonly files: number;
      readonly bytes: number;
      /** What the vault's store folder holds now, in words. */
      readonly destination: string;
      /** Writers that would make the run refuse now. */
      readonly writers: ReadonlyArray<string>;
    }
  | {
      readonly kind: "carry";
      readonly from: string;
      readonly to: string;
      readonly writers: ReadonlyArray<string>;
    }
  | { readonly kind: "nothing"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly from: string | null;
      readonly to: string | null;
    };

/** Every file a move copies below `dir`, with its size; dot-named leftovers skipped. */
function sizeBelow(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (at: string): void => {
    let entries;
    try {
      entries = readdirSyncTyped(at);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== STORE_FORMAT_FILE) {
        files += 1;
        bytes += statSizeOf(path);
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function destinationWords(to: string, storeId: string | null): string {
  try {
    const there = heldPartitions(to);
    if (there.storeId === null) return "no brain store yet: the store is copied whole";
    if (there.storeId === storeId) {
      return "a part of this store from an earlier run: it is completed";
    }
    return `another brain store (id ${there.storeId}): the move would refuse; the two are never merged`;
  } catch (err) {
    return `something the move refuses: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** What a run would do now, without doing anything. Never throws for a store problem. */
export function planMoveIntoVault(
  options: { readonly configPath?: string; readonly carryOnly?: boolean; readonly now?: Date } = {},
): MoveIntoVaultPlan {
  const now = options.now ?? new Date();
  let where: Standing;
  try {
    where = standing(options.configPath);
  } catch (err) {
    return { kind: "refused", reason: messageOf(err), from: null, to: null };
  }
  const refusal = refusalOf(where, options.carryOnly === true);
  if (refusal !== null) return refusal;
  if (where.kind === "moved") {
    if (!lateWritesPending(options.configPath)) {
      return {
        kind: "nothing",
        reason:
          `this machine's brain store moved into ${where.to} already, and nothing waits in the ` +
          `old folder ${where.from}`,
      };
    }
    return {
      kind: "carry",
      from: where.from,
      to: where.to,
      writers: writersAt(where.from, options.configPath, now),
    };
  }
  if (where.kind !== "outside") return { kind: "nothing", reason: "nothing to move" };
  let storeId: string | null = null;
  let partitions: StorePartition[] = [];
  try {
    const source = heldPartitionsChecked(where.from);
    storeId = source.storeId;
    partitions = STORE_PARTITIONS.filter((p) => source.held.has(p));
  } catch (err) {
    return { kind: "refused", reason: messageOf(err), from: where.from, to: where.to };
  }
  let files = 0;
  let bytes = 0;
  for (const p of partitions) {
    const size = sizeBelow(join(where.from, p));
    files += size.files;
    bytes += size.bytes;
  }
  return {
    kind: "move",
    from: where.from,
    to: where.to,
    storeId,
    partitions,
    files,
    bytes,
    destination: destinationWords(where.to, storeId),
    writers: writersAt(where.from, options.configPath, now),
  };
}

/** The writers a run would refuse on, read without the lock (for the plan). */
function writersAt(from: string, configPath: string | undefined, now: Date): string[] {
  try {
    const storeId = heldPartitions(from).storeId;
    if (storeId === null) return [];
    const dir = deviceStateDirFor(storeId, processDirsEnv());
    const vault = resolveVault(configPath) ?? "";
    return [
      ...liveShardLocks(dir, () => now.getTime()).map((lock) => `an append to ${lock} runs`),
      ...(vault === "" ? [] : storeWritersRunning(vault, dir, now)),
    ];
  } catch (err) {
    return [`the store's locks cannot be read (${messageOf(err)})`];
  }
}

/** The refusal for a standing the command does not act on, or null. */
function refusalOf(
  where: Standing,
  carryOnly: boolean,
): Extract<MoveIntoVaultPlan, { kind: "refused" | "nothing" }> | null {
  switch (where.kind) {
    case "no-vault":
      return {
        kind: "refused",
        reason:
          "no vault is configured on this machine, so there is no vault folder to move the " +
          "brain store into; the store stays where it is",
        from: null,
        to: null,
      };
    case "explicit":
      return {
        kind: "refused",
        reason:
          `the brain store root ${where.root} is set on this machine (store_root in the ` +
          "machine config, or O2B_STORE_ROOT), so it is the person's choice and is never moved; " +
          `to keep the store in the vault, remove that setting and run ${MOVE_INTO_VAULT_COMMAND}`,
        from: where.root,
        to: null,
      };
    case "blocked":
      return { kind: "refused", reason: where.reason, from: where.from, to: null };
    case "in-vault":
      return {
        kind: "nothing",
        reason: `this machine's brain store is in the vault already (${where.root}); nothing to move`,
      };
    case "outside":
      return carryOnly
        ? {
            kind: "refused",
            reason:
              `this machine's brain store is still at ${where.from}, outside the vault, so there ` +
              `is nothing to carry yet; run ${MOVE_INTO_VAULT_COMMAND} without --carry to move it`,
            from: where.from,
            to: where.to,
          }
        : null;
    case "moved":
      return null;
  }
}

// ----- The run -------------------------------------------------------------------

export type MoveIntoVaultResult =
  | {
      readonly kind: "moved";
      readonly from: string;
      readonly to: string;
      readonly storeId: string;
      /** Files of this device whose offsets the marker records. */
      readonly files: number;
      readonly durationMs: number;
      /** The carry that ran right after the move, or why it failed. */
      readonly carry: CarryResult | { readonly error: string };
    }
  | {
      readonly kind: "carried";
      readonly from: string;
      readonly to: string;
      readonly carry: CarryResult;
    }
  | { readonly kind: "nothing"; readonly reason: string }
  | {
      readonly kind: "refused" | "failed";
      readonly reason: string;
      readonly from: string | null;
      readonly to: string | null;
    }
  | {
      readonly kind: "live";
      readonly from: string;
      readonly to: string;
      readonly writers: ReadonlyArray<string>;
    }
  | { readonly kind: "busy" };

export interface MoveIntoVaultOptions {
  readonly configPath?: string;
  /** Only carry late writes of a store that moved already (`--carry`). */
  readonly carryOnly?: boolean;
  readonly now?: Date;
  /** Fault injection for the crash tests (`store-relocation.ts`). In-process only. */
  readonly atStep?: (step: RelocationStep) => void;
}

/**
 * Run the move (module docblock). Never throws for a store that cannot
 * move: a refusal, a live writer, a busy lock and a failure of the file
 * system are results that name their reason, and a refusal or a failure
 * is recorded for the surfaces.
 */
export function moveStoreIntoVault(options: MoveIntoVaultOptions = {}): MoveIntoVaultResult {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  let where: Standing;
  try {
    where = standing(options.configPath);
  } catch (err) {
    return { kind: "refused", reason: messageOf(err), from: null, to: null };
  }
  const refusal = refusalOf(where, options.carryOnly === true);
  if (refusal !== null) return refusal;
  if (where.kind === "moved") return carryLate(where.from, where.to, options, now);
  if (where.kind !== "outside") return { kind: "nothing", reason: "nothing to move" };

  const { from, to, vault } = where;
  const started = performance.now();
  try {
    const outcome = relocateStore({
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.atStep !== undefined ? { atStep: options.atStep } : {}),
      now: () => now.getTime(),
      liveWriters: (dir) => storeWritersRunning(vault, dir, now),
    });
    switch (outcome.kind) {
      case "not-needed":
        return { kind: "nothing", reason: "nothing to move" };
      case "busy":
        return { kind: "busy" };
      case "live":
        return outcome;
      case "refused":
        writeState({ kind: "refused", from, to, reason: outcome.reason, at });
        return { kind: "refused", reason: outcome.reason, from, to };
      case "relocated": {
        const durationMs = Math.round(performance.now() - started);
        clearState(["refused", "failed"]);
        let carry: CarryResult | { error: string };
        try {
          carry = carryLateWrites(options.configPath);
          settleCarry(outcome.from, outcome.to, carry, at);
        } catch (err) {
          carry = { error: messageOf(err) };
          writeState({
            kind: "carry-failed",
            from: outcome.from,
            to: outcome.to,
            reason: messageOf(err),
            at,
          });
        }
        return {
          kind: "moved",
          from: outcome.from,
          to: outcome.to,
          storeId: outcome.storeId,
          files: outcome.files,
          durationMs,
          carry,
        };
      }
    }
  } catch (err) {
    writeState({ kind: "failed", from, to, reason: messageOf(err), at });
    return { kind: "failed", reason: messageOf(err), from, to };
  }
}

/** Keep or drop the carry record after a carry that ran to its end. */
function settleCarry(from: string, to: string, carry: CarryResult, at: string): void {
  if (carry.waiting === 0) {
    clearState(["carry-failed"]);
    return;
  }
  writeState({
    kind: "carry-failed",
    from,
    to,
    reason:
      `${carry.waiting} file(s) wait in ${from}: the vault's store folder did not hold this ` +
      "store when they were to be written (let the sync bring it back, then run the command again)",
    at,
  });
}

function carryLate(
  from: string,
  to: string,
  options: MoveIntoVaultOptions,
  now: Date,
): MoveIntoVaultResult {
  const at = now.toISOString();
  if (!lateWritesPending(options.configPath)) {
    clearState(["carry-failed"]);
    return {
      kind: "nothing",
      reason: `this machine's brain store moved into ${to} already, and nothing waits in the old folder ${from}`,
    };
  }
  const writers = writersAt(from, options.configPath, now);
  if (writers.length > 0) return { kind: "live", from, to, writers };
  try {
    const carry = carryLateWrites(options.configPath);
    settleCarry(from, to, carry, at);
    return { kind: "carried", from, to, carry };
  } catch (err) {
    writeState({ kind: "carry-failed", from, to, reason: messageOf(err), at });
    return { kind: "failed", reason: messageOf(err), from, to };
  }
}

// ----- What the surfaces say ---------------------------------------------------

/** One line every surface shows while the store needs the command (or cannot be opened). */
export interface RelocationSurface {
  /**
   * Notice code (session start and status). Doctor names the first two as
   * `store-outside-vault` and `store-late-writes` (`migration-check.ts`);
   * the third is the store check's `store-root-invalid`.
   */
  readonly code: "store_outside_vault" | "store_late_writes" | "store_relocation_unreadable";
  readonly text: string;
  readonly from: string;
  readonly to: string | null;
  /** The command that settles it, or null when only a person's decision does. */
  readonly command: string | null;
}

/** What the person is told when the store sits outside the vault. */
export function storeOutsideVaultText(
  from: string,
  to: string,
  last: RelocationState | null,
): string {
  const stopped =
    last !== null && (last.kind === "refused" || last.kind === "failed")
      ? ` The last run of the command stopped: ${last.reason}.`
      : "";
  return (
    `This machine's brain store is at ${from}, outside the vault, so no other machine can ` +
    "receive its records (Open Second Brain 2.0.0 put it there). To move it into the vault's " +
    `hidden ${STORE_VAULT_DIR}/ folder, ${CLOSE_SESSIONS}, then run ${MOVE_INTO_VAULT_COMMAND}. ` +
    `It keeps ${from} as a recovery copy, and nothing moves it by itself.${stopped}`
  );
}

/** What the person is told when late writes wait in the old root. */
export function lateWritesText(from: string, last: RelocationState | null): string {
  const stopped =
    last !== null && last.kind === "carry-failed"
      ? ` The last carry did not finish: ${last.reason}.`
      : "";
  return (
    `A process of an older Open Second Brain release wrote to this machine's old brain store ` +
    `folder ${from} after the store moved into the vault; those records wait there and no ` +
    `other machine receives them. ${CLOSE_SESSIONS_SENTENCE}, ` +
    `then run ${MOVE_INTO_VAULT_COMMAND} again to carry them over.${stopped}`
  );
}

/**
 * The relocation line for this machine, or null when there is nothing to
 * say: the store is outside the vault, late writes wait in the old root,
 * or the old root's marker cannot be read. Cheap when nothing is owed (two
 * `stat`s and one small read); a walk of this device's folders in the old
 * root after a move. Never throws.
 */
export function relocationSurface(configPath?: string): RelocationSurface | null {
  try {
    const from = defaultStoreRoot(processDirsEnv());
    const read = readRelocationMarker(from);
    if (read.kind === "unreadable") {
      return {
        code: "store_relocation_unreadable",
        text: `${relocationUnavailableReason(from, {
          kind: "unreadable",
          marker: read.path,
          why: read.why,
        })}.`,
        from,
        to: null,
        command: null,
      };
    }
    const pending = pendingRelocation(configPath);
    const last = readRelocationState();
    if (pending !== null) {
      return {
        code: "store_outside_vault",
        text: storeOutsideVaultText(pending.from, pending.to, last),
        from: pending.from,
        to: pending.to,
        command: MOVE_INTO_VAULT_COMMAND,
      };
    }
    if (read.kind === "valid" && lateWritesPending(configPath)) {
      return {
        code: "store_late_writes",
        text: lateWritesText(from, last),
        from,
        to: read.marker.to,
        command: MOVE_INTO_VAULT_CARRY_COMMAND,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readdirSyncTyped(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true });
}

function statSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
