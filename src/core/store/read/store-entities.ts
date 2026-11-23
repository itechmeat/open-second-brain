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
 * by the rule every legacy page uses (`isPrivateFrontmatter`). A
 * preference's `preference-evidence` records do not count for it: one
 * lands in `private` because its artifact or note names a private page,
 * which says nothing about the rule itself, and counting it would move a
 * shared preference into `private` on its first such use (task 3.18).
 * Nothing is written.
 */

import { lstatSync, statSync } from "node:fs";

import { identityOfStats, sameDevIno } from "../../fs-identity.ts";

import {
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  EVIDENCE_RESULTS,
  PREFERENCE_COUNTER_FIELDS,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
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
import {
  foldPreferences,
  type PreferenceCounters,
  type PreferenceState,
} from "../fold-preferences.ts";
import { privateWithheld } from "../caller-reach.ts";
import { listShards } from "../shard-list.ts";
import { inspectStore, type StoreInspection } from "../store-open.ts";
import { partitionDir, pendingBlobStampLines, resolveConfiguredStoreRoot } from "../store-paths.ts";
import { readStreamRecords, type ShardTails } from "./stream-read.ts";
import {
  activeStoreReadView,
  eventTimeOf,
  effectiveTimeOf,
  type StoreReadView,
} from "./read-view.ts";
import { readStreamViewed } from "./viewed-read.ts";
import { appendedByThisProcess, type AppendStamp } from "../own-appends.ts";
import { quarantineStamp } from "../shard-quarantine.ts";

/** One preference of the fold, with its privacy. */
export interface StorePreference {
  readonly state: PreferenceState;
  readonly private: boolean;
  /**
   * The evidence counters without the evidence of the `private` partition:
   * what a machine that holds only `shared` folds, and what a caller below
   * local reach is shown ({@link countersAtReach}).
   */
  readonly sharedCounters: PreferenceCounters;
  /** Ids of the records of {@link PreferenceState.history} that sit in `private`. */
  readonly privateRecordIds: ReadonlySet<string>;
}

/**
 * The evidence counters of `entry` for the caller of the work running now:
 * the shared counters below local reach (`../caller-reach.ts`), every held
 * partition's otherwise (task 3.18).
 */
export function countersAtReach(entry: StorePreference): PreferenceCounters {
  return privateWithheld() ? entry.sharedCounters : entry.state.counters;
}

/**
 * The evidence counters that may be written into a record about `entry`
 * other machines read (a merge summary, a dream comparison): every held
 * partition's for a private preference, the shared ones otherwise, so a
 * private use never reaches `shared` through a derived number (task 3.18).
 */
export function countersForShared(entry: StorePreference): PreferenceCounters {
  return entry.private ? entry.state.counters : entry.sharedCounters;
}

/** The counters of `history`'s evidence records that are not in `privateIds`. */
function sharedCountersOf(
  history: ReadonlyArray<StoreRecord>,
  privateIds: ReadonlySet<string>,
): PreferenceCounters {
  const out = Object.fromEntries(PREFERENCE_COUNTER_FIELDS.map((name) => [name, 0])) as Record<
    (typeof PREFERENCE_COUNTER_FIELDS)[number],
    number
  >;
  for (const record of history) {
    if (record.kind !== PREFERENCE_EVIDENCE_KIND || privateIds.has(record.id)) continue;
    const result = record.body["result"];
    if (
      typeof result === "string" &&
      (EVIDENCE_RESULTS as ReadonlyArray<string>).includes(result)
    ) {
      out[`${result}_count` as (typeof PREFERENCE_COUNTER_FIELDS)[number]] += 1;
    }
  }
  return out;
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
  /**
   * How many signal lifecycle records (`signal-state`, `signal-removed`)
   * this read left out of the signal fold because their body is a pending
   * blob, quarantined or not. Such a body names its signal, so while any
   * is counted no signal's state is known for certain. It comes from the
   * scan that built `signals`, so the two always describe one read.
   */
  readonly pendingSignalLifecycle: number;
  /**
   * Read through a window's view only (`read-view.ts`): signal id to the
   * time the window judges the signal by, for the signals whose capture
   * the admission gave another time than their own `created_at`.
   */
  readonly signalTimes?: ReadonlyMap<string, string>;
}

interface Cached {
  readonly fingerprint: string;
  readonly entities: StoreEntities;
}

const cache = new Map<string, Cached>();

/**
 * The `events` shards each store's reads kept, by store root, then by
 * partition (`stream-read.ts` `ShardTails`): a rebuild after this process
 * appended a record (a dream pass retires, moves and refreshes hundreds of
 * entities, each append moving the fingerprint) parses only the appended
 * lines instead of the whole stream. Kept for one quarantine stamp: a
 * quarantine that changes may change what a shard reads as.
 */
const tailsByRoot = new Map<
  string,
  { readonly quarantine: string; readonly tails: Map<StorePartition, ShardTails> }
>();

function tailsOf(store: StoreInspection, partition: StorePartition): ShardTails {
  const quarantine = quarantineStamp(store.root);
  let held = tailsByRoot.get(store.root);
  if (held === undefined || held.quarantine !== quarantine) {
    held = { quarantine, tails: new Map() };
    tailsByRoot.set(store.root, held);
  }
  let tails = held.tails.get(partition);
  if (tails === undefined) {
    tails = new Map();
    held.tails.set(partition, tails);
  }
  return tails;
}

const EVENTS = { stream: "events" } as const;

/**
 * The kinds the entity folds read (preferences, signals, the pinned
 * context). The `events` stream also holds lane entries, corrections and
 * attestations, which other folds read; the read keeps only these, so the
 * fold and its kept tails hold no record they do not use.
 */
const ENTITY_KINDS: ReadonlySet<string> = new Set([
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
  PINNED_SET_KIND,
  PINNED_CLEAR_KIND,
]);

function isEntityRecord(record: StoreRecord): boolean {
  return ENTITY_KINDS.has(record.kind);
}

/**
 * What a read depends on: every `events` shard and the quarantine ledger,
 * which decides whether a shard reads whole without changing its bytes.
 * The availability of the blobs a read skipped is stamped when the read is
 * stored (`pendingBlobStampLines`), so the stored stamp moves the moment
 * one is delivered and stays put while it is absent.
 */
function fingerprintOf(store: StoreInspection): string {
  // The held partitions too: one whose identity file appears with no
  // `events` shard yet changes no shard stamp, and the entities name the
  // partitions they were read from (`store.partitions`).
  const parts: string[] = [
    store.storeId,
    `partitions=${[...store.partitions].toSorted().join(",")}`,
    `quarantine=${quarantineStamp(store.root)}`,
  ];
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
        stamp = shardFileStamp(shard.path);
      } catch {
        // a shard removed between the listing and the stat reads as changed
      }
      parts.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return parts.join("\n");
}

