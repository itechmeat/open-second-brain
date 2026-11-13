/**
 * The store-only write path (design D14 item 1, task 2.10): the entry
 * point every legacy writer moves to, so one call decides whether a write
 * goes to the store only or to the legacy tree plus the phase 1 dual
 * write.
 *
 *  - **Store-only** (`store-only.ts`): the records go to the store and
 *    nothing is written under the vault's `Brain/`. A store failure fails
 *    the operation with a {@link StoreWriteError} that names the reason and
 *    the remedy: no store at the root, no device id, a store root inside
 *    the vault, a partition this machine does not hold (a private record
 *    on a machine without `private`), or any other store error. Nothing is
 *    skipped silently.
 *  - **Unswitched**: the legacy write runs, then {@link dualWrite} runs
 *    behind the flag with its phase 1 rules (failures swallowed and
 *    counted), so behaviour is unchanged.
 *  - **Fail-open callers** (hooks, best-effort telemetry) pass
 *    `failOpen`: a store failure in store-only mode is logged to the
 *    device-local store-write status file (and to the caller's
 *    `onFailure`, for its own audit) and the caller continues (D14.1).
 *
 * The privacy rules are the phase 1 ones, applied by the same appender
 * (`appendStoreRecords`): one verdict per operation through the ambient
 * scope, one partition per operation, the `<private>` region backstop.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveDeviceId } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { PartitionUnavailableError, type AppendResult } from "./appender.ts";
import {
  appendStoreRecords,
  builtRecords,
  dualWrite,
  failedOnlyInShared,
  storeFor,
  type DualWriteBuild,
  type DualWriteContext,
} from "./dual-write.ts";
import { withLocalLock } from "./local-lock.ts";
import { assertStoreIdentityForWrite, StoreIdentityMismatchError } from "./store-identity.ts";
import { storeOnlyMode, type StoreOnlyOptions } from "./store-only.ts";
import { NoStoreError } from "./store-open.ts";
import { StoreRootInsideVaultError, storesStateDir } from "./store-paths.ts";

/** Why a store-only write failed. */
export type StoreWriteFailure =
  | "no-store"
  | "no-device"
  | "root-inside-vault"
  | "partition-unavailable"
  | "store-identity"
  | "store-error";

const REMEDIES: Readonly<Record<StoreWriteFailure, string>> = Object.freeze({
  "no-store": "Run `o2b store init` on this machine, or let sync deliver the store's partitions.",
  "no-device":
    "Set `device_id` in the machine config, or O2B_DEVICE_ID, to lowercase letters, digits " +
    "and hyphens.",
  "root-inside-vault":
    "Point `store_root` in the machine config (or OPEN_SECOND_BRAIN_STORE_ROOT) at a " +
    "directory outside the vault.",
  "partition-unavailable":
    "Sync that partition's folder of the store to this machine, or make the write from a " +
    "machine that holds it.",
  "store-identity":
    "If the store or this machine's device id was changed on purpose, run `o2b init` to bind " +
    "this machine to the store again; otherwise restore the store this machine was bound to.",
  "store-error": "Run `o2b brain doctor` for the store's state, then retry.",
});

/** A store-only write that did not land, with its reason and remedy. */
export class StoreWriteError extends Error {
  readonly reason: StoreWriteFailure;
  readonly remedy: string;

  constructor(reason: StoreWriteFailure, detail: string, options?: { cause?: unknown }) {
    const remedy = REMEDIES[reason];
    super(`the brain store write failed: ${detail.replace(/\.+$/, "")}. ${remedy}`, options);
    this.name = "StoreWriteError";
    this.reason = reason;
    this.remedy = remedy;
  }
}

