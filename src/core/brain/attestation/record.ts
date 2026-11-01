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

/** The record schema version. Additive fields only, per the schema doctrine. */
export const ATTESTATION_FILE_SCHEMA_VERSION = "o2b.attestation.v1";

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
  return join(vault, ".open-second-brain", ATTESTATIONS_REL);
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
  if (basename(path, ".json") !== obj.id) {
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
 * Every attestation file in the vault, oldest first.
 *
 * Sorted by file NAME - the id is the compact UTC instant, so name order
 * IS time order without depending on mtimes, which a synced vault does
 * not preserve.
 */
export function listAttestationRecordFiles(
  vault: string,
): ReadonlyArray<{ path: string; name: string }> {
  const dir = attestationsDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(ATTEST_FILE_PREFIX) && name.endsWith(".json"))
    .toSorted()
    .map((name) => ({ path: join(dir, name), name }));
}

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
  assertVaultIdentityForWrite(vault, undefined, WRITE_LANE.audit);
  if (!attestationSealVerifies(record)) {
    throw new Error(`refusing to write attestation ${record.id}: its seal does not verify`);
  }
  if (!ATTESTATION_ID_SHAPE.test(record.id)) {
    throw new Error(
      `refusing to write attestation: id ${JSON.stringify(record.id)} is not an ` +
        "attest-<UTC-compact> instant, so it does not name a file inside the attestations directory",
    );
  }
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
