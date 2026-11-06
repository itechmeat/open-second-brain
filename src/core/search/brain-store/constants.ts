/**
 * Names the store-aware search index uses (design D5): where the index
 * lives in a store's device-local state, how a brain record is keyed in
 * the `documents` table, which streams are searchable, the catch-up
 * throttle, and the two values of the document source column.
 *
 * The store's own names (partitions, streams, file names) stay in
 * `src/core/store/constants.ts`; this module only names what the index
 * adds on top of them.
 */

import type { StoreStream } from "../../store/constants.ts";

/**
 * Subdirectory of a store's device-local state directory that holds one
 * index per vault: `<device state>/index/<vault key>/brain.sqlite`. The
 * vault key keeps two vaults on one machine from sharing (and sweeping)
 * one index.
 */
export const STORE_INDEX_DIR = "index";

/**
 * File in a store's {@link STORE_INDEX_DIR} naming the store root the
 * store was last read at on this machine. A probe that answers `unknown`
 * keeps only an index whose store was last seen at the root it probed, so
 * a retired or moved store's index is never picked up.
 */
export const STORE_INDEX_ROOT_FILE = "store-root";

/** Hex characters of the vault path hash that name a vault's index directory. */
export const STORE_INDEX_VAULT_KEY_LENGTH = 16;

/**
 * First segment of the `documents.path` of every brain record:
 * `.brain-store/<partition>/<record id>`. A dot directory, so no vault
 * note can ever carry the same path: the vault walker skips dot
 * directories.
 */
export const STORE_RECORD_PATH_PREFIX = ".brain-store";

/** Whether an indexed document path names a brain store record. */
export function isStoreRecordPath(path: string): boolean {
  return path.startsWith(`${STORE_RECORD_PATH_PREFIX}/`);
}

/**
 * Streams whose records are made searchable through the chunk and FTS
 * path. Every stream is still ingested into the `records` table (the
 * change probe reports all of them); ledgers, settings and digests are
 * bookkeeping that would only add noise to recall.
 */
export const SEARCHABLE_STORE_STREAMS: ReadonlySet<StoreStream> = new Set<StoreStream>([
  "events",
  "log",
  "topics",
]);

/** Environment variable that sets the catch-up throttle in milliseconds (0 checks on every read). */
export const STORE_CATCH_UP_INTERVAL_ENV = "OPEN_SECOND_BRAIN_STORE_CATCHUP_INTERVAL_MS";

/** Default catch-up throttle: shards are stat'ed at most once per second per process. */
export const STORE_CATCH_UP_INTERVAL_MS = 1000;

/** The two values of `documents.source`. */
export const DOCUMENT_SOURCE = Object.freeze({
  /** A user note from the vault. */
  note: "note",
  /** A brain record: a store record, or a page of the legacy `Brain/` tree. */
  brain: "brain",
} as const);
export type DocumentSource = (typeof DOCUMENT_SOURCE)[keyof typeof DOCUMENT_SOURCE];

/** The caller-facing values of the search `source` option. */
export const SEARCH_SOURCES = Object.freeze(["notes", "brain"] as const);
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/** Whether `value` is one of {@link SEARCH_SOURCES}. */
export function isSearchSource(value: unknown): value is SearchSource {
  return typeof value === "string" && (SEARCH_SOURCES as ReadonlyArray<string>).includes(value);
}

/** The document source a search source keeps. */
export function documentSourceFor(source: SearchSource): DocumentSource {
  return source === "notes" ? DOCUMENT_SOURCE.note : DOCUMENT_SOURCE.brain;
}

/** `index_state` key of the index generation the change probe's watermarks are bound to. */
export const STORE_INDEX_GENERATION_KEY = "store_index_generation";

/**
 * `index_state` key of the highest ingest sequence a removed record held.
 * New records are numbered above it, so removing the newest record never
 * lets the next one reuse its sequence behind a change-probe watermark.
 */
export const STORE_RECORD_SEQ_FLOOR_KEY = "store_record_seq_floor";
