/**
 * Signal lifecycle writes (design D14 item 5, task 2.10): the one place a
 * signal's move between inbox folders, or a change of its frontmatter
 * after capture, becomes a `signal-state` record (`../store/fold-signals.ts`).
 *
 * Every lifecycle writer (the dream pass consuming and archiving signals,
 * `retireSignal`, the approval lane, `setExpiration`, the `authored_at`
 * backfill) hands its legacy file move and the state it means to
 * {@link routeSignalState}:
 *
 *  - on a store-only machine the record goes to the store only and the
 *    legacy move never runs, so nothing under `Brain/` changes;
 *  - on an unswitched machine the legacy move runs and the record is
 *    dual-written behind the flag, as every phase 1 writer does.
 *
 * Privacy: one verdict per operation. The signal's own privacy (its page
 * on an unswitched machine, its records in the store once switched) and
 * the fields the record carries are judged once; the verdict runs as the
 * operation's ambient scope, so the log event the writer appends lands in
 * the same partition as the state record.
 */

import { STORE_PARTITIONS, type Authority, type StorePartition } from "../store/constants.ts";
import { authorityFromOrigin, type DualWriteRecord } from "../store/dual-write.ts";
import { isPrivateFrontmatter } from "../store/dual-write-records.ts";
import {
  foldSignals,
  SIGNAL_REMOVED_KIND,
  SIGNAL_STATE_KIND,
  type SignalStateValue,
} from "../store/fold-signals.ts";
import { operationPrivacy, SIGNAL_OPAQUE_FIELDS } from "../store/operation-privacy.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { readStoreEntities, type StoreSignal } from "../store/read/store-entities.ts";
import { protectionStore, StoreUnavailableError } from "../store/read/protection-store.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { routeWrite, storeWrite, StoreWriteError, type RoutedWrite } from "../store/store-write.ts";

/** One lifecycle write of one signal. */
export interface SignalStateWrite<T> {
  /** The vault, or `null` with none (store-only, design D14). */
  readonly vault: string | null;
  readonly id: string;
  /** The move, or absent for a change of fields only. */
  readonly state?: SignalStateValue;
  /** Frontmatter fields the write sets (`null` removes one). */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Who decided; absent derives it from the process's origin channel. */
  readonly authority?: Authority;
  readonly agent?: string;
  readonly configPath?: string;
  /**
   * The signal's frontmatter as the legacy page holds it (or a reader of
   * it, called only when a record is judged, after the legacy move), for
   * the dual write of an unswitched machine. Ignored once switched: the
   * store judges the signal then.
   */
  readonly legacyFrontmatter?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>> | undefined);
  /** The legacy file move; runs only on an unswitched machine. */
  readonly legacy: () => T;
  /** Runs inside the operation's privacy scope after the write (a log event). */
  readonly after?: (routed: RoutedWrite<T>) => void;
}

/** The `signal-state` record of one lifecycle write. */
export function signalStateRecord(input: {
  readonly id: string;
  readonly state?: SignalStateValue;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly authority: Authority;
  readonly agent?: string;
  readonly private: boolean;
}): DualWriteRecord {
  return {
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    ...(input.agent !== undefined && input.agent.trim() !== "" ? { agent: input.agent } : {}),
    private: input.private,
    body: {
      authority: input.authority,
      signal: input.id,
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.fields !== undefined
        ? { fields: JSON.parse(JSON.stringify(input.fields)) as Record<string, unknown> }
        : {}),
    },
  };
}

/** Whether lifecycle writes for `vault` go to the store only. */
export function signalsStoreOnly(vault: string | null, configPath?: string): boolean {
  return isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) });
}

/** The signal `id` as the store's signal fold holds it, or `undefined`. */
export function storeSignal(id: string, configPath?: string): StoreSignal | undefined {
  return readStoreEntities(configPath)?.signals.get(id);
}

/**
 * Route one lifecycle write: the record to the store only on a store-only
 * machine, else the legacy move plus the dual write. See the module
 * docblock.
 */
