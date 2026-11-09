/**
 * The attestation record (delivery trust, card t_3bdb82b0).
 *
 * One attestation is ONE small JSON file per signing run, under the
 * derived store: `<vault>/.open-second-brain/attestations/attest-<UTC-compact>.json`.
 * Not an append-mode ledger - there is no per-device shard grammar here,
 * and the append-shard census is deliberately not engaged - because an
 * attestation is an operator-owned artifact made with a device's key,
 * device-local by nature, and never a record peers append to.
 *
 * The noun is "attestation" everywhere. Four other meanings of
 * "checkpoint" already live in this tree (the resume substrate, the
 * batch session checkpoint, the safeguard method, the dream fixtures)
 * plus the `.snapshots` recovery family; this module shares none of
 * their namespaces and touches nothing under `Brain/.snapshots/`.
 *
 * The body is sealed with `sealWithDigest` - the persisted-digest
 * doctrine's own shape, the same seal the state-migration manifest
 * carries - and the Ed25519 signature (`signing.ts`) is computed over
 * that sealed body. Unknown schema versions are refused by name, the
 * `readCheckpointObject` pattern: an older build must never misread a
 * newer record, and a record it cannot understand is a refusal, not a
 * guess.
 *
 * ## Store-only machines (design D14 item 6)
 *
 * Once this machine writes the brain store only, an attestation is one
 * shared `attestation` record (`{ "record": <the signed record> }`, in
 * the `events` stream of `shared`) instead of a file, so every machine
 * that holds `shared` lists and verifies it; the key that signs it stays
 * in this machine's device-local state (`signing.ts`). The listing then
 * merges those records with any file left in the device-local
 * attestations directory (a record restored from the migration backup),
 * one entry per id, and {@link readAttestationEntry} reads either kind
 * through the same validation. An unswitched machine is unchanged: one
 * file per signing run and no store record.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { atomicCreateFileSyncExclusive } from "../../fs-atomic.ts";
import { canonicalJson, digestVerifies, sealWithDigest } from "../../integrity/digest.ts";
import { WRITE_LANE } from "../freeze-marker.ts";
import { parseShardedName, resolveAppendShardId } from "../ledger-shards.ts";
import { LOG_HEAD_GRAMMAR } from "../log.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  ATTESTATION_MANIFEST_SCHEMA_VERSION,
  attestationStoreDigest,
  type AttestationManifest,
} from "./digest.ts";
import { machineStatePath } from "../../state/machine-state.ts";
import { DERIVED_STORE_DIR } from "../path-constants.ts";
import { STORE_PARTITIONS } from "../../store/constants.ts";
import { compareRecords, type StoreRecord } from "../../store/envelope.ts";
import { withLocalLock } from "../../store/local-lock.ts";
import { protectionStoreUnavailable } from "../../store/read/protection-store.ts";
import { readSource } from "../../store/read/read-context.ts";
import { trackSeenShards } from "../../store/seen-shards.ts";
import { readShard, shardReadGap } from "../../store/reader.ts";
import { listShards } from "../../store/shard-list.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { partitionDir, storesStateDir } from "../../store/store-paths.ts";
import { storeWrite } from "../../store/store-write.ts";
import { processDirsEnv } from "../../platform-dirs.ts";

/** The record schema version. Additive fields only, per the schema doctrine. */
export const ATTESTATION_FILE_SCHEMA_VERSION = "o2b.attestation.v1";

/** The store record kind of one attestation (FORMAT.md, "Kinds of attestations"). */
export const ATTESTATION_KIND = "attestation";

/** The attestations directory, relative to the derived store root. */
export const ATTESTATIONS_REL = "attestations";

/**
 * The prefix every attestation file and id carries. Distinct on purpose
 * from the snapshot and checkpoint families' naming, so a directory
 * listing never leaves the two readings open.
 */
const ATTEST_FILE_PREFIX = "attest-";

/**
 * The shape {@link utcCompact} produces and every id carries: the
 * compact UTC instant (`20260603T100000500Z`). The writer refuses an
 * off-shape id rather than join it into a file path, and the reader
 * refuses both an off-shape id and one that does not match its file's
 * own name, so a crafted or hand-edited id can never name a file
 * outside the attestations directory nor outrank its own instant.
 */
const ATTESTATION_ID_SHAPE = new RegExp(`^${ATTEST_FILE_PREFIX}\\d{8}T\\d{9}Z$`);

