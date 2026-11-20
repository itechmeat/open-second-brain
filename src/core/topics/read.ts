/**
 * Read the topics of the configured store (task 3.1): the `topics` stream
 * of every partition this machine holds, folded once (`fold.ts`), each
 * topic and item tagged with whether it is private.
 *
 * Reach (design D3, task 3.17): a caller below local reach (a remote MCP
 * transport, `caller-reach.ts`) is answered from the `shared` partition
 * alone, so a private topic, a private item of a shared topic, and an
 * undo, rename or assignment written to `private` read for it as if they
 * did not exist; it folds exactly what a machine that holds only `shared`
 * folds. Every other caller folds every partition this machine holds.
 *
 * A shard that could not be read, was read only in part, or is gone since
 * this machine read it is named in `unreadable`: its records are unknown,
 * not absent, so a caller that decides something from the fold (the
 * writer's privacy of a topic, the dream's routing) refuses on any.
 * Nothing is written.
 */

import { recordSessionOf } from "../agent-context/session-identity.ts";
import { privateWithheld } from "../store/caller-reach.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import type { StorePartition } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { TOPIC_STREAM } from "./constants.ts";
import { foldTopics, type TopicFold } from "./fold.ts";

export interface TopicRead {
  readonly fold: TopicFold;
  /** Partition-relative paths (`<partition>/<shard>`) of shards not read in full. */
  readonly unreadable: ReadonlyArray<string>;
  /** The partitions the fold read. */
  readonly partitions: ReadonlySet<StorePartition>;
  /** The topic each topic record read names (record id to topic id). */
  readonly recordTopics: ReadonlyMap<string, string>;
  /** Ids of the topic records read from the `private` partition. */
  readonly privateRecords: ReadonlySet<string>;
  /**
   * The `source` record each model-authority topic record names (a
   * dream-derived item), record id to source id.
   */
  readonly recordSources: ReadonlyMap<string, string>;
  /**
   * The session stamp each topic record read carries, record id to
   * stamp (`agent-context/session-identity.ts`); a record without one is
   * absent.
   */
  readonly recordSessions: ReadonlyMap<string, string>;
  /** The store id, `null` without a store. */
  readonly storeId: string | null;
}

const EMPTY: TopicRead = Object.freeze({
  fold: foldTopics([]),
  unreadable: [],
  partitions: new Set<StorePartition>(),
  recordTopics: new Map<string, string>(),
  privateRecords: new Set<string>(),
  recordSources: new Map<string, string>(),
  recordSessions: new Map<string, string>(),
  storeId: null,
});

/** The partitions a read for the caller of the work running now may fold. */
function readablePartitions(store: StoreInspection): StorePartition[] {
  const held = [...store.partitions];
  return privateWithheld() ? held.filter((p) => p === "shared") : held;
}

/** Fold the topics of `store`, for the caller of the work running now. */
export function readTopicsOf(store: StoreInspection): TopicRead {
  const records: StoreRecord[] = [];
  const privateIds = new Set<string>();
  const unreadable: string[] = [];
  const partitions = readablePartitions(store);
  for (const partition of partitions) {
    const read = readStreamRecords(store.root, partition, { stream: TOPIC_STREAM });
    for (const record of read.records) {
      // Below local reach a shared record that carries a `<private>` region
      // is withheld, as every reader withholds it.
      if (privateWithheld() && valueCarriesPrivateRegion(record.body)) continue;
      records.push(record);
      if (partition === "private") privateIds.add(record.id);
    }
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
  }
  const recordTopics = new Map<string, string>();
  const recordSources = new Map<string, string>();
  const recordSessions = new Map<string, string>();
  for (const record of records) {
    const session = recordSessionOf(record.body);
    if (session !== undefined) recordSessions.set(record.id, session);
    if (record.topic !== null) recordTopics.set(record.id, record.topic);
    const source = record.body["source"];
    if (record.body["authority"] === "model" && typeof source === "string") {
      recordSources.set(record.id, source);
    }
  }
  return {
    fold: foldTopics(records, { privateIds }),
    unreadable,
    partitions: new Set(partitions),
    recordTopics,
    privateRecords: privateIds,
    recordSources,
    recordSessions,
    storeId: store.storeId,
  };
}

/** {@link readTopicsOf} for the store the machine config at `configPath` names; empty without one. */
export function readTopics(configPath?: string): TopicRead {
  const store = configuredStore(configPath);
  return store === null ? EMPTY : readTopicsOf(store);
}
