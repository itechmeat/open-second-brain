/**
 * The configured store as a protection reader opens it (design D14, fail
 * closed). `configuredStore` answers `null` both when there is no store
 * and when the store cannot be opened (`store.json` missing or corrupt,
 * partitions of two stores), and display readers read that as "the store
 * holds nothing". A reader that decides a protection (the permissions
 * document, the brain settings behind the capture boundary, the human
 * authority of a setting, a privacy partition, the decision ledger,
 * attestations) must not: on a machine switched to the store, the rules
 * live only there, and the sticky switch keeps the legacy files from
 * standing in. There a store that cannot be opened, or that no longer
 * shows its `shared` partition (where every rule lives), throws
 * {@link StoreUnavailableError}, and the caller fails closed with its own
 * error. A machine the marker does not name switched gets the plain
 * answer: no store, nothing stored.
 *
 * A partition this machine has held that lost its identity file
 * (`held-ledger.ts`) is the same failure, and is one on every store-only
 * machine (switched, or with no legacy tree): the store as it shows would
 * read without that partition, so a private lane entry would look shared.
 * Only a machine that still writes its legacy tree reads "no store" there,
 * as for any store it cannot open; its store writes refuse on their own.
 */

import { isStoreOnly, markedSwitched } from "../store-only.ts";
import { HeldPartitionLostError, inspectStore, type StoreInspection } from "../store-open.ts";
import { resolveConfiguredStoreRoot } from "../store-paths.ts";

/**
 * The store of a switched machine cannot be opened, so its rules are
 * unknown. `root` is the store root the open failed for, when it was
 * resolved before the failure. `message` carries the raw cause (it can
 * name a held partition's file, so only a caller at local reach may show
 * it); `publicMessage` is the same sentence with the cause replaced, and
 * `safeDetail` is the redacted detail the doctor's findings carry below
 * local reach (`storeOpenFailureDetail` in the doctor's store check) -
 * neither names a partition's file, the store ids or the leave remedy, so
 * any consumer may embed them in what it hands a caller at remote reach.
 */
export class StoreUnavailableError extends Error {
  override readonly name = "StoreUnavailableError";
  constructor(
    message: string,
    readonly root: string | null = null,
    readonly publicMessage: string = message,
    readonly safeDetail: string = "",
  ) {
    super(message);
  }
}

const DETAIL_TAIL =
  ", so every protection fails closed. Run `o2b brain doctor` on this machine " +
  "for the cause and the remedy";

function unavailable(
  reason: string,
  switched: boolean,
  root: string | null,
  safeReason: string,
  safeDetail: string,
): StoreUnavailableError {
  const frame = (cause: string): string =>
    `this machine ${switched ? "switched to" : "writes to"} the brain store and ${cause}; the ` +
    "rules stored there are unknown until it opens again. Run `o2b brain doctor`";
  return new StoreUnavailableError(frame(reason), root, frame(safeReason), safeDetail);
}

/** The store-open cause, phrased for a caller this machine does not trust. */
function openSafe(root: string | null): { safeReason: string; safeDetail: string } {
  const at = root === null ? "" : ` at ${root}`;
  return {
    safeReason: `the store${at} could not be opened`,
    safeDetail: `the brain store${at} could not be opened${DETAIL_TAIL}`,
  };
}

/**
 * The configured store for a protection decision: the store, or `null`
 * when this machine has none and is not switched to one. Throws
 * {@link StoreUnavailableError} on a switched machine whose store cannot
 * be opened, or (with `needShared`) does not show its `shared` partition.
 * With `openErrorFails`, a store that exists but cannot be opened (a
 * corrupt `store.json`) throws on any store-only machine, switched or not:
 * a reader that must know its answer is whole (an export) cannot read
 * "no store" there.
 */
export function protectionStore(
  configPath?: string,
  options: {
    readonly needShared?: boolean;
    readonly openErrorFails?: boolean;
    /** The vault the caller reads for, when it is not the configured one. */
    readonly vault?: string | null;
  } = {},
): StoreInspection | null {
  let store: StoreInspection | null = null;
  let reason = "";
  let safeReason = "";
  let safeDetail = "";
  let lost = false;
  let openError = false;
  let root: string | null = null;
  try {
    const resolved = resolveConfiguredStoreRoot(configPath);
    root = resolved.root;
    store = inspectStore(resolved.root);
    if (store === null) {
      reason = `the store at ${root} cannot be found (no store.json)`;
      safeReason = reason;
      safeDetail = `the brain store at ${root} cannot be found (no store.json)${DETAIL_TAIL}`;
    }
  } catch (err) {
    lost = err instanceof HeldPartitionLostError;
    openError = true;
    reason = `the store cannot be opened (${(err as Error).message})`;
    ({ safeReason, safeDetail } = openSafe(root));
  }
  const context = configPath !== undefined ? { configPath } : {};
  const switched = (): boolean => markedSwitched(context);
  if (store === null) {
    if (switched()) throw unavailable(reason, true, root, safeReason, safeDetail);
    const storeOnly = (): boolean =>
      isStoreOnly(options.vault !== undefined ? { ...context, vault: options.vault } : context);
    if ((lost || (openError && options.openErrorFails === true)) && storeOnly()) {
      throw unavailable(reason, false, root, safeReason, safeDetail);
    }
    return null;
  }
  if (options.needShared === true && !store.partitions.has("shared") && switched()) {
    const sharedReason = `the shared partition of the store at ${store.root} cannot be found`;
    throw unavailable(
      sharedReason,
      true,
      store.root,
      sharedReason,
      `the shared partition of the brain store at ${store.root} cannot be found${DETAIL_TAIL}`,
    );
  }
  return store;
}

/** {@link protectionStore} as a boolean: whether a switched machine's store is unavailable. */
export function protectionStoreUnavailable(configPath?: string): StoreUnavailableError | null {
  try {
    protectionStore(configPath, { needShared: true });
    return null;
  } catch (err) {
    if (err instanceof StoreUnavailableError) return err;
    throw err;
  }
}