/**
 * A shard file's identity and contents stamp: device, inode, size, and the
 * modification and change times, all at full precision. A shard replaced
 * by a file of the same size and modification time (a sync tool that
 * keeps the mtime) has another inode, and its change time cannot be set
 * back, so the stamp moves and the cache is rebuilt. The identity is the
 * one `fs-identity.ts` gives; a filesystem that reports no inode stamps
 * none, and the change time still moves on a replacement.
 */
function shardFileStamp(path: string): string {
  const s = statSync(path, { bigint: true });
  const id = identityOfStats(s);
  const identity = id === null ? "no-identity" : `${id.dev}:${id.ino}`;
  return `${identity}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
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

/**
 * A boundary for an entity read: per partition, the byte limit of each
 * `events` shard (`./shards-from.ts` `untilOf`). A shard it does not name
 * is not read.
 */
export type StoreReadLimit = ReadonlyMap<StorePartition, ReadonlyMap<string, number>>;

/** What an entity read takes. */
export interface StoreEntitiesOptions {
  readonly checkpoint?: () => void;
  /**
   * Read only up to this boundary. Such a read is built fresh every time:
   * it neither answers from nor replaces the one cached read per store
   * root, and uses no kept tails, so a pass reading many boundaries does
   * not thrash the cache other readers rely on.
   */
  readonly until?: StoreReadLimit;
}

function build(
  store: StoreInspection,
  checkpoint?: () => void,
  until?: StoreReadLimit,
  view?: StoreReadView,
): StoreEntities {
  const all: Array<{ record: StoreRecord; partition: StorePartition }> = [];
  const unreadable: string[] = [];
  const pinned = new Map<StorePartition, PinnedFold>();
  let skippedPending = false;
  const pendingBlobs: string[] = [];
  let pendingSignalLifecycle = 0;
  for (const partition of store.partitions) {
    const read =
      view !== undefined
        ? readStreamViewed(store.root, partition, EVENTS, view, {
            keep: isEntityRecord,
            cacheKey: "entities",
            ...(checkpoint !== undefined ? { checkpoint } : {}),
          })
        : readStreamRecords(store.root, partition, EVENTS, {
            ...(until === undefined
              ? { tails: tailsOf(store, partition) }
              : { until: until.get(partition) ?? new Map<string, number>() }),
            keep: isEntityRecord,
            ...(checkpoint !== undefined ? { checkpoint } : {}),
          });
    if (read.skippedPending) skippedPending = true;
    for (const sha of read.pendingBlobs) pendingBlobs.push(`${partition}/${sha}`);
    pendingSignalLifecycle +=
      (read.pendingKinds.get(SIGNAL_STATE_KIND) ?? 0) +
      (read.pendingKinds.get(SIGNAL_REMOVED_KIND) ?? 0);
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
    const inPrivate = state.history.some(
      (record) => privateIds.has(record.id) && record.kind !== PREFERENCE_EVIDENCE_KIND,
    );
    // A removed preference's fold holds no fields, so its history is what
    // still says whether it was marked private.
    const markedPrivate = state.removed
      ? state.history.some(
          (record) =>
            record.kind === PREFERENCE_SET_KIND &&
            isPrivateFrontmatter((record.body["fields"] ?? {}) as Record<string, unknown>),
        )
      : isPrivateFrontmatter(state.fields);
    preferences.set(id, {
      state,
      private: degraded || inPrivate || markedPrivate,
      sharedCounters: sharedCountersOf(state.history, privateIds),
      privateRecordIds: new Set(
        state.history.filter((record) => privateIds.has(record.id)).map((record) => record.id),
      ),
    });
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
    pendingSignalLifecycle,
    ...(view !== undefined ? { signalTimes: signalTimesOf(signalFold.signals, view) } : {}),
  };
}

/**
 * The time each signal is judged by in the view's window: the effective
 * time of its first capture, when the admission gave it one other than its
 * own `created_at` (a late or a clamped record).
 */
function signalTimesOf(
  signals: ReadonlyMap<string, { readonly history: ReadonlyArray<StoreRecord> }>,
  view: StoreReadView,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [id, entry] of signals) {
    const first = entry.history.find((record) => record.kind === SIGNAL_KIND);
    if (first === undefined) continue;
    const at = effectiveTimeOf(view, first);
    if (at !== null && at !== eventTimeOf(first)) out.set(id, at);
  }
  return out;
}

/** The entities of the store at `store.root`, cached until an `events` shard changes. */
export function readEntitiesOf(
  store: StoreInspection,
  options: StoreEntitiesOptions = {},
): StoreEntities {
  if (options.until !== undefined) return build(store, options.checkpoint, options.until);
  const view = activeStoreReadView();
  if (view !== null) return viewedEntities(store, view, options.checkpoint);
  const cached = cache.get(store.root);
  // The stamp a stored read must still match: the shard part plus the
  // availability of the blobs that read skipped (one stat each, no shard
  // is read). A read whose stored stamp lists no blob lines is uncached.
  const cachedLines =
    cached === undefined ? null : pendingBlobStampLines(store.root, cached.entities.pendingBlobs);
  const shardStamp = fingerprintOf(store);
  const fingerprint = cachedLines === null ? null : `${shardStamp}\n${cachedLines}`;
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached.entities;
  // A checkpoint that throws (a hook deadline) leaves nothing cached.
  const entities = build(store, options.checkpoint);
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

/** One viewed read per store root, kept while the view and the shards are the ones it read. */
const viewedCache = new Map<string, { readonly key: string; readonly entities: StoreEntities }>();

/**
 * The entities of `store` as the window of `view` sees them (`read-view.ts`),
 * kept for the next reader of the same window while no `events` shard
 * changed. Never stored in, or answered from, the cache of whole reads.
 */
function viewedEntities(
  store: StoreInspection,
  view: StoreReadView,
  checkpoint?: () => void,
): StoreEntities {
  const key = `${view.token}\n${fingerprintOf(store)}`;
  const cached = viewedCache.get(store.root);
  if (cached !== undefined && cached.key === key) return cached.entities;
  const entities = build(store, checkpoint, undefined, view);
  if (entities.unreadable.length === 0 && !entities.skippedPending) {
    viewedCache.set(store.root, { key, entities });
  } else viewedCache.delete(store.root);
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

/**
 * The entities of the configured store, or `null` when no store can be
 * read. With `until`, only what lies below that boundary
 * ({@link StoreEntitiesOptions.until}).
 */
export function readStoreEntities(
  configPath?: string,
  options: { readonly until?: StoreReadLimit } = {},
): StoreEntities | null {
  const store = configuredStore(configPath);
  return store === null ? null : readEntitiesOf(store, options);
}

/**
 * The entities of the configured store, held across a run of this
 * process's own writes (a dream pass recording thousands of signal moves,
 * each of which would otherwise rebuild the fold to judge the next one).
 * `current()` answers from the held read while every `events` shard is
 * the one it read, or grown only by this process's own appends since
 * (`own-appends.ts`), and the quarantine ledger is unchanged; anything
 * else (another writer's append, a synced shard, a removed or replaced
 * file) reads the store again. What the held read misses is then only
 * this process's own records, which the caller knows it wrote: a caller
 * that needs to see those reads `readStoreEntities` instead.
 */
export interface HeldEntities {
  /** The held entities, read again first when another writer changed the store; null without a store. */
  current(): StoreEntities | null;
}

export function holdStoreEntities(configPath?: string): HeldEntities {
  let held: {
    entities: StoreEntities;
    root: string;
    quarantine: string;
    stamps: Map<string, ShardStamp>;
  } | null = null;
  const take = (): StoreEntities | null => {
    const store = configuredStore(configPath);
    if (store === null) {
      held = null;
      return null;
    }
    const stamps = eventsStamps(store);
    const entities = readEntitiesOf(store);
    held = { entities, root: store.root, quarantine: quarantineStamp(store.root), stamps };
    return entities;
  };
  const stillHolds = (): boolean => {
    if (held === null) return false;
    // A read with a gap or a skipped pending body may change without a
    // shard changing (a blob delivered, a shard readable again): not held.
    if (held.entities.unreadable.length > 0 || held.entities.pendingBlobs.length > 0) return false;
    const store = configuredStore(configPath);
    if (store === null || store.root !== held.root) return false;
    // A partition this machine came to hold (or stopped holding) since the
    // read: the held entities name the partitions they were read from.
    if (partitionKey(store) !== partitionKey(held.entities.store)) return false;
    if (quarantineStamp(store.root) !== held.quarantine) return false;
    const now = eventsStamps(store);
    for (const path of held.stamps.keys()) if (!now.has(path)) return false;
    for (const [path, stamp] of now) {
      const before = held.stamps.get(path);
      if (before !== undefined && sameShardStamp(before, stamp)) continue;
      if (before !== undefined && !sameDevIno(before, stamp)) return false;
      if (!appendedByThisProcess(path, before ?? null, stamp)) return false;
      held.stamps.set(path, stamp);
    }
    return true;
  };
  return {
    current: () => (stillHolds() ? held!.entities : take()),
  };
}

/** An events shard as a held read saw it: its identity and its append stamp. */
type ShardStamp = AppendStamp & { readonly ino: bigint; readonly dev: bigint };

function partitionKey(store: StoreInspection): string {
  return [...store.partitions].toSorted().join(",");
}

function sameShardStamp(a: ShardStamp, b: ShardStamp): boolean {
  return (
    sameDevIno(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

/** Every `events` shard of `store` by path, with its stamp; an unlistable or unstatable one is left out, and so differs from any held read. */
function eventsStamps(store: StoreInspection): Map<string, ShardStamp> {
  const stamps = new Map<string, ShardStamp>();
  for (const partition of store.partitions) {
    let shards: ReturnType<typeof listShards>;
    try {
      shards = listShards(partitionDir(store.root, partition), EVENTS);
    } catch {
      stamps.set(`${partition}:unlisted:${Math.random()}`, {
        ino: -1n,
        dev: -1n,
        size: -1,
        mtimeNs: -1n,
        ctimeNs: -1n,
      });
      continue;
    }
    for (const shard of shards) {
      try {
        const s = lstatSync(shard.path, { bigint: true });
        stamps.set(shard.path, {
          ino: s.ino,
          dev: s.dev,
          size: Number(s.size),
          mtimeNs: s.mtimeNs,
          ctimeNs: s.ctimeNs,
        });
      } catch {
        // removed between the listing and the stat: absent, so a held read
        // that saw it no longer holds
      }
    }
  }
  return stamps;
}
