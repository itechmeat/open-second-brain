/**
 * The store's memory entities as this machine holds them (design D4,
 * D14 items 1 and 18, task 2.10): the preference fold, the captured
 * signals and the pinned registers, read from the `events` stream of
 * every partition this machine holds, each entity tagged with whether it
 * is private.
 *
 * One read serves the read facades (`./preferences.ts`, `./signals.ts`,
 * `./pinned.ts`) and the store-backed privacy judge
 * (`../store-privacy.ts`). It is cached per store root and re-read only
 * when an `events` shard of a held partition appears, grows or changes,
 * so a writer operation that judges many references reads the store once.
 * A read that left out a record whose body is a pending blob is cached
 * against the availability of every blob it skipped (`pendingBlobs`): the
 * stamp moves the moment a blob arrives, so the read is rebuilt then, and
 * it stays cached while every one is absent.
 *
 * Signals fold their `signal` and `signal-state` records
 * (`../fold-signals.ts`), so a reader tells an inbox signal from a
 * consumed, archived or retired one.
 *
 * Privacy (FORMAT.md, "Partitions"): an entity is private when any of
 * its records sits in `private`, or when its fields reserve it as private
 * by the rule every legacy page uses (`isPrivateFrontmatter`). Nothing is
 * written.
 */

import { statSync } from "node:fs";

import {
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
  type StorePartition,
} from "../constants.ts";
import { isPrivateFrontmatter } from "../private-page.ts";
import type { StoreRecord } from "../envelope.ts";
import { foldPinned, type PinnedFold } from "../fold-pinned.ts";
import {
  foldSignals,
  SIGNAL_REMOVED_KIND,
  SIGNAL_STATE_KIND,
  type SignalLifecycle,
} from "../fold-signals.ts";
import { foldPreferences, type PreferenceState } from "../fold-preferences.ts";
import { listShards } from "../shard-list.ts";
import { inspectStore, type StoreInspection } from "../store-open.ts";
import { partitionDir, pendingBlobStampLines, resolveConfiguredStoreRoot } from "../store-paths.ts";
import { readStreamRecords } from "./stream-read.ts";
import { quarantineStamp } from "../shard-quarantine.ts";

/** One preference of the fold, with its privacy. */
export interface StorePreference {
  readonly state: PreferenceState;
  readonly private: boolean;
}

/**
 * One captured signal: its latest `signal` record, its lifecycle state and
 * current frontmatter from the signal fold (`../fold-signals.ts`), with
 * its privacy.
 */
export interface StoreSignal {
  readonly record: StoreRecord;
  readonly partition: StorePartition;
  readonly private: boolean;
  readonly state: SignalLifecycle;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Every record of the signal in fold order (captures, state moves, field patches). */
  readonly history: ReadonlyArray<StoreRecord>;
  /** The partitions holding any record of the signal. */
  readonly partitions: ReadonlySet<StorePartition>;
}

/** Everything {@link readStoreEntities} found. */
export interface StoreEntities {
  readonly store: StoreInspection;
  readonly preferences: ReadonlyMap<string, StorePreference>;
  readonly signals: ReadonlyMap<string, StoreSignal>;
  /** The pinned register of each held partition. */
  readonly pinned: ReadonlyMap<StorePartition, PinnedFold>;
  /** Partition-relative paths of `events` shards that could not be read. */
  readonly unreadable: ReadonlyArray<string>;
  /** Whether a record was left out because its body is a pending blob. */
  readonly skippedPending: boolean;
  /**
   * `<partition>/<sha>` of every blob a skipped pending record's body
   * still references (the identities the cache fingerprints against, one
   * stat each, instead of rescanning the shards).
   */
  readonly pendingBlobs: ReadonlyArray<string>;
}

interface Cached {
  readonly fingerprint: string;
  readonly entities: StoreEntities;
}

const cache = new Map<string, Cached>();

const EVENTS = { stream: "events" } as const;

/**
 * What a read depends on: every `events` shard and the quarantine ledger,
 * which decides whether a shard reads whole without changing its bytes.
 * The availability of the blobs a read skipped is stamped when the read is
 * stored (`pendingBlobStampLines`), so the stored stamp moves the moment
 * one is delivered and stays put while it is absent.
 */
