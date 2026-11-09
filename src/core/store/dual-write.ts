/**
 * Dual writes (task 1.11, design D13 phase 1): while the `store_dual_write`
 * flag is on, the legacy writers also append the equivalent record to the
 * brain store, so the store can be checked against the legacy tree before
 * any reader depends on it.
 *
 * Rules every legacy writer gets from this one entry point:
 *
 *  - **Off means untouched.** With the flag off, {@link dualWrite} returns
 *    after reading the flag; the record builder is never called and
 *    nothing is written anywhere, so legacy behaviour is byte-identical.
 *  - **The legacy write always wins.** A store failure of any kind (no
 *    store root, a root inside the vault, a partition this machine does not
 *    hold, a full disk) is caught here. It is counted in the device-local
 *    status file that doctor reads, and the first one in a process prints
 *    one warning on stderr. It never reaches the legacy caller.
 *  - **A real device id is required.** The store refuses the empty device
 *    id that the `O2B_DEVICE_ID=""` opt-out selects. Then the dual write is
 *    skipped, counted, and warned about once per process.
 *  - **Dual writes never create a store.** Only `o2b store init` does. With
 *    no store at the root, the dual write is skipped, counted, and warned
 *    about once per process; doctor tells the user to run the init.
 *  - **Vault identity.** Every record body carries the writing vault's
 *    id (`vault_id`, FORMAT.md), so a later phase can tell which vault a
 *    record came from. Phase 1 indexes every record of the store in every
 *    vault on the machine and does not filter by it.
 *  - **Partitions.** A record marked private goes to `private`; when this
 *    machine does not hold it, the appender's refusal applies, which counts
 *    as a failure and leaves the legacy write alone. A record marked
 *    private-when-held goes to `private` when this machine holds it and to
 *    `shared` otherwise. A record whose body carries a `<private>` region,
 *    or the placeholder a stripped one leaves, at any depth is private
 *    whatever its builder judged (`private-region.ts`). A record written
 *    while a private writer operation runs is private too, whoever wrote
 *    it (`operation-scope.ts`).
 *  - **Located records.** A record that concerns one existing entry (a
 *    tombstone, a moved entry) can be placed in the partition that entry
 *    lives in instead of the operation's one partition ({@link Located}),
 *    so a device that holds only `shared` sees a shared entry removed even
 *    when the rest of the operation is private.
 *
 * Call it after the legacy write has succeeded and after any legacy lock is
 * released (the store takes its own device-local lock), passing the vault
 * written and, when the caller has one, its config path. The record kinds
 * and their bodies are built in `dual-write-records.ts`.
 */

import { readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { resolveAgentName, resolveStoreDualWrite } from "../config.ts";
import { ORIGIN_CHANNEL, resolveOriginChannel } from "../origin-channel.ts";
import { resolveAppendShardId } from "../brain/ledger-shards.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import { appendRecord, PartitionUnavailableError, type AppendResult } from "./appender.ts";
import {
  STORE_PARTITIONS,
  VAULT_ID_FIELD,
  type Authority,
  type StorePartition,
} from "./constants.ts";
import type { RecordBody } from "./envelope.ts";
import { withLocalLock } from "./local-lock.ts";
import { activeOperationPrivate } from "./operation-scope.ts";
import { valueCarriesPrivateRegion } from "./private-region.ts";
import { NoStoreError, openStore, readStoreId, type StoreHandle } from "./store-open.ts";
import {
  dualWriteStatusPath,
  isPathInsideResolved,
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
  type StreamRef,
} from "./store-paths.ts";

/** One store record a legacy write produces. */
export interface DualWriteRecord extends StreamRef {
  /** `true` sends the record to the `private` partition. */
  readonly private?: boolean;
  /**
   * `true` sends the record to `private` when this machine holds that
   * partition, and to `shared` when it does not: for truth claims and
   * audit rows that name no private page. Ignored when `private` is
   * `true`.
   */
  readonly privateWhenHeld?: boolean;
  /** Placed by the entry it concerns, not by the operation's one partition. */
  readonly located?: Located;
  readonly kind: string;
  /** The writing agent; defaults to the configured agent name. */
  readonly agent?: string;
  readonly scope?: string | null;
  readonly body: RecordBody;
}

/**
 * Where a record that concerns one existing entry goes (design D14 item
 * 18): the partition the entry lives in, apart from the partition the
 * operation's other records share.
 *
 *  - A content-free record (`content: false`, a tombstone) goes exactly
 *    there. No verdict raises it: it carries no text to protect, and a
 *    shared entry's removal must reach a device that holds only `shared`.
 *  - A content-bearing record (`content: true`, a moved entry) goes there,
 *    or to `private` when the active operation is private or its body
 *    carries a `<private>` region: raise-only, as every other record.
 *  - `onlyIfApart`: the record is written only when the operation's other
 *    records land in another partition: the tombstone of a shared entry a
 *    private value replaces, which a device holding both partitions sees
 *    before the replacement and a device holding only `shared` sees last.
 */
export interface Located {
  readonly partition: StorePartition;
  readonly content: boolean;
  readonly onlyIfApart?: boolean;
}

/**
 * Where a dual write comes from: the vault the legacy write went to and the
 * machine config it was made under. Without it the flag and the store root
 * come from the default config, which is wrong for a caller working on
 * another vault or under another config.
 */
export interface DualWriteContext {
  /** The vault the legacy write went to (`null`: none); a store root inside it is refused. */
  readonly vault?: string | null;
  /** The machine config the flag and the store root are read from. */
  readonly configPath?: string;
}

/** What {@link dualWrite} builds lazily, only when the flag is on. */
export type DualWriteBuild = () => DualWriteRecord | ReadonlyArray<DualWriteRecord> | null;

/** The counters doctor reads. */
export interface DualWriteStatus {
  /** Dual writes that threw and were dropped (the legacy write was kept). */
  readonly failures: number;
  /** Dual writes skipped because this machine has no device id. */
  readonly skipped_no_device: number;
  /** Dual writes skipped because no store exists at the root yet. */
  readonly skipped_no_store: number;
  readonly last_error: string | null;
  readonly last_failure_at: string | null;
  readonly last_skip_at: string | null;
}

const EMPTY_STATUS: DualWriteStatus = Object.freeze({
  failures: 0,
  skipped_no_device: 0,
  skipped_no_store: 0,
  last_error: null,
  last_failure_at: null,
  last_skip_at: null,
});

type WarningKind = "failure" | "device" | "store";
const warned = new Set<WarningKind>();
const handles = new Map<string, StoreHandle>();

/** Whether the dual-write flag is on. An unreadable config reads as off. */
export function isDualWriteEnabled(configPath?: string): boolean {
  try {
    return resolveStoreDualWrite(configPath);
  } catch {
    return false;
  }
}

/**
 * The authority of a write whose caller named none, from the process's
 * origin channel: an operator running `o2b` decides as a human; an agent
 * calling a tool, a bulk import, or an unclaimed process decides as an
 * agent. Decision-model verdicts pass `model` explicitly.
 */
export function authorityFromOrigin(): Authority {
  // The strict read: it decides authority and stamps nothing, and an
  // unclaimed process (which throws here) decides as an agent.
  try {
    return resolveOriginChannel() === ORIGIN_CHANNEL.cli ? "human" : "agent";
  } catch {
    return "agent";
  }
}

/** Read the device-local dual-write counters. */
export function readDualWriteStatus(path: string = dualWriteStatusPath()): DualWriteStatus {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DualWriteStatus>;
    return {
      failures: typeof parsed.failures === "number" ? parsed.failures : 0,
      skipped_no_device:
        typeof parsed.skipped_no_device === "number" ? parsed.skipped_no_device : 0,
      skipped_no_store: typeof parsed.skipped_no_store === "number" ? parsed.skipped_no_store : 0,
      last_error: typeof parsed.last_error === "string" ? parsed.last_error : null,
      last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
      last_skip_at: typeof parsed.last_skip_at === "string" ? parsed.last_skip_at : null,
    };
  } catch {
    return EMPTY_STATUS;
  }
}

function bumpStatus(update: (status: DualWriteStatus) => DualWriteStatus): void {
  try {
    const path = dualWriteStatusPath();
    withLocalLock(path, () => {
      const next = update(readDualWriteStatus(path));
      atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    });
  } catch {
    // The counter is diagnostics; failing to keep it must not fail anything.
  }
}

function warnOnce(kind: WarningKind, message: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  try {
    process.stderr.write(`Open Second Brain: ${message}\n`);
  } catch {
    // stderr closed: nothing left to tell
  }
}

function recordFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  warnOnce(
    "failure",
    `a brain store dual write failed (${message}); the legacy write is intact. ` +
      "Later failures in this process are counted, not printed; `o2b brain doctor` reports them.",
  );
  const at = new Date().toISOString();
  bumpStatus((s) => ({
    ...s,
    failures: s.failures + 1,
    last_error: message.slice(0, 500),
    last_failure_at: at,
  }));
}

function recordNoDevice(): void {
  warnOnce(
    "device",
    "brain store dual writes are on but this machine has no device id (O2B_DEVICE_ID is empty " +
      "or device_id is unset); the dual writes are skipped and the legacy writes are intact.",
  );
  const at = new Date().toISOString();
  bumpStatus((s) => ({ ...s, skipped_no_device: s.skipped_no_device + 1, last_skip_at: at }));
}

function recordNoStore(root: string): void {
  warnOnce(
    "store",
    `brain store dual writes are on but there is no store at ${root}; the dual writes are ` +
      "skipped and the legacy writes are intact. Run `o2b store init` to create the store.",
  );
  const at = new Date().toISOString();
  bumpStatus((s) => ({ ...s, skipped_no_store: s.skipped_no_store + 1, last_skip_at: at }));
}

