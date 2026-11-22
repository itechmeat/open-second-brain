/**
 * The dream owner gate (design D2, spec `dream-ownership` "Only the
 * owner's device runs a live pass"): one check every live dream path
 * runs before it asks a model or writes a record or a file.
 *
 *  - No owner record, a brain whose records still live in the legacy
 *    tree, no store or no device id here: `unbound`, and the caller
 *    behaves as before this capability (design D6).
 *  - A live call on a device that does not hold the `shared` partition,
 *    or whose settings there cannot be read: the owner is unknown, and the
 *    call is refused with {@link DreamNotOwnerError}.
 *  - A preview (a dry run): answered without reading or writing anything.
 *  - A live call on the owner's device: passes, after the owner's device
 *    has released a pending request (then it refuses: the role moved) and
 *    after its own fresh claim has waited one look.
 *  - A live call on any other device: refused with
 *    {@link DreamNotOwnerError} (`dream_not_owner`).
 *
 * The gate is the device: any agent on the owner's device may run the
 * pass, and the pass record names both.
 */

import { readDeviceId, resolveAgentName } from "../../config.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import {
  inspectStore,
  openStore,
  StoreOpenError,
  type StoreHandle,
} from "../../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../../store/store-paths.ts";
import { DREAM_NOT_OWNER_CODE, DREAM_OWNER_HERE_COMMAND } from "./constants.ts";
import type { DreamOwner, DreamOwnerState } from "./fold.ts";
import {
  claimSettled,
  DreamOwnerPartitionUnavailableError,
  DreamOwnerSettingsUnreadableError,
  readDreamOwner,
  releaseIfRequested,
} from "./owner.ts";

/** Why a live pass was refused. */
export type DreamNotOwnerReason =
  | "elsewhere"
  | "released"
  | "unsettled"
  | "unreadable"
  | "partition-unavailable"
  | "ownership-changed";

/** A live dream pass refused on a device that does not hold the role. */
export class DreamNotOwnerError extends Error {
  readonly code = DREAM_NOT_OWNER_CODE;
  readonly reason: DreamNotOwnerReason;
  readonly owner: { readonly device: string; readonly agent: string } | null;
  readonly device: string;

  constructor(
    reason: DreamNotOwnerReason,
    owner: DreamOwner | null,
    device: string,
    mine: boolean,
    state?: string,
  ) {
    super(notOwnerMessage(reason, owner, device, mine, state));
    this.name = "DreamNotOwnerError";
    this.reason = reason;
    this.owner = owner === null ? null : { device: owner.device, agent: owner.agent };
    this.device = device;
  }
}

function notOwnerMessage(
  reason: DreamNotOwnerReason,
  owner: DreamOwner | null,
  device: string,
  mine: boolean,
  state?: string,
): string {
  if (reason === "partition-unavailable") {
    return (
      `dream: this device (${device}) refused the live pass because it does not hold the ` +
      "shared partition the dream owner is read from, so the owner is unknown here; " +
      "previews still run"
    );
  }
  if (reason === "unreadable") {
    return (
      `dream: this device (${device}) refused the live pass because the settings state the ` +
      `dream owner is read from is unreadable (${state}); previews still run`
    );
  }
  if (reason === "ownership-changed") {
    const now =
      owner === null
        ? "no device holds it now"
        : `the dream owner is now ${owner.device} (agent ${owner.agent})`;
    return (
      `dream: this device (${device}) refused the live pass because the dream owner role ` +
      `moved while the pass lock was being taken; ${now}`
    );
  }
  if (reason === "unsettled") {
    return (
      `dream: this device (${device}) took the dream owner role by its own claim, which waits ` +
      "one catch-up so a rival claim still in transit can arrive; run the pass again"
    );
  }
  const where =
    owner === null
      ? "no device holds the dream owner role"
      : `the dream owner is ${owner.device} (agent ${owner.agent})`;
  const lead =
    reason === "released"
      ? `dream: this device (${device}) has just handed the dream owner role over; ${where}`
      : `dream: this device (${device}) is not the dream owner; ${where}`;
  const next = mine
    ? "your request for the role is pending until that device releases it"
    : `run live passes there, or move the role here with \`${DREAM_OWNER_HERE_COMMAND}\``;
  return `${lead}; ${next}`;
}

/** Where this machine's brain records live, for the role. */
export type DreamOwnerStore =
  | { readonly store: StoreHandle }
  | { readonly store: null; readonly reason: "legacy-tree" | "no-store" | "no-device" };

/**
 * The store that holds the role for `vault` on this machine, or why there
 * is none: a vault whose brain is still in the legacy tree has no shared
 * partition to hold it (design D6).
 */
export function openDreamOwnerStore(
  vault: string | null,
  configPath: string | undefined,
): DreamOwnerStore {
  const context = { vault, ...(configPath !== undefined ? { configPath } : {}) };
  if (vault !== null && !isStoreOnly(context)) return { store: null, reason: "legacy-tree" };
  const { root } = resolveConfiguredStoreRoot(configPath);
  if (inspectStore(root) === null) return { store: null, reason: "no-store" };
  const device = readDeviceId(configPath ?? null);
  if (device === null) return { store: null, reason: "no-device" };
  try {
    return { store: openStore({ root, device }) };
  } catch (err) {
    if (err instanceof StoreOpenError) return { store: null, reason: "no-store" };
    throw err;
  }
}

