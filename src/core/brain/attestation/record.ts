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
import { join } from "node:path";

import { atomicCreateFileSyncExclusive } from "../../fs-atomic.ts";
import { canonicalJson, digestVerifies, sealWithDigest } from "../../integrity/digest.ts";
import { WRITE_LANE } from "../freeze-marker.ts";
import { resolveAppendShardId } from "../ledger-shards.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { attestationStoreDigest, type AttestationManifest } from "./digest.ts";

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
 * object - refuses too: an attestation that cannot be read is never
 * treated as valid or skipped silently, because the artifact is
 * evidence, and silently dropping evidence is the one failure this
 * family exists to prevent.
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
