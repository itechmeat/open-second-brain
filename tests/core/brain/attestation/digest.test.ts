/**
 * The attestation manifest kernel (delivery trust, Lane D task D1).
 *
 * The manifest is the thing a signature is computed over, so the tests
 * here hold it to three properties: every head it records is the chain
 * head the appender would have linked to, the collection is reproducible
 * while the store stands still, and the digest is exactly
 * `sha256Hex(canonicalJson(manifest))` - the one encoding
 * `src/core/integrity/digest.ts` persists. A head collected lock-free
 * would be a head the appender may already have superseded, so the lock
 * discipline is asserted by name too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ATTESTATION_MANIFEST_SCHEMA_VERSION,
  attestationStoreDigest,
  collectAttestationManifest,
} from "../../../../src/core/brain/attestation/digest.ts";
import {
  acquireLogLock,
  collectLogShardHeads,
  appendLogEvent,
} from "../../../../src/core/brain/log.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";
import { noopSafeguard } from "../../../../src/core/brain/safeguard.ts";
import { canonicalJson, sha256Hex } from "../../../../src/core/integrity/digest.ts";
import {
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  setState,
} from "../../../../src/core/search/store/state.ts";

const DATE = "2026-06-03";

let tmp: string;
let vault: string;
let configHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-attest-digest-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  configHome = mkdtempSync(join(tmpdir(), "o2b-attest-digest-cfg-"));
  const configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function append(count: number, deviceId = ""): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${deviceId} ${i}`, agent: "@tester" },
      },
      { deviceId },
    );
  }
}

/** The `h` of the last chained line of a shard, read the way an operator would. */
function chainHeadOf(relName: string): string {
  const lines = readFileSync(join(brainDirs(vault).log, relName), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]!) as Record<string, unknown>;
    if (typeof row["h"] === "string" && row["h"] !== "") return row["h"];
  }
  throw new Error(`no chained line in ${relName}`);
}

/** A minimal index file carrying the three embedding-ABI state keys. */
function seedIndex(model: string): void {
  const dbPath = join(vault, ".open-second-brain", "brain.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    setState(db, EMBEDDING_MODEL_STATE_KEY, model);
    setState(db, EMBEDDING_DIMENSION_STATE_KEY, "64");
    setState(db, EMBEDDING_VEC_VERSION_STATE_KEY, "v0.8.0");
  } finally {
    db.close();
  }
}

describe("collectLogShardHeads", () => {
  test("records one head per JSONL shard, each the chain head the appender linked", () => {
    append(2);
    append(1, "device-b");
    const heads = collectLogShardHeads(vault);
    expect(Object.keys(heads).toSorted()).toEqual([`${DATE}.device-b.jsonl`, `${DATE}.jsonl`]);
    expect(heads[`${DATE}.jsonl`]).toBe(chainHeadOf(`${DATE}.jsonl`));
    expect(heads[`${DATE}.device-b.jsonl`]).toBe(chainHeadOf(`${DATE}.device-b.jsonl`));
  });

  test("shares the appender's lock: a held log lock is a refusal, never a lock-free read", () => {
    append(1);
    const logDir = brainDirs(vault).log;
    // The production lock helper, not a hand-rolled lockSync call: its
    // bounded retry still ends in the ELOCKED throw when the lock is
    // held, which is the refusal under test.
    const release = acquireLogLock(logDir);
    try {
      let caught: NodeJS.ErrnoException | null = null;
      try {
        collectLogShardHeads(vault);
      } catch (err) {
        caught = err as NodeJS.ErrnoException;
      }
      expect(caught?.code).toBe("ELOCKED");
    } finally {
      release();
    }
  });

  test("never claims a head the appender already superseded", () => {
    append(1);
    const firstHead = chainHeadOf(`${DATE}.jsonl`);
    append(1);
    const heads = collectLogShardHeads(vault);
    expect(heads[`${DATE}.jsonl`]).not.toBe(firstHead);
    expect(heads[`${DATE}.jsonl`]).toBe(chainHeadOf(`${DATE}.jsonl`));
  });

  test("a vault with no log yields an empty map and writes nothing to stderr", () => {
    rmSync(join(vault, "Brain", "log"), { recursive: true, force: true });
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(collectLogShardHeads(vault)).toEqual({});
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toEqual([]);
  });
});