/**
 * One signed attestation. `digest` is the seal over the record without
 * the digest field ({@link sealWithDigest}); `signature` is the base64
 * Ed25519 signature over the sealed body EXCLUDING the signature field
 * itself, null until `signAttestationRecord` fills it - and an unsigned
 * record is refused by verification rather than read as valid.
 */
export interface AttestationRecord {
  readonly schemaVersion: string;
  readonly id: string;
  readonly createdAt: string;
  readonly deviceId: string;
  readonly manifest: AttestationManifest;
  readonly storeDigest: string;
  readonly digest: string;
  readonly signature: string | null;
}

/** `<vault>/.open-second-brain/attestations/`. */
export function attestationsDir(vault: string): string {
  return machineStatePath(vault, DERIVED_STORE_DIR, ATTESTATIONS_REL);
}

/**
 * Compact UTC spelling of an instant used in attestation ids and file
 * names: `20260603T100000500Z`. Milliseconds are kept so two signings in
 * the same second get distinct ids and distinct files instead of the
 * second one overwriting the first.
 */
function utcCompact(instant: Date): string {
  const iso = instant.toISOString();
  const compact = iso.replace(/[-:]/g, "").replace(/Z$/, "").replace(".", "");
  return `${compact}Z`;
}

export interface BuildAttestationRecordOptions {
  /** Clock, injected so a test can pin the stamp. Defaults to now. */
  readonly now?: Date;
  /** The signing device's shard id. Defaults to this machine's resolved id. */
  readonly deviceId?: string;
}

/**
 * Assemble and seal one record from a measured manifest.
 *
 * The id is content-independent by design - `attest-<UTC-compact>` - so
 * the id never leaks state, and the store digest inside the body is what
 * gives the record its meaning. Sealing happens here and nowhere else: a
 * record that reaches the writer unsealed is a caller bug, and the
 * writer refuses it.
 */
export function buildAttestationRecord(
  vault: string,
  manifest: AttestationManifest,
  opts: BuildAttestationRecordOptions = {},
): AttestationRecord {
  const instant = opts.now ?? new Date();
  const compact = utcCompact(instant);
  const body = {
    schemaVersion: ATTESTATION_FILE_SCHEMA_VERSION,
    id: `${ATTEST_FILE_PREFIX}${compact}`,
    createdAt: instant.toISOString(),
    deviceId: opts.deviceId ?? resolveAppendShardId(),
    manifest,
    storeDigest: attestationStoreDigest(manifest),
  };
  return sealWithDigest({ ...body, signature: null });
}

/**
 * Whether the record's `digest` still seals its body.
 *
 * The seal is ALWAYS computed over the body with `signature: null` -
 * that is the body `buildAttestationRecord` sealed, and it is what makes
 * the digest the anchor the signature is derived from. A signed record
 * carries a non-null signature field, so naive record-minus-digest
 * verification would fail every signed record; this helper is the one
 * spelling of the check, used by the writer's refuse-tamper gate,
 * `signAttestationRecord` and `verifyAttestationSignature`.
 */
export function attestationSealVerifies(record: AttestationRecord): boolean {
  const { digest, ...rest } = record;
  return digestVerifies({ ...rest, signature: null }, digest);
}

/**
 * The bytes a signature is computed over: the sealed record's canonical
 * JSON with the signature field removed. Both faces - signing here,
 * verification in `signing.ts` and `verify.ts` - derive the payload
 * through this one function, so no second spelling of "what is signed"
 * can appear. Canonical, not plain stringify: sorted keys are the one
 * encoding the persisted-digest doctrine ships, and the signature must
 * verify under every build that reads the record.
 */
export function attestationSigningPayload(record: AttestationRecord): string {
  const { signature: _signature, ...rest } = record;
  return canonicalJson(rest);
}

/** Refusal for a record whose schema this build does not read. */
export class AttestationSchemaError extends Error {
  readonly code = "attestation_schema_refused";
  readonly path: string;

  constructor(path: string, found: unknown) {
    super(
      `attestation record schema_version ${JSON.stringify(found)} is not supported ` +
        `(expected ${ATTESTATION_FILE_SCHEMA_VERSION}): ${path}`,
    );
    this.name = "AttestationSchemaError";
    this.path = path;
  }
}

