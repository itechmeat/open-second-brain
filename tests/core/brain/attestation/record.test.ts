/**
 * The attestation record kernel (delivery trust, Lane D task D2).
 *
 * The record is the signed artifact an operator accumulates, so the
 * tests here hold it to the persisted-digest doctrine: it seals itself
 * with `sealWithDigest`, it lands as one atomic JSON file that re-reads
 * to the same value, it refuses an unknown schema by name instead of
 * guessing, and its write path asserts the vault identity like every
 * other write-capable module in the tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAlreadyExistsError } from "../../../../src/core/fs-atomic.ts";
import {
  ATTESTATION_FILE_SCHEMA_VERSION,
  ATTESTATIONS_REL,
  buildAttestationRecord,
  listAttestationRecordFiles,
  readAttestationRecordFile,
  writeAttestationRecord,
} from "../../../../src/core/brain/attestation/record.ts";
import { attestationsDir } from "../../../../src/core/brain/attestation/record.ts";
import { collectAttestationManifest } from "../../../../src/core/brain/attestation/digest.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";
import { digestVerifies } from "../../../../src/core/integrity/digest.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-attest-record-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildAttestationRecord", () => {
  test("seals the body: the digest field verifies over the record without it", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    expect(record.schemaVersion).toBe(ATTESTATION_FILE_SCHEMA_VERSION);
    expect(ATTESTATION_FILE_SCHEMA_VERSION).toBe("o2b.attestation.v1");
    const { digest, ...body } = record;
    expect(digestVerifies(body, digest)).toBe(true);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a tampered body fails the seal", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    const tampered = { ...record, deviceId: "someone-else" };
    const { digest, ...body } = tampered;
    expect(digestVerifies(body, digest)).toBe(false);
  });

  test("the id and file name derive from the created-at instant, compact UTC", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00.500Z"),
    });
    expect(record.id).toBe("attest-20260603T100000500Z");
  });
});

describe("writeAttestationRecord", () => {
  test("lands one JSON file under the attestations directory that re-reads sealed", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    const { path } = writeAttestationRecord(vault, record);
    expect(path.startsWith(attestationsDir(vault))).toBe(true);
    expect(path.endsWith(`${record.id}.json`)).toBe(true);
    expect(existsSync(join(vault, ".open-second-brain", ATTESTATIONS_REL))).toBe(true);

    const reread = readAttestationRecordFile(path);
    expect(reread).toEqual(record);
    const { digest, ...body } = reread;
    expect(digestVerifies(body, digest)).toBe(true);
  });

  test("an unknown schema_version is refused by name", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    const { path } = writeAttestationRecord(vault, record);
    const forged = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    forged["schemaVersion"] = "o2b.attestation.v0";
    writeFileSync(path, JSON.stringify(forged, null, 2), "utf8");
    expect(() => readAttestationRecordFile(path)).toThrow(/o2b\.attestation\.v0/);
  });

  test("a concurrent second write of the same instant is refused, not overwritten", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    writeAttestationRecord(vault, record);
    expect(() => writeAttestationRecord(vault, record)).toThrow(FileAlreadyExistsError);
  });

  test("the write asserts the vault identity: a swapped marker refuses the write", () => {
    const manifest = collectAttestationManifest(vault);
    const record = buildAttestationRecord(vault, manifest, {
      now: new Date("2026-06-03T10:00:00Z"),
    });
    writeAttestationRecord(vault, record);
    // The first write pinned this process's identity for the root; a
    // marker that now names a different vault is exactly what the guard
    // exists to catch.
    writeFileSync(
      join(vault, "Brain", "vault-id.json"),
      JSON.stringify({
        schema_version: 1,
        vault_id: "ffffffffffffffffffffffffffffffff",
        created_at: "2026-06-03T10:00:00Z",
      }),
      "utf8",
    );
    const next = buildAttestationRecord(vault, manifest, { now: new Date("2026-06-03T10:00:01Z") });
    expect(() => writeAttestationRecord(vault, next)).toThrow(/not the one this process opened/);
  });

  test("listAttestationRecordFiles names every record file, oldest written last", () => {
    const manifest = collectAttestationManifest(vault);
    writeAttestationRecord(
      vault,
      buildAttestationRecord(vault, manifest, { now: new Date("2026-06-03T10:00:00Z") }),
    );
    writeAttestationRecord(
      vault,
      buildAttestationRecord(vault, manifest, { now: new Date("2026-06-03T10:00:01Z") }),
    );
    const files = listAttestationRecordFiles(vault);
    expect(files.length).toBe(2);
    expect(statSync(files[0]!.path).mtimeMs).toBeLessThanOrEqual(statSync(files[1]!.path).mtimeMs);
  });
});