/**
 * The store this device writes for `context`, opened once per process and
 * re-opened when its partitions change. Throws {@link NoStoreError} when
 * the root holds no store, {@link StoreRootInsideVaultError} when the root
 * sits inside the vault written, and the open's error otherwise.
 */
export function storeFor(device: string, context: DualWriteContext): StoreHandle {
  const { root, origin } = resolveConfiguredStoreRoot(context.configPath);
  // The resolver checks the configured vault; the vault actually written
  // may be another one, and a root inside it is just as wrong.
  const vault = context.vault?.trim();
  if (vault !== undefined && vault !== "" && isPathInsideResolved(root, vault, process.platform)) {
    throw new StoreRootInsideVaultError(root, vault, origin);
  }
  const key = `${root}\u0000${device}`;
  const cached = handles.get(key);
  // A partition that went away under a running process (unsynced, or the
  // store removed), that arrived later (a sync delivered `private`), or a
  // different store put at the same root (deleted and created again) is
  // noticed on the next write: the store is opened again, so the clock and
  // the locks come from that store's device-local state.
  if (
    cached !== undefined &&
    STORE_PARTITIONS.every((p) => {
      const id = readStoreId(partitionDir(root, p));
      return cached.partitions.has(p) ? id === cached.storeId : id === null;
    })
  ) {
    return cached;
  }
  const handle = openStore({ root, device });
  handles.set(key, handle);
  return handle;
}

/** The id of the vault written, or `null` when it has no identity marker or none was named. */
function vaultIdOf(context: DualWriteContext): string | null {
  const vault = context.vault?.trim();
  if (vault === undefined || vault === "") return null;
  return readVaultIdentity(vault)?.vault_id ?? null;
}

function defaultAgent(): string {
  try {
    return resolveAgentName();
  } catch {
    return "agent";
  }
}

/** The records `build` produced, as a list (empty when it built none). */
export function builtRecords(build: DualWriteBuild): ReadonlyArray<DualWriteRecord> {
  const built = build();
  if (built === null) return [];
  return Array.isArray(built) ? built : [built as DualWriteRecord];
}

/**
 * Append `records` to `store` as one operation, in order: one partition
 * for all of them, `private` when any record's flags, the active operation
 * scope or the `<private>` region backstop make it so (see the module
 * docblock), except a {@link Located} record, which goes where its entry
 * lives. Each is stamped with the written vault's id. The partitions are
 * checked before the first append, so a machine without one writes none of
 * the records rather than half the operation. Throws the appender's error.
 */
export function appendStoreRecords(
  store: StoreHandle,
  records: ReadonlyArray<DualWriteRecord>,
  context: DualWriteContext,
): AppendResult[] {
  const vaultId = vaultIdOf(context);
  const scoped = activeOperationPrivate();
  const joined = records.filter((record) => record.located === undefined);
  const isPrivate =
    scoped ||
    joined.some(
      (record) =>
        record.private === true ||
        valueCarriesPrivateRegion(record.body) ||
        (record.privateWhenHeld === true && store.partitions.has("private")),
    );
  const partition: StorePartition = isPrivate ? "private" : "shared";
  const placed: Array<[DualWriteRecord, StorePartition]> = [];
  for (const record of records) {
    const at = record.located;
    if (at === undefined) {
      placed.push([record, partition]);
      continue;
    }
    const raised =
      at.content && (scoped || valueCarriesPrivateRegion(record.body)) ? "private" : at.partition;
    if (at.onlyIfApart === true && (joined.length === 0 || raised === partition)) continue;
    placed.push([record, raised]);
  }
  // Every partition is checked before the first append, so a machine
  // without one writes none of the records rather than half the operation.
  for (const [, at] of placed) {
    if (!store.partitions.has(at)) throw new PartitionUnavailableError(at, store.root);
  }
  return placed.map(([record, at]) =>
    appendRecord(store, {
      partition: at,
      stream: record.stream,
      ...(record.ledger !== undefined ? { ledger: record.ledger } : {}),
      kind: record.kind,
      agent:
        record.agent !== undefined && record.agent.trim() !== "" ? record.agent : defaultAgent(),
      scope: record.scope ?? null,
      body: { ...record.body, [VAULT_ID_FIELD]: vaultId },
    }),
  );
}

/**
 * Append the store records `build` describes, when the flag is on. Never
 * throws; see the module docblock for what happens on failure.
 */
export function dualWrite(build: DualWriteBuild, context: DualWriteContext = {}): void {
  if (!isDualWriteEnabled(context.configPath)) return;
  try {
    const device = resolveAppendShardId();
    if (device === "") {
      recordNoDevice();
      return;
    }
    const records = builtRecords(build);
    if (records.length === 0) return;
    let store: StoreHandle;
    try {
      store = storeFor(device, context);
    } catch (err) {
      if (!(err instanceof NoStoreError)) throw err;
      recordNoStore(err.root);
      return;
    }
    appendStoreRecords(store, records, context);
  } catch (err) {
    recordFailure(err);
  }
}