/**
 * Read one attestation file, refusing an unknown schema by name.
 *
 * Every other malformation - corrupted JSON, a body that is not an
 * object, a body whose fields the verification kernel would otherwise
 * meet unvalidated - refuses too: an attestation that cannot be read is
 * never treated as valid or skipped silently, because the artifact is
 * evidence, and silently dropping evidence is the one failure this
 * family exists to prevent. The shape check is what keeps the kernel's
 * "never throws" contract true for records read from disk: the manifest
 * must be the schema's shape and its `logHeads` must map LOG SHARD FILE
 * NAMES (the one grammar the head collector names shards with) to chain
 * heads, so a crafted or hand-edited manifest can neither crash a
 * verifier nor walk it off the log directory.
 */
export function readAttestationRecordFile(path: string): AttestationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`attestation record is corrupted JSON: ${path}`, { cause: err });
  }
  return validateAttestationRecord(parsed, path, basename(path, ".json"));
}

/**
 * The checks of {@link readAttestationRecordFile} over a parsed record:
 * `label` names it in a refusal, and `expectedId` is the id its file name
 * or listing entry answers to.
 */
function validateAttestationRecord(
  parsed: unknown,
  path: string,
  expectedId: string,
): AttestationRecord {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`attestation record is not an object: ${path}`);
  }
  const obj = parsed as Partial<AttestationRecord>;
  if (obj.schemaVersion !== ATTESTATION_FILE_SCHEMA_VERSION) {
    throw new AttestationSchemaError(path, obj.schemaVersion);
  }
  const malformed = (detail: string): Error =>
    new Error(`attestation record is malformed (${detail}): ${path}`);
  if (typeof obj.id !== "string" || !ATTESTATION_ID_SHAPE.test(obj.id)) {
    throw malformed("id is not an attest-<UTC-compact> instant");
  }
  // The id IS the file's base name: the listing ranks by file name
  // (name order is time order), so a valid record copied under a future
  // dated name would rank as the newest attestation while carrying an
  // older instant - the reader refuses the mismatch.
  if (expectedId !== obj.id) {
    throw malformed(`id ${JSON.stringify(obj.id)} does not answer to the file name`);
  }
  if (typeof obj.createdAt !== "string" || typeof obj.deviceId !== "string") {
    throw malformed("created_at and device_id must be strings");
  }
  if (typeof obj.storeDigest !== "string" || typeof obj.digest !== "string") {
    throw malformed("store_digest and digest must be strings");
  }
  if (obj.signature !== null && typeof obj.signature !== "string") {
    throw malformed("signature must be a string or null");
  }
  const manifest = obj.manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw malformed("manifest must be an object");
  }
  if (manifest.schemaVersion !== ATTESTATION_MANIFEST_SCHEMA_VERSION) {
    throw malformed(
      `manifest schema_version ${JSON.stringify(manifest.schemaVersion)} is not ` +
        `supported (expected ${ATTESTATION_MANIFEST_SCHEMA_VERSION})`,
    );
  }
  const logHeads = manifest.logHeads;
  if (logHeads === null || typeof logHeads !== "object" || Array.isArray(logHeads)) {
    throw malformed("manifest.logHeads must be an object");
  }
  for (const [shardName, head] of Object.entries(logHeads)) {
    if (parseShardedName(shardName, LOG_HEAD_GRAMMAR) === null) {
      throw malformed(`manifest.logHeads key ${JSON.stringify(shardName)} is not a log shard name`);
    }
    if (typeof head !== "string" || head.length === 0) {
      throw malformed(`manifest.logHeads[${JSON.stringify(shardName)}] must be a chain head`);
    }
  }
  return Object.freeze(obj) as AttestationRecord;
}

/**
 * One listed attestation: a file (`path` is the file), or a store record
 * (`path` is the shard that holds it and `stored` its parsed body). `name`
 * is `<id>.json` either way, so name order is time order.
 */
export interface AttestationEntry {
  readonly path: string;
  readonly name: string;
  readonly stored?: unknown;
  /**
   * Set on the placeholder of a store shard that could not be read: why.
   * Reading the entry throws with it, so a lister shows the shard as an
   * unreadable row next to the records that still read.
   */
  readonly unreadable?: string;
}

/**
 * Every attestation of the vault, oldest first.
 *
 * Sorted by NAME - the id is the compact UTC instant, so name order IS
 * time order without depending on mtimes, which a synced vault does not
 * preserve. On a store-only machine the shared `attestation` records come
 * first for an id, then the files of the device-local directory that no
 * record carries; a store shard that cannot be read lists last, as an
 * entry {@link readAttestationEntry} refuses.
 */