export function routeSignalState<T>(spec: SignalStateWrite<T>): RoutedWrite<T> {
  const storeOnly = signalsStoreOnly(spec.vault, spec.configPath);
  let legacyMeta: Readonly<Record<string, unknown>> | undefined | null = null;
  const legacyFrontmatter = (): Readonly<Record<string, unknown>> | undefined => {
    if (legacyMeta === null) {
      const given = spec.legacyFrontmatter;
      legacyMeta = typeof given === "function" ? given() : given;
    }
    return legacyMeta;
  };
  const privacy = operationPrivacy(spec.vault, {
    target: () => {
      if (storeOnly) return storeSignal(spec.id, spec.configPath)?.private ?? true;
      const meta = legacyFrontmatter();
      return meta !== undefined && isPrivateFrontmatter(meta);
    },
    // The page's content fields, judged as the signal writer judged them.
    inherit: [
      () =>
        !storeOnly &&
        rowNamesPrivatePage(spec.vault, legacyFrontmatter() ?? null, SIGNAL_OPAQUE_FIELDS),
    ],
    content:
      spec.fields !== undefined ? [{ value: spec.fields, opaque: SIGNAL_OPAQUE_FIELDS }] : [],
  });
  return withOperationPrivacy(privacy, () => {
    const routed = routeWrite({
      legacy: spec.legacy,
      store: () =>
        signalStateRecord({
          id: spec.id,
          ...(spec.state !== undefined ? { state: spec.state } : {}),
          ...(spec.fields !== undefined ? { fields: spec.fields } : {}),
          authority: spec.authority ?? authorityFromOrigin(),
          ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
          private: privacy(),
        }),
      context: {
        vault: spec.vault,
        ...(spec.configPath !== undefined ? { configPath: spec.configPath } : {}),
      },
    });
    spec.after?.(routed);
    return routed;
  });
}

/**
 * Forget the signal `id` in the store (a user's request to forget,
 * `delete-by-source`): a `signal-removed` tombstone in every partition
 * that still shows the signal on its own, so every machine that can see
 * the signal also sees it forgotten (a machine holding only `shared` folds
 * the shared capture until a shared tombstone reaches it), after which the
 * fold drops the signal and its content from every read. A tombstone
 * carries only the id, which a partition holding a record of the signal
 * already holds, so it exposes nothing new there. Store-only machines
 * only: an unswitched machine deletes the page itself. `false` when no
 * partition shows such a signal.
 *
 * One tombstone per partition, so the removal is the documented exception
 * to "one operation, one partition" (FORMAT.md, `signal-removed`). The
 * `shared` one is written first, as it reaches the most machines, and the
 * partitions are judged one by one, not from the combined fold: a removal
 * whose `private` tombstone landed and whose `shared` one failed folds as
 * forgotten here, and a retry still writes the `shared` one.
 */
export function removeStoreSignal(vault: string, id: string, configPath?: string): boolean {
  const signal = storeSignal(id, configPath);
  const partitions = new Set(partitionsShowingSignal(id, configPath));
  if (signal?.private === true && partitions.size > 0) partitions.add("private");
  if (partitions.size === 0) return false;
  const order = [...partitions].toSorted((a, b) =>
    a === b ? 0 : a === "shared" ? -1 : b === "shared" ? 1 : a < b ? -1 : 1,
  );
  for (const partition of order) {
    const isPrivate = partition === "private";
    withOperationPrivacy(isPrivate, () =>
      storeWrite(
        () => ({
          stream: "events",
          kind: SIGNAL_REMOVED_KIND,
          private: isPrivate,
          body: { authority: authorityFromOrigin(), signal: id },
        }),
        { vault, ...(configPath !== undefined ? { configPath } : {}) },
      ),
    );
  }
  return true;
}

/**
 * The held partitions whose own records, folded alone, still show the
 * signal `id`. A partition with an `events` shard that cannot be read, or
 * that is gone since this machine read it, may hold the signal unseen, so
 * the removal refuses (fail closed) rather than leave a copy unforgotten
 * or put a tombstone where the signal never was.
 */
function partitionsShowingSignal(id: string, configPath?: string): StorePartition[] {
  let store: StoreInspection | null;
  try {
    store = protectionStore(configPath, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // The reach-safe twin of the error's message: the raw one can name a
    // held partition's file, and this refusal reaches callers at remote
    // reach.
    throw new StoreWriteError(
      "store-error",
      `the signal ${id} cannot be forgotten: ${err.publicMessage}`,
    );
  }
  if (store === null) return [];
  return STORE_PARTITIONS.filter((partition) => {
    if (!store.partitions.has(partition)) return false;
    const read = readStreamRecords(store.root, partition, { stream: "events" });
    if (read.unreadable.length > 0) {
      // The same publicMessage approach the store-open refusal above
      // takes: this path carries no caller reach, so the private
      // partition's shard paths (which name a device) never go into the
      // message, at any reach. A shared shard names nothing private.
      const listed =
        partition === "private"
          ? `${read.unreadable.length} private events shard${read.unreadable.length === 1 ? "" : "s"}`
          : read.unreadable.map((rel) => `${partition}/${rel}`).join(", ");
      throw new StoreWriteError(
        "store-error",
        `the signal ${id} cannot be forgotten while an events shard cannot be read (${listed})`,
      );
    }
    return foldSignals(read.records).signals.has(id);
  });
}
