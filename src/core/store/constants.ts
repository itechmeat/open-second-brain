/**
 * Names of the brain store: the one place that spells every directory,
 * file, stream, partition, envelope field and store-level record kind.
 *
 * The brain store (design D1) is the open, documented, append-only home of
 * every piece of Open Second Brain machine data outside the user's notes.
 * Every other store module builds its paths and validates its records
 * against the names here, and the `FORMAT.md` doc test checks that the
 * shipped format document names each of them, so the code and the public
 * format cannot drift apart silently.
 */

/** Format version written into every record envelope (`v`). */
export const STORE_FORMAT_VERSION = 1;

/** The format document shipped into the store root and every partition. */
export const STORE_FORMAT_FILE = "FORMAT.md";

/** Per-partition identity file: the store id and the format version that created it. */
export const STORE_IDENTITY_FILE = "store.json";

/** Sensitivity partitions, each a separate top-level folder synced on its own. */
export const STORE_PARTITIONS = Object.freeze(["shared", "private"] as const);
export type StorePartition = (typeof STORE_PARTITIONS)[number];

/**
 * Streams inside a partition. `ledgers` carries one more path segment, the
 * ledger name (`ledgers/<name>/<device>/<YYYY-MM>.jsonl`).
 */
export const STORE_STREAMS = Object.freeze([
  "events",
  "log",
  "ledgers",
  "topics",
  "settings",
  "digests",
] as const);
export type StoreStream = (typeof STORE_STREAMS)[number];

/** The stream whose files sit one directory deeper, under a ledger name. */
export const LEDGER_STREAM: StoreStream = "ledgers";

/** Content-addressed blob directory inside a partition. */
export const STORE_BLOBS_DIR = "blobs";

/** Extension of every shard file. */
export const STORE_SHARD_EXT = "jsonl";

/**
 * Envelope fields in the order the appender writes them. `topic` and
 * `scope` may be `null`; every other field is always present.
 */
export const ENVELOPE_FIELDS = Object.freeze([
  "v",
  "id",
  "hlc",
  "device",
  "agent",
  "kind",
  "scope",
  "topic",
  "sum",
  "body",
] as const);
export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

/**
 * Reserved key of a blob reference body: `{ "$blob": <sha256>, "bytes": <n> }`.
 * A record whose body was spilled into `blobs/` carries this body on its
 * line; the real body is the blob's content.
 */
export const BLOB_REF_KEY = "$blob";

/** The byte-count key that rides beside {@link BLOB_REF_KEY}. */
export const BLOB_REF_BYTES_KEY = "bytes";

/** Store-level record kind: a compaction replaced one set of shards with another. */
export const COMPACTED_KIND = "compacted";

/**
 * Record kinds the store layer itself defines and understands. Domain
 * kinds (signals, topics, settings) are defined by the modules that own
 * them, in later waves.
 */
export const STORE_RECORD_KINDS = Object.freeze([COMPACTED_KIND] as const);

/**
 * Line-size cap in bytes, newline included. A record whose line would be
 * longer is written with its body spilled into a blob.
 */
export const STORE_LINE_CAP_BYTES = 16 * 1024;

/**
 * Deepest nesting of objects and arrays a record body may have, the body
 * object itself counting as one level. A deeper body is never written and
 * is read as a corrupt record, so checksumming a body peer-planted in a
 * blob can never exhaust the stack.
 */
export const STORE_BODY_MAX_DEPTH = 64;

/**
 * Largest blob a reader loads. A spilled body is a record body (a pinned
 * text, a signal, a ledger row), far below this; a larger file in a
 * synced `blobs/` folder is refused unread rather than allocated.
 */
export const STORE_BLOB_MAX_BYTES = 64 * 1024 * 1024;

/** Machine-config key that sets the store root. */
export const STORE_ROOT_CONFIG_KEY = "store_root";

/** Environment variable that sets the store root, ahead of the config key. */
export const STORE_ROOT_ENV = "OPEN_SECOND_BRAIN_STORE_ROOT";

/** Directory name of the default store root under the per-user data directory. */
export const STORE_DEFAULT_DIR = "store";

/** Directory under the tool's state root that holds one device-local directory per store id. */
export const STORE_STATE_DIR = "stores";

/** Device-local subdirectory of shard append locks (never inside the synced store). */
export const STORE_LOCKS_DIR = "locks";

/** Device-local subdirectory of the persisted hybrid logical clock. */
export const STORE_CLOCK_DIR = "clock";

/**
 * Device-local file (in a store's device-local directory, one per store
 * root, the root's hash before the extension) listing every shard this
 * machine has seen, so a shard that later goes missing reads as
 * unreadable rather than as "no records" (`seen-shards.ts`).
 */
export const SEEN_SHARDS_FILE = "seen-shards.json";

// ---------------------------------------------------------------------------
// Folds of mutable entities and state digests (tasks 1.6 and 1.7, design D4
// and D6). One block, so it merges cleanly beside other additions.
// ---------------------------------------------------------------------------

/** Body field that carries the authority of a mutable-entity record. */
export const AUTHORITY_FIELD = "authority";