export function listAttestationRecordFiles(vault: string): ReadonlyArray<AttestationEntry> {
  const entries = new Map<string, AttestationEntry>();
  if (isStoreOnly({ vault })) {
    for (const entry of storeAttestationEntries(vault)) {
      if (!entries.has(entry.name)) entries.set(entry.name, entry);
    }
  }
  const dir = attestationsDir(vault);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(ATTEST_FILE_PREFIX) || !name.endsWith(".json")) continue;
      if (!entries.has(name)) entries.set(name, { path: join(dir, name), name });
    }
  }
  return [...entries.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Read one listed attestation, file or store record, refusing what does not validate. */
export function readAttestationEntry(entry: AttestationEntry): AttestationRecord {
  if (entry.unreadable !== undefined) throw new Error(entry.unreadable);
  if (entry.stored === undefined) return readAttestationRecordFile(entry.path);
  const record =
    entry.stored !== null && typeof entry.stored === "object"
      ? (entry.stored as { record?: unknown }).record
      : undefined;
  return validateAttestationRecord(record, entry.path, basename(entry.name, ".json"));
}

/**
 * One entry per `attestation` record of every held partition, in fold
 * order, whose body names an attestation id of the right shape (the first
 * record in fold order wins an id). `path` is the shard the record was
 * read from; the record is validated when it is read. A shard (or a whole
 * events stream) that cannot be read is one placeholder entry, sorted
 * after every record, that {@link readAttestationEntry} refuses: the
 * attestations it holds must never pass as none, yet one damaged shard,
 * which holds every log event too, hides nothing but itself. A reader of
 * the newest entry (doctor, verify) therefore meets the damage first.
 */
function storeAttestationEntries(vault: string): AttestationEntry[] {
  const source = readSource({ vault });
  if (source.kind !== "store") return [];
  if (source.store === null) {
    // A switched machine whose store cannot be opened: its attestations
    // are unknown, never none (`protection-store.ts`).
    const gone = protectionStoreUnavailable();
    return gone === null
      ? []
      : [{ path: "", name: `${UNREADABLE_NAME_PREFIX}store`, unreadable: gone.message }];
  }
  const root = source.store.root;
  const found: { record: StoreRecord; path: string }[] = [];
  const seen = new Set<string>();
  const unreadable: { path: string; rel: string }[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!source.store.partitions.has(partition)) continue;
    const partitionRoot = partitionDir(root, partition);
    let shards: ReturnType<typeof listShards>;
    try {
      shards = listShards(partitionRoot, EVENTS);
    } catch {
      // A stream that cannot be listed (EACCES, EBUSY) is named whole, as
      // `readStreamRecords` names it.
      unreadable.push({ path: join(partitionRoot, EVENTS.stream), rel: `${partition}/events` });
      continue;
    }
    for (const shard of shards) {
      let read: ReturnType<typeof readShard>;
      try {
        read = readShard(shard.path, { partitionRoot });
      } catch {
        unreadable.push({ path: shard.path, rel: `${partition}/${shard.rel}` });
        continue;
      }
      if (read.diagnostics.some((d) => d.kind === "not-a-file")) {
        unreadable.push({ path: shard.path, rel: `${partition}/${shard.rel}` });
        continue;
      }
      // Read only in part (a pending blob, a bad line in the middle): the
      // missing record may be an attestation, so the shard counts as unread.
      if (shardReadGap(read) !== null) {
        unreadable.push({ path: shard.path, rel: `${partition}/${shard.rel}` });
      }
      for (const { record, bodyState } of read.records) {
        if (bodyState === "pending" || record.kind !== ATTESTATION_KIND) continue;
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        found.push({ record, path: shard.path });
      }
    }
    // A shard this machine read before and that is gone now hides its
    // attestations the same way.
    const listed = shards.map((shard) => shard.rel);
    for (const rel of trackSeenShards(partitionRoot, { prefix: `${EVENTS.stream}/` }, listed)) {
      unreadable.push({ path: join(partitionRoot, ...rel.split("/")), rel: `${partition}/${rel}` });
    }
  }
  const entries = found
    .toSorted((a, b) => compareRecords(a.record, b.record))
    .flatMap(({ record, path }) => {
      const inner = record.body["record"];
      const id =
        inner !== null && typeof inner === "object" ? (inner as { id?: unknown }).id : undefined;
      if (typeof id !== "string" || !ATTESTATION_ID_SHAPE.test(id)) return [];
      return [{ path, name: `${id}.json`, stored: record.body }];
    });
  const damaged = unreadable.map(({ path, rel }) => ({
    path,
    name: `${UNREADABLE_NAME_PREFIX}${rel}`,
    unreadable: `the store's attestation records could not all be read (unreadable shard: ${rel})`,
  }));
  return [...entries, ...damaged];
}

