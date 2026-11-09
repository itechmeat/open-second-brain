/**
 * Attestation records on a store-only machine (task 2.10, design D14
 * item 6): an attestation is a shared `attestation` record in the brain
 * store, every machine that holds `shared` lists and reads it, and the
 * key that signs it stays in this machine's device-local state. Nothing
 * under the vault changes. Unswitched, the record stays one JSON file per
 * signing run under the vault's derived store, with no store record.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { collectAttestationManifest } from "../../../../src/core/brain/attestation/digest.ts";
import {
  ATTESTATION_KIND,
  attestationsDir,
  buildAttestationRecord,
  listAttestationRecordFiles,
  readAttestationEntry,
  writeAttestationRecord,
  type AttestationRecord,
} from "../../../../src/core/brain/attestation/record.ts";
import {
  attestationKeyPaths,
  generateAttestationKeypair,
  signAttestationRecord,
  verifyAttestationSignature,
} from "../../../../src/core/brain/attestation/signing.ts";
import { attestationCheck } from "../../../../src/core/brain/doctor/attestation-check.ts";
import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { isPathInsideResolved } from "../../../../src/core/store/store-paths.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
import { shippedFormatDoc } from "../../../../src/core/store/format-doc.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  resetVaultIdentityPins();
});

const T1 = new Date("2026-11-06T10:00:00.100Z");
const T2 = new Date("2026-11-06T11:00:00.200Z");

function signed(vault: string, now: Date, deviceId = "dev-a"): AttestationRecord {
  const sealed = buildAttestationRecord(vault, collectAttestationManifest(vault), {
    now,
    deviceId,
  });
  return signAttestationRecord(sealed, vault);
}

function attestationRecords(e: StoreEnv, partition: "shared" | "private") {
  return partitionRecords(e.storeRoot, partition).filter((r) => r.kind === ATTESTATION_KIND);
}

describe("attestations once switched", () => {
  test("a signed attestation is one shared store record and nothing under the vault", () => {
    env = makeStoreEnv("osb-wp7a-attest-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    const keys = attestationKeyPaths(env.vault);
    expect(isPathInsideResolved(keys.privatePath, env.vault, process.platform)).toBe(false);

    const before = digestVaultTree(env.vault);
    const record = signed(env.vault, T1);
    const { path } = writeAttestationRecord(env.vault, record);
    expect(digestVaultTree(env.vault)).toBe(before);
    expect(isPathInsideResolved(path, env.storeRoot, process.platform)).toBe(true);

    const stored = attestationRecords(env, "shared");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body["record"]).toEqual(JSON.parse(JSON.stringify(record)));
    expect(attestationRecords(env, "private")).toEqual([]);

    const entries = listAttestationRecordFiles(env.vault);
    expect(entries.map((e) => e.name)).toEqual([`${record.id}.json`]);
    const read = readAttestationEntry(entries[0]!);
    expect(read).toEqual(record);
    expect(verifyAttestationSignature(read, env.vault)).toBe(true);
  });

  test("the same attestation id is refused a second time", () => {
    env = makeStoreEnv("osb-wp7a-attest-dup-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    const record = signed(env.vault, T1);
    writeAttestationRecord(env.vault, record);
    expect(() => writeAttestationRecord(env!.vault, record)).toThrow(/already/);
    expect(attestationRecords(env, "shared")).toHaveLength(1);
  });

  test("another device's record and a device-local file list together, oldest first", () => {
    env = makeStoreEnv("osb-wp7a-attest-peer-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    // A file restored into device-local state from the migration backup.
    const older = signed(env.vault, T1);
    const localFile = join(attestationsDir(env.vault), `${older.id}.json`);
    expect(isPathInsideResolved(localFile, env.vault, process.platform)).toBe(false);
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, `${JSON.stringify(older, null, 2)}\n`);
    // A record another machine signed and sync delivered.
    const peer = signed(env.vault, T2, "dev-b");
    appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: ATTESTATION_KIND,
      agent: "o2b",
      body: { record: JSON.parse(JSON.stringify(peer)) },
    });

    const entries = listAttestationRecordFiles(env.vault);
    expect(entries.map((e) => e.name)).toEqual([`${older.id}.json`, `${peer.id}.json`]);
    expect(entries.map((e) => readAttestationEntry(e).deviceId)).toEqual(["dev-a", "dev-b"]);
  });

  test("a malformed store record is refused by name when read", () => {
    env = makeStoreEnv("osb-wp7a-attest-bad-", { dualWrite: false });
    switchDevice(env.storeRoot);
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "events",
      kind: ATTESTATION_KIND,
      agent: "o2b",
      body: { record: { id: "attest-20260101T000000000Z", schemaVersion: "o2b.attestation.v9" } },
    });
    const [entry] = listAttestationRecordFiles(env.vault);
    expect(entry).toBeDefined();
    expect(() => readAttestationEntry(entry!)).toThrow(/not supported/);
  });
});

function doctorFindings(vault: string, now: Date, configPath?: string): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  attestationCheck.run(
    {
      vault,
      now,
      config: undefined,
      dbPath: undefined,
      configPath,
      knownBasenames: new Set(),
      idIndex: new Map(),
      preferences: [],
      logs: [],
    },
    out,
  );
  return out;
}

function appendPeerAttestation(e: StoreEnv, record: AttestationRecord): void {
  appendRecord(openStore({ root: e.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: ATTESTATION_KIND,
    agent: "o2b",
    body: { record: JSON.parse(JSON.stringify(record)) },
  });
}

describe("attestations once switched, what cannot be read or checked", () => {
  test.skipIf(process.platform === "win32")(
    "an unreadable events shard lists as one unreadable row, and doctor names the state unmeasured",
    () => {
      env = makeStoreEnv("osb-attest-unreadable-", { dualWrite: false });
      switchDevice(env.storeRoot);
      generateAttestationKeypair(env.vault);
      const { path } = writeAttestationRecord(env.vault, signed(env.vault, T1));
      // A record another device signed stays readable next to the damage.
      const peer = buildAttestationRecord(env.vault, collectAttestationManifest(env.vault), {
        now: T2,
        deviceId: "dev-b",
      });
      appendPeerAttestation(env, { ...peer, signature: "AAAA" });
      const copy = `${path}.orig`;
      renameSync(path, copy);
      symlinkSync(copy, path);
      const entries = listAttestationRecordFiles(env.vault);
      const readable = entries.filter((e) => {
        try {
          readAttestationEntry(e);
          return true;
        } catch (err) {
          expect((err as Error).message).toMatch(/could not all be read/);
          return false;
        }
      });
      expect(readable.map((e) => e.name)).toEqual([`${peer.id}.json`]);
      expect(entries).toHaveLength(2);
      // Signing fails closed: the unreadable shard may hold the new id.
      expect(() =>
        writeAttestationRecord(
          env!.vault,
          signed(env!.vault, new Date("2026-11-06T12:00:00.300Z")),
        ),
      ).toThrow(/could not all be read/);
      const findings = doctorFindings(env.vault, new Date("2026-11-07T00:00:00Z"));
      expect(findings.uncertain.map((u) => u.code)).toContain("attestation-state-unmeasured");
    },
  );

  test("a corrupt attestation line before a readable one lists as unreadable, and signing refuses", () => {
    env = makeStoreEnv("osb-attest-corrupt-line-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    writeAttestationRecord(env.vault, signed(env.vault, T1));
    const peer = buildAttestationRecord(env.vault, collectAttestationManifest(env.vault), {
      now: T2,
      deviceId: "dev-b",
    });
    appendPeerAttestation(env, { ...peer, signature: "AAAA" });
    // A later record of dev-b's shard stays readable.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: "note",
      agent: "o2b",
      body: { n: 1 },
    });
    const dir = join(env.storeRoot, "shared", "events", "dev-b");
    const shard = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(shard, "utf8").split("\n");
    lines[0] = lines[0]!.replace('"signature":"AAAA"', '"signature":"BBBB"');
    writeFileSync(shard, lines.join("\n"));
    const entries = listAttestationRecordFiles(env.vault);
    expect(entries.some((e) => e.name.includes("shared/events/dev-b/"))).toBe(true);
    expect(() =>
      writeAttestationRecord(env!.vault, signed(env!.vault, new Date("2026-11-06T12:00:00.300Z"))),
    ).toThrow(/could not all be read/);
  });

  test("an id a device-local file already holds is refused", () => {
    env = makeStoreEnv("osb-attest-dup-file-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    const record = signed(env.vault, T1);
    const localFile = join(attestationsDir(env.vault), `${record.id}.json`);
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, `${JSON.stringify(record, null, 2)}\n`);
    expect(() => writeAttestationRecord(env!.vault, record)).toThrow(/already/);
    expect(attestationRecords(env, "shared")).toEqual([]);
  });

  test("a newer attestation another device signed is no signature finding here", () => {
    env = makeStoreEnv("osb-attest-peer-doctor-", { dualWrite: false });
    switchDevice(env.storeRoot);
    generateAttestationKeypair(env.vault);
    writeAttestationRecord(env.vault, signed(env.vault, T1));
    // dev-b signs with its own key: a record this machine's key cannot verify.
    const peer = buildAttestationRecord(env.vault, collectAttestationManifest(env.vault), {
      now: T2,
      deviceId: "dev-b",
    });
    appendPeerAttestation(env, { ...peer, signature: "AAAA" });
    const findings = doctorFindings(env.vault, new Date("2026-11-07T00:00:00Z"));
    expect(findings.issues.map((i) => i.message).join("\n")).not.toContain("signature");
  });

  test("an attestation of the removed legacy log is unmeasured, not damage", () => {
    env = makeStoreEnv("osb-attest-log-gone-", { dualWrite: false });
    appendLogEvent(env.vault, {
      timestamp: "2026-11-01T10:00:00Z",
      eventType: "note",
      body: { text: "before the switch", agent: "@tester" },
    });
    generateAttestationKeypair(env.vault);
    const before = signed(env.vault, T1);
    expect(Object.keys(before.manifest.logHeads).length).toBeGreaterThan(0);
    switchDevice(env.storeRoot);
    // The migration keeps the record in the device-local state, and the
    // legacy log leaves with the tree.
    const localFile = join(attestationsDir(env.vault), `${before.id}.json`);
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, `${JSON.stringify(before, null, 2)}\n`);
    rmSync(join(env.vault, "Brain", "log"), { recursive: true, force: true });
    const findings = doctorFindings(env.vault, new Date("2026-11-07T00:00:00Z"));
    const messages = findings.issues.map((i) => i.message).join("\n");
    expect(messages).not.toContain("diverged or went missing");
    expect(messages).not.toContain("no longer matches the attested manifest");
    expect(findings.uncertain.map((u) => u.message).join("\n")).toContain(
      "can no longer be verified",
    );
  });

  test("the doctor's explicit machine config decides that the legacy log is gone", () => {
    env = makeStoreEnv("osb-attest-log-gone-config-", { dualWrite: false });
    appendLogEvent(env.vault, {
      timestamp: "2026-11-01T10:00:00Z",
      eventType: "note",
      body: { text: "before the switch", agent: "@tester" },
    });
    generateAttestationKeypair(env.vault);
    const before = signed(env.vault, T1);
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain", "log"), { recursive: true, force: true });
    // Only the explicit config names this machine's device: the process's
    // own config reads as unswitched and lists the record where it was.
    delete process.env["O2B_DEVICE_ID"];
    const localFile = join(attestationsDir(env.vault), `${before.id}.json`);
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, `${JSON.stringify(before, null, 2)}\n`);
    const explicit = join(env.parent, "explicit.yaml");
    writeFileSync(explicit, `vault: ${env.vault}\ndevice_id: dev-a\n`);
    const findings = doctorFindings(env.vault, new Date("2026-11-07T00:00:00Z"), explicit);
    expect(findings.issues.map((i) => i.message).join("\n")).not.toContain(
      "diverged or went missing",
    );
    expect(findings.uncertain.map((u) => u.message).join("\n")).toContain(
      "can no longer be verified",
    );
  });
});

describe("attestations on an unswitched machine", () => {
  test("stay one file under the vault, with no store record", () => {
    env = makeStoreEnv("osb-wp7a-attest-legacy-");
    generateAttestationKeypair(env.vault);
    const record = signed(env.vault, T1);
    const { path } = writeAttestationRecord(env.vault, record);
    expect(isPathInsideResolved(path, env.vault, process.platform)).toBe(true);
    expect(attestationRecords(env, "shared")).toEqual([]);
    const [entry] = listAttestationRecordFiles(env.vault);
    expect(entry?.path).toBe(path);
    expect(readAttestationEntry(entry!)).toEqual(record);
  });
});

describe("FORMAT.md", () => {
  const doc = shippedFormatDoc();

  test("documents the attestation kind, the reinforce reset row and the device-local surfaces", () => {
    expect(doc).toMatch(new RegExp(`^- \`${ATTESTATION_KIND}\`:`, "m"));
    expect(doc).toContain('{ "ts": <unix ms>, "reset": true }');
    const deviceLocal = doc.slice(doc.indexOf("## Device-local state"));
    const section = deviceLocal.slice(0, deviceLocal.indexOf("\n## ", 1));
    expect(section).toContain("- search activation:");
    expect(section).toContain("- dream workruns:");
  });
});