function fingerprintOf(store: StoreInspection): string {
  const parts: string[] = [store.storeId, `quarantine=${quarantineStamp(store.root)}`];
  for (const partition of [...store.partitions].toSorted()) {
    let shards: ReturnType<typeof listShards>;
    try {
      shards = listShards(partitionDir(store.root, partition), EVENTS);
    } catch {
      // Unlistable now: a stamp that never matches, so the read below runs
      // (and reports the folder) instead of a throw out of every facade.
      parts.push(`${partition}=unlisted:${Date.now()}:${Math.random()}`);
      continue;
    }
    for (const shard of shards) {
      let stamp = "missing";
      try {
        const stat = statSync(shard.path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        // a shard removed between the listing and the stat reads as changed
      }
      parts.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return parts.join("\n");
}

function signalIsPrivate(record: StoreRecord, partition: StorePartition): boolean {
  if (partition === "private") return true;
  const frontmatter = record.body["frontmatter"];
  return (
    typeof frontmatter === "object" &&
    frontmatter !== null &&
    !Array.isArray(frontmatter) &&
    isPrivateFrontmatter(frontmatter as Record<string, unknown>)
  );
}

function build(store: StoreInspection): StoreEntities {
  const all: Array<{ record: StoreRecord; partition: StorePartition }> = [];
  const unreadable: string[] = [];
  const pinned = new Map<StorePartition, PinnedFold>();
  let skippedPending = false;
  const pendingBlobs: string[] = [];
  for (const partition of store.partitions) {
    const read = readStreamRecords(store.root, partition, EVENTS);
    if (read.skippedPending) skippedPending = true;
    for (const sha of read.pendingBlobs) pendingBlobs.push(`${partition}/${sha}`);
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const record of read.records) all.push({ record, partition });
    pinned.set(
      partition,
      foldPinned(
        read.records.filter((r) => r.kind === PINNED_SET_KIND || r.kind === PINNED_CLEAR_KIND),
      ),
    );
  }
  // A shard this read skipped may hold the record that makes an entity
  // private, so while any is unreadable every entity counts as private
  // (fail closed).
  const degraded = unreadable.length > 0;
  const privateIds = new Set(all.filter((e) => e.partition === "private").map((e) => e.record.id));
  const fold = foldPreferences(all.map((e) => e.record));
  const preferences = new Map<string, StorePreference>();
  for (const [id, state] of fold.preferences) {
    const inPrivate = state.history.some((record) => privateIds.has(record.id));
    // A removed preference's fold holds no fields, so its history is what
    // still says whether it was marked private.
    const markedPrivate = state.removed
      ? state.history.some(
          (record) =>
            record.kind === PREFERENCE_SET_KIND &&
            isPrivateFrontmatter((record.body["fields"] ?? {}) as Record<string, unknown>),
        )
      : isPrivateFrontmatter(state.fields);
    preferences.set(id, { state, private: degraded || inPrivate || markedPrivate });
  }
  const signals = new Map<string, StoreSignal>();
  const partitionOf = new Map(all.map((e) => [e.record.id, e.partition] as const));
  const signalFold = foldSignals(
    all
      .filter(
        (e) =>
          e.record.kind === SIGNAL_KIND ||
          e.record.kind === SIGNAL_STATE_KIND ||
          e.record.kind === SIGNAL_REMOVED_KIND,
      )
      .map((e) => e.record),
  );
  for (const [id, entry] of signalFold.signals) {
    const partition = partitionOf.get(entry.signal.id) ?? "shared";
    const isPrivate =
      entry.history.some((record) => privateIds.has(record.id)) ||
      entry.history.some(
        (record) =>
          record.kind === SIGNAL_KIND &&
          signalIsPrivate(record, partitionOf.get(record.id) ?? "shared"),
      ) ||
      isPrivateFrontmatter(entry.frontmatter as Record<string, unknown>);
    signals.set(id, {
      record: entry.signal,
      partition,
      private: degraded || isPrivate,
      state: entry.state,
      frontmatter: entry.frontmatter,
      history: entry.history,
      partitions: new Set(entry.history.map((r) => partitionOf.get(r.id) ?? "shared")),
    });
  }
  return {
    store,
    preferences,
    signals,
    pinned,
    unreadable,
    skippedPending,
    pendingBlobs,
  };
}

/** The entities of the store at `store.root`, cached until an `events` shard changes. */
export function readEntitiesOf(store: StoreInspection): StoreEntities {
  const cached = cache.get(store.root);
  // The stamp a stored read must still match: the shard part plus the
  // availability of the blobs that read skipped (one stat each, no shard
  // is read). A read whose stored stamp lists no blob lines is uncached.
  const cachedLines =
    cached === undefined ? null : pendingBlobStampLines(store.root, cached.entities.pendingBlobs);
  const shardStamp = fingerprintOf(store);
  const fingerprint = cachedLines === null ? null : `${shardStamp}\n${cachedLines}`;
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached.entities;
  const entities = build(store);
  // A shard unreadable for a moment (a Windows sharing violation) keeps its
  // size and mtime, so a cached incomplete read would never be retried, and
  // an incomplete read is never cached. The read is cached against the
  // availability of every blob it skipped, stamped now: a blob absent after
  // the build was absent during it, so the skip was correct and those lines
  // belong with the shard part (a quarantined pending blob opens no gap, so
  // it is not in `unreadable`). A blob present after the build arrived
  // during it, or is there but refused, so the read is left uncached and
  // rebuilt on the next read.
  const blobLines = pendingBlobStampLines(store.root, entities.pendingBlobs);
  if (entities.unreadable.length === 0 && blobLines !== null)
    cache.set(store.root, { fingerprint: `${shardStamp}\n${blobLines}`, entities });
  else cache.delete(store.root);
  return entities;
}

/**
 * The configured store, read-only, or `null` when there is none or it
 * cannot be read (a broken identity file, partitions of two stores).
 */
export function configuredStore(configPath?: string): StoreInspection | null {
  try {
    return inspectStore(resolveConfiguredStoreRoot(configPath).root);
  } catch {
    return null;
  }
}

/** The entities of the configured store, or `null` when no store can be read. */
export function readStoreEntities(configPath?: string): StoreEntities | null {
  const store = configuredStore(configPath);
  return store === null ? null : readEntitiesOf(store);
}