function asStoreWriteError(err: unknown): StoreWriteError {
  if (err instanceof StoreWriteError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new StoreWriteError(failureOf(err), detail, { cause: err });
}

function failureOf(err: unknown): StoreWriteFailure {
  if (err instanceof NoStoreError) return "no-store";
  if (err instanceof StoreRootInsideVaultError) return "root-inside-vault";
  if (err instanceof PartitionUnavailableError) return "partition-unavailable";
  if (err instanceof StoreIdentityMismatchError) return "store-identity";
  return "store-error";
}

/**
 * This machine's device id, from the same machine config the switch was
 * judged by. A config that cannot be read is that cause (`store-error`),
 * never "no device id": only an explicitly empty `O2B_DEVICE_ID` is that.
 */
function writerDevice(configPath: string | undefined): string {
  let device: string;
  try {
    device = resolveDeviceId(configPath);
  } catch (err) {
    throw new StoreWriteError(
      "store-error",
      `this machine's device id cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (device === "") {
    throw new StoreWriteError(
      "no-device",
      "this machine has no device id (O2B_DEVICE_ID is empty)",
    );
  }
  return device;
}

/**
 * Append the records `build` describes to the store, with no legacy write
 * and no flag. Returns what was appended (empty when the builder built
 * nothing). Throws {@link StoreWriteError} on any failure.
 */
export function storeWrite(build: DualWriteBuild, context: DualWriteContext = {}): AppendResult[] {
  try {
    const device = writerDevice(context.configPath);
    const records = builtRecords(build);
    if (records.length === 0) return [];
    const store = storeFor(device, context);
    // The store identity check replaces the vault identity guard for a
    // store-only write (design D14 item 13).
    assertStoreIdentityForWrite(store.root, store.storeId, device);
    return appendStoreRecords(store, records, context);
  } catch (err) {
    throw asStoreWriteError(err);
  }
}

/** What {@link routeWrite} did. */
export type RoutedWrite<T> =
  | {
      readonly mode: "store";
      readonly records: ReadonlyArray<AppendResult>;
      /** Set when a fail-open write did not land. */
      readonly failed?: StoreWriteError;
    }
  | { readonly mode: "legacy"; readonly value: T };

export interface RouteWriteSpec<T> {
  /** The legacy write; runs only on an unswitched machine. */
  readonly legacy: () => T;
  /** The store records of this write; built lazily. */
  readonly store: DualWriteBuild;
  readonly context?: DualWriteContext;
  /** Log a store-only failure and continue instead of throwing (hooks). */
  readonly failOpen?: boolean;
  /** Called with a fail-open failure, after it is logged. */
  readonly onFailure?: (error: StoreWriteError) => void;
  /** Store-only predicate options (the switch-record reader). */
  readonly storeOnly?: StoreOnlyOptions;
}

/**
 * Route one write: to the store only on a store-only machine, else to the
 * legacy tree with the phase 1 dual write. See the module docblock.
 */
export function routeWrite<T>(spec: RouteWriteSpec<T>): RoutedWrite<T> {
  const context = spec.context ?? {};
  const mode = storeOnlyMode(
    {
      ...(context.vault !== undefined ? { vault: context.vault } : {}),
      ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
    },
    spec.storeOnly,
  );
  if (!mode.storeOnly) {
    const value = spec.legacy();
    dualWrite(spec.store, context);
    return { mode: "legacy", value };
  }
  try {
    return { mode: "store", records: storeWrite(spec.store, context) };
  } catch (err) {
    const error = asStoreWriteError(err);
    if (spec.failOpen !== true) throw error;
    recordFailOpen(error);
    try {
      spec.onFailure?.(error);
    } catch {
      // the caller's audit must not fail a fail-open path
    }
    return { mode: "store", records: [], failed: error };
  }
}

// ----- Fail-open status -------------------------------------------------------

/** Device-local status file of fail-open store-only failures. */
const STORE_WRITE_STATUS_FILE = "store-write.json";

/** The counters doctor reads for fail-open store-only writes. */
export interface StoreWriteStatus {
  readonly failures: number;
  readonly last_reason: StoreWriteFailure | null;
  readonly last_error: string | null;
  readonly last_failure_at: string | null;
  /**
   * The failures known to concern only the `shared` partition
   * (`failedOnlyInShared` in `dual-write.ts`): the only failure counters a
   * caller below local reach may see; `failures` counts these and every
   * other one.
   */
  readonly shared_failures: number;
  readonly shared_last_error: string | null;
  readonly shared_last_failure_at: string | null;
}

const EMPTY_STATUS: StoreWriteStatus = Object.freeze({
  failures: 0,
  last_reason: null,
  last_error: null,
  last_failure_at: null,
  shared_failures: 0,
  shared_last_error: null,
  shared_last_failure_at: null,
});

/** Path of the fail-open status file: beside the per-store state directories. */
export function storeWriteStatusPath(): string {
  return join(storesStateDir(processDirsEnv()), STORE_WRITE_STATUS_FILE);
}

/** Read the fail-open counters; an absent or unreadable file reads as none. */
export function readStoreWriteStatus(path: string = storeWriteStatusPath()): StoreWriteStatus {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreWriteStatus>;
    return {
      failures: typeof parsed.failures === "number" ? parsed.failures : 0,
      last_reason:
        typeof parsed.last_reason === "string" && Object.hasOwn(REMEDIES, parsed.last_reason)
          ? parsed.last_reason
          : null,
      last_error: typeof parsed.last_error === "string" ? parsed.last_error : null,
      last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
      shared_failures: typeof parsed.shared_failures === "number" ? parsed.shared_failures : 0,
      shared_last_error:
        typeof parsed.shared_last_error === "string" ? parsed.shared_last_error : null,
      shared_last_failure_at:
        typeof parsed.shared_last_failure_at === "string" ? parsed.shared_last_failure_at : null,
    };
  } catch {
    return EMPTY_STATUS;
  }
}

let warned = false;

function recordFailOpen(error: StoreWriteError): void {
  if (!warned) {
    warned = true;
    try {
      process.stderr.write(
        `Open Second Brain: ${error.message} Later failures in this process are counted, ` +
          "not printed; `o2b brain doctor` reports them.\n",
      );
    } catch {
      // stderr closed: nothing left to tell
    }
  }
  const shared = failedOnlyInShared(error);
  try {
    const path = storeWriteStatusPath();
    mkdirSync(dirname(path), { recursive: true });
    withLocalLock(path, () => {
      const current = readStoreWriteStatus(path);
      const at = new Date().toISOString();
      const message = error.message.slice(0, 500);
      const next: StoreWriteStatus = {
        failures: current.failures + 1,
        last_reason: error.reason,
        last_error: message,
        last_failure_at: at,
        ...(shared
          ? {
              shared_failures: current.shared_failures + 1,
              shared_last_error: message,
              shared_last_failure_at: at,
            }
          : {
              shared_failures: current.shared_failures,
              shared_last_error: current.shared_last_error,
              shared_last_failure_at: current.shared_last_failure_at,
            }),
      };
      atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    });
  } catch {
    // The counter is diagnostics; failing to keep it must not fail anything.
  }
}