/**
 * Name prefix of an unreadable-shard placeholder. `~` sorts after every
 * attestation id, so the placeholder lists as the newest entry.
 */
const UNREADABLE_NAME_PREFIX = "~unreadable:";

/** The stream attestation records are written to. */
const EVENTS = Object.freeze({ stream: "events" as const });

export interface WriteAttestationRecordResult {
  readonly path: string;
}

/**
 * Write one attestation as a single atomic JSON file, under the
 * attestations-directory lock.
 *
 * The lock is registered in the lock-site census (`DECLARED` in
 * `tests/core/brain/sync-lockfile.test.ts`) and falls under
 * `lockScanRoots` - the derived store is one of its two roots - so a
 * crashed writer leaves a stale lock the doctor can name. Exclusive
 * create beneath the lock means two records for the same instant refuse
 * rather than one silently erasing the other: each attestation is
 * evidence, and the later one can be taken a millisecond later with its
 * own id.
 *
 * The vault-identity guard runs on the write path (the AUDIT lane, like
 * the log appender: an attestation is recorded evidence about the store,
 * and a frozen vault is exactly the moment an operator reaches for one -
 * freeze must not silence it, only content writes).
 */
export function writeAttestationRecord(
  vault: string,
  record: AttestationRecord,
): WriteAttestationRecordResult {
  const storeOnly = isStoreOnly({ vault });
  // A store-only machine checks the store identity in the store write
  // instead (design D14 item 13).
  if (!storeOnly) assertVaultIdentityForWrite(vault, undefined, WRITE_LANE.audit);
  if (!attestationSealVerifies(record)) {
    throw new Error(`refusing to write attestation ${record.id}: its seal does not verify`);
  }
  if (!ATTESTATION_ID_SHAPE.test(record.id)) {
    throw new Error(
      `refusing to write attestation: id ${JSON.stringify(record.id)} is not an ` +
        "attest-<UTC-compact> instant, so it does not name a file inside the attestations directory",
    );
  }
  if (storeOnly) return writeStoreAttestation(vault, record);
  const dir = attestationsDir(vault);
  const path = join(dir, `${record.id}.json`);
  const lock = acquireLockSync(dir);
  try {
    atomicCreateFileSyncExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    lock.release();
  }
  return { path };
}

/** Device-local lock of the store-only id check and append. */
const STORE_ATTESTATION_LOCK = "attestations";

/**
 * The store-only write: one `attestation` record. An attestation names no
 * page (a vault id, log shard names, ledger file names, an index stamp,
 * digests), so on its own it is `shared`, the partition every machine
 * that verifies it holds; only an enclosing private operation (the
 * ambient scope of `operation-scope.ts`) raises it to `private`. The id
 * check and the append run under a device-local lock, so an id this
 * machine already recorded, as a record or as a file of the device-local
 * attestations directory, is refused, as the exclusive create refuses a
 * second file.
 */
function writeStoreAttestation(
  vault: string,
  record: AttestationRecord,
): WriteAttestationRecordResult {
  return withLocalLock(join(storesStateDir(processDirsEnv()), STORE_ATTESTATION_LOCK), () => {
    const held = storeAttestationEntries(vault);
    // The duplicate-id check fails closed: an unreadable shard may hold this id.
    const damage = held.find((e) => e.unreadable !== undefined);
    if (damage !== undefined) throw new Error(damage.unreadable);
    const taken =
      existsSync(join(attestationsDir(vault), `${record.id}.json`)) ||
      held.some((e) => e.name === `${record.id}.json`);
    if (taken) {
      throw new Error(`refusing to write attestation ${record.id}: the store already holds it`);
    }
    const [appended] = storeWrite(
      () => ({
        ...EVENTS,
        kind: ATTESTATION_KIND,
        body: { record: JSON.parse(JSON.stringify(record)) as unknown },
      }),
      { vault },
    );
    return { path: appended?.path ?? "" };
  });
}