/**
 * Body field every dual-written record carries: the id of the vault the
 * legacy write went to (`Brain/vault-id.json`), or `null` when that vault
 * has no identity marker or the caller named no vault.
 */
export const VAULT_ID_FIELD = "vault_id";

/**
 * Who decided a mutable-entity record, from the strongest to the weakest:
 * the user, an agent, a decision model. A stronger authority always beats
 * a weaker one; within one authority the later clock wins.
 */
export const AUTHORITIES = Object.freeze(["human", "agent", "model"] as const);
export type Authority = (typeof AUTHORITIES)[number];

/** Preference records (`events` stream): a field update, a removal, evidence. */
export const PREFERENCE_SET_KIND = "preference-set";
export const PREFERENCE_REMOVE_KIND = "preference-remove";
export const PREFERENCE_EVIDENCE_KIND = "preference-evidence";

/** Pinned context records (`events` stream): a replacement and a clear. */
export const PINNED_SET_KIND = "pinned-set";
export const PINNED_CLEAR_KIND = "pinned-clear";

/** Shared setting records (`settings` stream): a value and its removal. */
export const SETTING_SET_KIND = "setting-set";
export const SETTING_UNSET_KIND = "setting-unset";

/** A human record that takes a device off the digest roster (`settings` stream). */
export const DEVICE_RETIRE_KIND = "device-retire";

/** A published state digest (`digests` stream). */
export const STATE_DIGEST_KIND = "state-digest";

/** Every record kind the folds and digests define; FORMAT.md documents each. */
export const FOLD_RECORD_KINDS = Object.freeze([
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PINNED_SET_KIND,
  PINNED_CLEAR_KIND,
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
  DEVICE_RETIRE_KIND,
  STATE_DIGEST_KIND,
] as const);

/** Results an evidence record may carry. */
export const EVIDENCE_RESULTS = Object.freeze(["applied", "violated", "outdated"] as const);
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/**
 * Preference counters derived in the fold from evidence records. They are
 * never written back: a `preference-set` that names one is ignored for it.
 */
export const PREFERENCE_COUNTER_FIELDS = Object.freeze([
  "applied_count",
  "violated_count",
  "outdated_count",
] as const);

/** Setting keys this version knows and validates. Other keys fold as plain JSON values. */
export const SETTING_VIEW_LANGUAGE = "view.language";
export const SETTING_TOPIC_MIN_RECORDS = "topics.new_min_records";
export const SETTING_TOPIC_MIN_SESSIONS = "topics.new_min_sessions";
export const SETTING_KEYS = Object.freeze([
  SETTING_VIEW_LANGUAGE,
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
] as const);
export type SettingKey = (typeof SETTING_KEYS)[number];

/** The folds a state digest hashes, in the order the digest body lists them. */
export const STATE_DIGEST_FOLDS = Object.freeze(["preferences", "pinned", "settings"] as const);
export type StateDigestFold = (typeof STATE_DIGEST_FOLDS)[number];

/** One day in milliseconds, for the day-based windows below. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Roster window: devices with records in the partition during the last N days. */
export const DIGEST_ROSTER_WINDOW_DAYS = 30;

/** A roster device that has published no digest for N days is reported as silent. */
export const DIGEST_SILENCE_DAYS = 7;

/** Doctor compares the digests published during the last N days. */
export const DIGEST_COMPARE_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Dual writes (task 1.11, design D13 phase 1): the legacy writers also append
// the equivalent store record while the flag is on.
// ---------------------------------------------------------------------------

/** Machine-config key of the dual-write flag (default off). */
export const STORE_DUAL_WRITE_CONFIG_KEY = "store_dual_write";

/** Environment variable that sets the dual-write flag, ahead of the config key. */
export const STORE_DUAL_WRITE_ENV = "OPEN_SECOND_BRAIN_STORE_DUAL_WRITE";

/** A signal written by a legacy signal writer (`events` stream). */
export const SIGNAL_KIND = "signal";

/** One event of the legacy Brain log (`log` stream). */
export const LOG_EVENT_KIND = "log-event";

/** One row of a legacy append-only ledger (`ledgers/<name>` stream). */
export const LEDGER_ROW_KIND = "ledger-row";

/** Record kinds the dual writes define, beside the fold kinds they reuse. */
export const DUAL_WRITE_RECORD_KINDS = Object.freeze([
  SIGNAL_KIND,
  LOG_EVENT_KIND,
  LEDGER_ROW_KIND,
] as const);

/**
 * Device-local file (under the tool's state root, beside the per-store
 * directories) that counts dual writes that failed or were skipped, so
 * doctor can report them.
 */
export const DUAL_WRITE_STATUS_FILE = "dual-write.json";

/**
 * Device-local subdirectory where blob temp files are written before they
 * are linked into the store, when it is on the store's filesystem.
 */
export const STORE_TMP_DIR = "tmp";

/**
 * Prefix of a blob temp file written inside `blobs/` (when the device-local
 * directory is on another filesystem). Readers and sync setups ignore
 * names that start with a dot.
 */
export const BLOB_TEMP_PREFIX = ".tmp-";
