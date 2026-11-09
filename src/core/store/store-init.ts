/**
 * Create a brain store (`o2b store init`): the only code path that mints a
 * store id or writes an identity file.
 *
 * Writers never create a store. A store is created once, on one machine,
 * by an explicit command; every other machine receives its partitions
 * through sync. That rules out the race in which a second machine whose
 * sync has not delivered `shared/store.json` yet would mint a store id of
 * its own.
 *
 * Rules:
 *
 *  - **Requested partitions.** Both partitions by default; a machine that
 *    must not hold `private` (a server) asks for `shared` only.
 *  - **One id.** The first requested partition's identity file is created
 *    with an exclusive create, so two processes running init at once agree
 *    on one id; every other partition adopts it.
 *  - **Completion, never a second id.** When some requested partitions are
 *    already held (an init that stopped half way, or a machine adding a
 *    partition later), the missing ones are created with the held store id.
 *    The identity file's content is fixed by the id, so a copy created here
 *    and one delivered by sync are byte-identical.
 *  - **Refusals.** Init refuses when every requested partition is already
 *    held (the store exists), when the partitions belong to different
 *    stores, and when a partition folder holds store files without its
 *    identity file (a partial store: the identity has not been synced, or
 *    was lost); it names what is missing rather than guessing an id.
 *  - **Durable before success.** Every requested identity file is written
 *    and flushed, and the result is read back, before init reports
 *    success. The format document goes into the root and every requested
 *    partition.
 */

import { closeSync, fsyncSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sleepSync } from "../fs-atomic.ts";
import { createFileOnce } from "./blobs.ts";
import {
  STORE_FORMAT_FILE,
  STORE_FORMAT_VERSION,
  STORE_IDENTITY_FILE,
  STORE_PARTITIONS,
  type StorePartition,
} from "./constants.ts";
import { writeFormatDoc } from "./format-doc.ts";
import { recordHeldPartitions } from "./held-ledger.ts";
import { heldPartitions, readStoreId, StoreIdentityError, StoreOpenError } from "./store-open.ts";
import { partitionDir } from "./store-paths.ts";
import { newUlid } from "./ulid.ts";

export interface InitStoreOptions {
  readonly root: string;
  /** Partitions this machine holds (default: all of them). */
  readonly partitions?: ReadonlyArray<StorePartition>;
}

export interface InitStoreResult {
  /** `created`: a new store id; `completed`: missing partitions added to a held store. */
  readonly status: "created" | "completed";
  readonly root: string;
  readonly storeId: string;
  /** Partitions whose identity file this run wrote. */
  readonly created: ReadonlyArray<StorePartition>;
  /** Partitions held after this run. */
  readonly partitions: ReadonlyArray<StorePartition>;
}

/**
 * Why init refused: the store `exists`; a partition is `partial` (store
 * files without an identity file); the partitions are `mixed` (two store
 * ids); an identity file is `corrupt` (it holds no valid store id).
 */
export type StoreInitRefusalReason = "exists" | "partial" | "mixed" | "corrupt";

/** Init would not run; the message says why and what to do. */
export class StoreInitRefusal extends Error {
  constructor(
    readonly reason: StoreInitRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "StoreInitRefusal";
  }
}

/**
 * Entries of a partition folder that only a store writes: anything but the
 * format document and dot-prefixed names (temp files, sync tools' markers
 * such as `.stfolder`).
 */
function storeEntries(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name !== STORE_FORMAT_FILE && !name.startsWith("."));
}

/** Flush a file and, best effort, its folder entry. */
function flush(path: string, dir: string): void {
  // Opened read-write: Windows refuses fsync (FlushFileBuffers) on a read-only handle.
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Windows cannot open a directory for fsync; NTFS journals the entry.
  }
}

/** How long the id of an identity file another init is still writing is waited for. */
const IDENTITY_READ_ATTEMPTS = 10;
const IDENTITY_READ_SLEEP_MS = 20;

/**
 * The id in an identity file another process created. Where the
 * filesystem has no hard links, that process creates the final name first
 * and writes into it, so the file may still be empty or half written: it
 * is read again for a short while before it counts as corrupt.
 */
function readWinnerId(dir: string): string {
  const path = join(dir, STORE_IDENTITY_FILE);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const id = readStoreId(dir);
      if (id !== null) return id;
      if (attempt >= IDENTITY_READ_ATTEMPTS) {
        throw new StoreOpenError(`${path} vanished while init ran`);
      }
    } catch (err) {
      if (!(err instanceof StoreIdentityError)) throw err;
      if (attempt >= IDENTITY_READ_ATTEMPTS) {
        // The other init created the file and never wrote its id (it
        // stopped in between, on a filesystem without hard links). A
        // re-run alone would refuse the same file as corrupt.
        throw new StoreInitRefusal(
          "corrupt",
          `${path} was created by another store init but still holds no store id ` +
            `(${err.message}); that init may have stopped before writing it. If no init is ` +
            "running, remove the file and run `o2b store init` again",
        );
      }
    }
    sleepSync(IDENTITY_READ_SLEEP_MS);
  }
}