export interface DreamOwnerGateOptions {
  /** A live pass (writes); `false` for a preview. */
  readonly live: boolean;
  readonly configPath?: string;
  readonly now?: () => number;
}

export type DreamOwnerGate =
  | { readonly status: "preview" }
  | { readonly status: "unbound"; readonly store: StoreHandle | null }
  | {
      readonly status: "owner";
      readonly owner: DreamOwner;
      readonly device: string;
      /** The store the role lives in: the pass lock is taken there. */
      readonly store: StoreHandle;
    };

/**
 * Look at the role (the owner's device hands a pending request over) and
 * report what this device is. The look is the "catch-up" of the claim
 * settle rule: the gate, the status command and the background
 * maintenance run it.
 */
export function lookAtDreamOwner(
  store: StoreHandle,
  options: { readonly configPath?: string; readonly now?: () => number },
): { readonly state: DreamOwnerState; readonly released: string | null; settled: boolean } {
  const writer = { writer: resolveAgentName(options.configPath), ...nowOf(options) };
  const state = readDreamOwner(store, options.now);
  const released = releaseIfRequested(store, state, writer);
  const current = readDreamOwner(store, options.now);
  const settled = current.owner?.device === store.device ? claimSettled(store, current) : true;
  return { state: current, released, settled };
}

function nowOf(options: { readonly now?: () => number }): { now?: () => number } {
  return options.now !== undefined ? { now: options.now } : {};
}

/**
 * The look the background maintenance takes at session start and at MCP
 * server start (design D3, `src/core/maintenance/ensure-current.ts`): on
 * the owner's device it hands a pending request over (never during a pass:
 * the release waits for the pass lock) and notes its own fresh claim.
 * Returns the device the role went to, or `null`. Writes nothing on any
 * other device.
 */
export function maintainDreamOwner(
  vault: string | null,
  configPath: string | undefined,
): string | null {
  const opened = openDreamOwnerStore(vault, configPath);
  if (opened.store === null) return null;
  const store = opened.store;
  // Without the shared partition this device cannot be the owner it knows
  // of, and has nothing to hand over: the live gate refuses there instead.
  if (!store.partitions.has("shared")) return null;
  if (readDreamOwner(store).owner?.device !== store.device) return null;
  return lookAtDreamOwner(store, configPath !== undefined ? { configPath } : {}).released;
}

/** The refusal a live pass gets when the owner could not be read here, or `err` as it is. */
function unknownOwner(err: unknown, device: string): unknown {
  if (err instanceof DreamOwnerPartitionUnavailableError) {
    return new DreamNotOwnerError("partition-unavailable", null, device, false);
  }
  if (err instanceof DreamOwnerSettingsUnreadableError) {
    return new DreamNotOwnerError("unreadable", null, device, false, err.state);
  }
  return err;
}

/**
 * The gate. Throws {@link DreamNotOwnerError} for a live call on a device
 * that may not run one; otherwise reports what it found.
 */
export function assertDreamOwner(
  vault: string | null,
  options: DreamOwnerGateOptions,
): DreamOwnerGate {
  if (!options.live) return { status: "preview" };
  const opened = openDreamOwnerStore(vault, options.configPath);
  if (opened.store === null) return { status: "unbound", store: null };
  const store = opened.store;
  let look: ReturnType<typeof lookAtDreamOwner>;
  try {
    look = lookAtDreamOwner(store, options);
  } catch (err) {
    throw unknownOwner(err, store.device);
  }
  const owner = look.state.owner;
  if (owner === null) return { status: "unbound", store };
  if (look.released !== null) throw new DreamNotOwnerError("released", owner, store.device, false);
  if (owner.device !== store.device) {
    const mine = look.state.pending?.device === store.device;
    throw new DreamNotOwnerError("elsewhere", owner, store.device, mine);
  }
  if (!look.settled) throw new DreamNotOwnerError("unsettled", owner, store.device, false);
  return { status: "owner", owner, device: store.device, store };
}

/** Recheck a known-unbound store under the pass lock before a live write. */
export function recheckUnboundDreamOwner(store: StoreHandle, now?: () => number): void {
  let state: DreamOwnerState;
  try {
    state = readDreamOwner(store, now);
  } catch (err) {
    throw unknownOwner(err, store.device);
  }
  if (state.owner !== null) {
    throw new DreamNotOwnerError("ownership-changed", state.owner, store.device, false);
  }
}

/**
 * The second look a live pass takes once it holds the pass lock: a release
 * written between the gate and the lock moved the role, so the pass must
 * not run on the stale answer. It also settles a new same-device claim
 * seen between the gate and the lock before deciding whether this pass may
 * run.
 */
export function recheckDreamOwner(
  gate: Extract<DreamOwnerGate, { status: "owner" }>,
  now?: () => number,
): DreamOwner {
  let state: DreamOwnerState;
  try {
    state = readDreamOwner(gate.store, now);
  } catch (err) {
    throw unknownOwner(err, gate.device);
  }
  const owner = state.owner;
  if (owner === null || owner.device !== gate.device) {
    throw new DreamNotOwnerError("ownership-changed", owner, gate.device, false);
  }
  if (
    owner.revision !== gate.owner.revision &&
    state.via === "claim" &&
    !claimSettled(gate.store, state)
  ) {
    throw new DreamNotOwnerError("unsettled", owner, gate.device, false);
  }
  return owner;
}