describe("collectAttestationManifest", () => {
  test("carries the manifest schema version and the vault identity id", () => {
    const identity = writeVaultIdentity(vault);
    const manifest = collectAttestationManifest(vault);
    expect(manifest.schemaVersion).toBe(ATTESTATION_MANIFEST_SCHEMA_VERSION);
    expect(ATTESTATION_MANIFEST_SCHEMA_VERSION).toBe("o2b.attestation.manifest.v1");
    expect(manifest.vaultIdentityId).toBe(identity.vault_id);
  });

  test("binds the log head map and reports no index stamp when no store exists", () => {
    append(1, "device-b");
    const manifest = collectAttestationManifest(vault);
    expect(manifest.logHeads).toEqual(collectLogShardHeads(vault));
    expect(manifest.indexStamp).toBeNull();
  });

  test("the index stamp is the store's current stamp token, and moves when the store restamps", () => {
    seedIndex("model-a");
    const before = collectAttestationManifest(vault);
    expect(before.indexStamp).toMatch(/^[0-9a-f]{64}$/);
    expect(collectAttestationManifest(vault).indexStamp).toBe(before.indexStamp);
    seedIndex("model-b");
    expect(collectAttestationManifest(vault).indexStamp).not.toBe(before.indexStamp);
  });

  test("ledger inventories list exactly the doctor-swept ledger directories' files", () => {
    append(1);
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(join(vault, "Brain", ".state", "session-lineage.jsonl"), "{}\n", "utf8");
    mkdirSync(join(vault, "Brain", "metrics"), { recursive: true });
    writeFileSync(join(vault, "Brain", "metrics", "surface-a.tester.jsonl"), "{}\n", "utf8");
    // Not a swept ledger directory: its files must not appear anywhere.
    mkdirSync(join(vault, "Brain", "entities", "topic"), { recursive: true });
    writeFileSync(join(vault, "Brain", "entities", "topic", "idea.md"), "x\n", "utf8");

    const inventories = collectAttestationManifest(vault).ledgerInventories;
    const keys = Object.keys(inventories).toSorted();
    expect(keys).toContain("Brain/log");
    expect(keys).toContain("Brain/.state");
    expect(keys).toContain("Brain/metrics");
    expect(inventories["Brain/log"]).toContain(`${DATE}.jsonl`);
    expect(inventories["Brain/.state"]).toEqual(["session-lineage.jsonl"]);
    expect(inventories["Brain/metrics"]).toEqual(["surface-a.tester.jsonl"]);
    for (const key of keys) expect(key).not.toContain("entities");
  });

  test("the store digest is stable while the store stands still and moves with a shard head", () => {
    append(1);
    const first = collectAttestationManifest(vault);
    expect(attestationStoreDigest(first)).toBe(
      attestationStoreDigest(collectAttestationManifest(vault)),
    );
    append(1);
    expect(attestationStoreDigest(collectAttestationManifest(vault))).not.toBe(
      attestationStoreDigest(first),
    );
  });

  test("the digest is sha256Hex(canonicalJson(manifest)) byte-for-byte", () => {
    append(1);
    seedIndex("model-a");
    const manifest = collectAttestationManifest(vault);
    expect(attestationStoreDigest(manifest)).toBe(sha256Hex(canonicalJson(manifest)));
  });

  test("a Safeguard is accepted and consulted on the walk", () => {
    append(1);
    let checkpoints = 0;
    const base = noopSafeguard("attestation-test");
    const guarded = Object.freeze({
      operation: base.operation,
      timeoutMs: base.timeoutMs,
      checkpoint: () => {
        checkpoints++;
        base.checkpoint();
      },
    });
    collectAttestationManifest(vault, { safeguard: guarded });
    expect(checkpoints).toBeGreaterThanOrEqual(1);
  });
});