/**
 * Create `dir`'s identity file for `storeId`. Returns the id the file
 * holds afterwards and whether this call wrote it. The temp file goes into
 * the store root, which is never synced (FORMAT.md), so a crash cannot
 * leave it in a partition folder that sync copies to other machines.
 */
function createIdentity(
  root: string,
  dir: string,
  storeId: string,
): { readonly id: string; readonly won: boolean } {
  const path = join(dir, STORE_IDENTITY_FILE);
  const text = `${JSON.stringify({ store_id: storeId, format: STORE_FORMAT_VERSION })}\n`;
  // Another process that created it first wins: its id is the store's id.
  const won = createFileOnce(path, Buffer.from(text, "utf8"), { tempDir: root });
  if (!won) return { id: readWinnerId(dir), won };
  flush(path, dir);
  return { id: storeId, won };
}

function ordered(partitions: ReadonlyArray<StorePartition>): StorePartition[] {
  return STORE_PARTITIONS.filter((p) => partitions.includes(p));
}

/** Create the store at `options.root`, or complete a half-created one. */
export function initStore(options: InitStoreOptions): InitStoreResult {
  const { root } = options;
  const requested = ordered(options.partitions ?? STORE_PARTITIONS);
  if (requested.length === 0) {
    throw new TypeError("store init needs at least one partition");
  }

  let held: Set<StorePartition>;
  let heldId: string | null;
  try {
    ({ held, storeId: heldId } = heldPartitions(root));
  } catch (err) {
    if (err instanceof StoreIdentityError) throw new StoreInitRefusal("corrupt", err.message);
    if (err instanceof StoreOpenError) throw new StoreInitRefusal("mixed", err.message);
    throw err;
  }

  const missing = requested.filter((p) => !held.has(p));
  if (missing.length === 0) {
    throw new StoreInitRefusal(
      "exists",
      `a brain store already exists at ${root} (store id ${heldId}, partitions: ` +
        `${ordered([...held]).join(", ")}); nothing to create`,
    );
  }
  for (const partition of missing) {
    const dir = partitionDir(root, partition);
    const found = storeEntries(dir);
    if (found.length > 0) {
      throw new StoreInitRefusal(
        "partial",
        `${dir} holds store files (${found.slice(0, 3).join(", ")}) but no ` +
          `${STORE_IDENTITY_FILE}: the ${partition} partition's identity is missing. ` +
          "Let sync deliver it from a machine that holds the store, or restore it from a " +
          "backup; init does not guess the store id of existing records",
      );
    }
  }

  let storeId = heldId ?? newUlid();
  const created: StorePartition[] = [];
  for (const partition of missing) {
    let identity: { readonly id: string; readonly won: boolean };
    try {
      identity = createIdentity(root, partitionDir(root, partition), storeId);
    } catch (err) {
      // The winner's file still corrupt after the grace: the same refusal
      // the read of the held partitions above gives it.
      if (err instanceof StoreIdentityError) throw new StoreInitRefusal("corrupt", err.message);
      throw err;
    }
    const { id: winner, won } = identity;
    if (won) created.push(partition);
    if (heldId === null && partition === missing[0]) storeId = winner;
    else if (winner !== storeId) {
      throw new StoreInitRefusal(
        "mixed",
        `${partitionDir(root, partition)} was given store id ${winner} while init ran, ` +
          `but the store id is ${storeId}; keep one store per root`,
      );
    }
  }

  writeFormatDoc(root);
  for (const partition of requested) writeFormatDoc(partitionDir(root, partition));

  // Read back what is on disk before reporting success.
  const after = heldPartitions(root);
  const absent = requested.filter((p) => !after.held.has(p));
  if (after.storeId !== storeId || absent.length > 0) {
    throw new StoreOpenError(
      `store init at ${root} did not leave the expected store (id ${storeId}, missing: ` +
        `${absent.join(", ") || "none"}); run it again`,
    );
  }
  recordHeldPartitions(root, after.held);
  return {
    // `created` only when this run minted the id: an init that lost the
    // race for the first identity file completed the winner's store.
    status: heldId === null && created.includes(missing[0]!) ? "created" : "completed",
    root,
    storeId,
    created,
    partitions: ordered([...after.held]),
  };
}
