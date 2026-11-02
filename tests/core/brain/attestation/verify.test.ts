/**
 * The attestation verification kernel (delivery trust, Lane D task D3).
 *
 * Verification is REPORT-ONLY and fail-soft: it recomputes the manifest,
 * classifies every attested shard by walking the chain FORWARD from the
 * attested head (intact, appended, diverged, missing), and reports the
 * store-digest comparison honestly - a legitimately advanced store reads
 * as appended shards plus a false store-digest match, never as a broken
 * record. Nothing here throws, and nothing here writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectAttestationManifest } from "../../../../src/core/brain/attestation/digest.ts";
import { buildAttestationRecord } from "../../../../src/core/brain/attestation/record.ts";
import {
  generateAttestationKeypair,
  signAttestationRecord,
} from "../../../../src/core/brain/attestation/signing.ts";
import { verifyAttestation } from "../../../../src/core/brain/attestation/verify.ts";
import { acquireLogLock, appendLogEvent } from "../../../../src/core/brain/log.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";
import { brainDirs, hookAuditDir, logShardJsonlPath } from "../../../../src/core/brain/paths.ts";
import { appendAuditRecord } from "../../../../src/core/reliability/audit.ts";
import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import { noopSafeguard, SafeguardAbortError } from "../../../../src/core/brain/safeguard.ts";
import { gitStoreDir } from "../../../../src/core/brain/git/store.ts";

const DATE = "2026-06-03";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-attest-verify-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function append(count: number, deviceId = ""): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      { deviceId },
    );
  }
}

/** A signed attestation over the store as it stands right now. */
function signedRecord() {
  generateAttestationKeypair(vault);
  const manifest = collectAttestationManifest(vault);
  const record = buildAttestationRecord(vault, manifest, {
    deviceId: "test-device",
    now: new Date("2026-06-03T10:05:00Z"),
  });
  return signAttestationRecord(record, vault);
}

function shardState(result: ReturnType<typeof verifyAttestation>, shardId: string): string {
  const shard = result.shards.find((s) => s.shardId === shardId);
  expect(shard).toBeDefined();
  return shard!.state;
}

describe("verifyAttestation", () => {
  test("an untouched store is intact everywhere, signature and store digest true", () => {
    append(2);
    append(1, "device-b");
    const record = signedRecord();
    const result = verifyAttestation(vault, record);
    expect(result.recordId).toBe(record.id);
    expect(result.createdAt).toBe(record.createdAt);
    expect(result.signatureValid).toBe(true);
    expect(result.storeDigestMatches).toBe(true);
    expect(result.shards.map((s) => s.state).toSorted()).toEqual(["intact", "intact"]);
  });

  test("legitimate appends read as appended on exactly the appended shards, and the store digest reports false honestly", () => {
    append(2);
    const record = signedRecord();
    append(1);
    append(1, "device-b");
    const result = verifyAttestation(vault, record);
    expect(result.signatureValid).toBe(true);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("appended");
    // The device-b shard was created AFTER the attestation: it is not an
    // attested shard, so it gets no verdict - the attestation anchors a
    // point, and the new shard's appearance is exactly what the store
    // digest drift reports.
    expect(result.shards.find((s) => s.shardId === `${DATE}.device-b.jsonl`)).toBeUndefined();
    // The recomputed manifest differs from the attested one - that is the
    // honest answer, with the appended shards explaining it. The record's
    // own seal still verifies.
    expect(result.storeDigestMatches).toBe(false);
  });

  test("an appended line edited after the attested head diverges its shard", () => {
    append(1);
    const record = signedRecord();
    append(1);
    const path = logShardJsonlPath(vault, DATE, "");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // Rewrite the appended row's payload without re-linking it: the
    // forward walk recomputes each row's hash, so a stale `h` is damage.
    const row = JSON.parse(lines[1]!) as Record<string, unknown>;
    (row["payload"] as Record<string, unknown>)["text"] = "forged after signing";
    lines[1] = JSON.stringify(row);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("diverged");
    expect(result.storeDigestMatches).toBe(false);
  });

  test("a removed line after the attested head diverges its shard", () => {
    append(1);
    const record = signedRecord();
    append(2);
    const path = logShardJsonlPath(vault, DATE, "");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines.splice(1, 1);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("diverged");
  });

  test("the attested head row edited after signing diverges its shard", () => {
    append(1);
    const record = signedRecord();
    // Rewrite the ATTESTED row's payload (the shard's only line, whose
    // `h` is the attested head) and leave its `h` field alone: every
    // stored hash string still lines up, so only recomputing the
    // attested row's own hash can see the edit.
    const path = logShardJsonlPath(vault, DATE, "");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    (row["payload"] as Record<string, unknown>)["text"] = "rewritten after signing";
    lines[0] = JSON.stringify(row);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("diverged");
  });

  test("a garbled line at or after the attested head diverges its shard", () => {
    append(1);
    const record = signedRecord();
    append(1);
    const path = logShardJsonlPath(vault, DATE, "");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // Garble the APPENDED row: an unparseable line after the attested
    // point is an edit the walk must not skip past.
    lines[1] = lines[1]!.slice(0, Math.floor(lines[1]!.length / 2));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("diverged");
  });

  test("a garbled line before the attested head stays the log-chain verifier's question", () => {
    append(1);
    const record = signedRecord();
    const path = logShardJsonlPath(vault, DATE, "");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // Pre-chain history sits before the anchor; damage there is the
    // standing question `o2b brain log verify` asks, and the attested
    // point itself still links up.
    lines.unshift("{not json");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("intact");
  });

  test("a shard rewritten below the attested head diverges rather than pretending", () => {
    append(2);
    const record = signedRecord();
    const path = logShardJsonlPath(vault, DATE, "");
    // Replace the shard with one line that carries the attested head's
    // hash nowhere: the attested row is gone, so no forward walk exists.
    writeFileSync(
      path,
      `${JSON.stringify({ ts: `${DATE}T10:00:00Z`, kind: "note", payload: { text: "x" }, prev: null, h: "f".repeat(64) })}\n`,
      "utf8",
    );
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("diverged");
  });

  test("a deleted shard is missing", () => {
    append(1);
    append(1, "device-b");
    const record = signedRecord();
    rmSync(logShardJsonlPath(vault, DATE, "device-b"));
    const result = verifyAttestation(vault, record);
    expect(shardState(result, `${DATE}.device-b.jsonl`)).toBe("missing");
    expect(shardState(result, `${DATE}.jsonl`)).toBe("intact");
  });

  test("a tampered signature reads as invalid while the shard report still stands", () => {
    append(1);
    const record = signedRecord();
    const forged = { ...record, signature: "A".repeat(88) };
    const result = verifyAttestation(vault, forged);
    expect(result.signatureValid).toBe(false);
    expect(shardState(result, `${DATE}.jsonl`)).toBe("intact");
  });

  test("never throws: a held log lock degrades the store verdict, not the report", () => {
    append(1);
    const record = signedRecord();
    // The production lock helper, not a hand-rolled lockSync call: the
    // fixture reproduces exactly the contention the appender takes the
    // same lock for, and follows the site if it moves.
    const release = acquireLogLock(brainDirs(vault).log);
    try {
      let result: ReturnType<typeof verifyAttestation> | null = null;
      expect(() => {
        result = verifyAttestation(vault, record);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.signatureValid).toBe(true);
      expect(result!.storeDigestMatches).toBe(false);
    } finally {
      release();
    }
  });

  test("performs no writes", () => {
    append(1);
    const record = signedRecord();
    const before = new Set(
      [join(vault, "Brain", "log"), join(vault, ".open-second-brain", "attestations")].flatMap(
        (dir) => (existsSync(dir) ? [...readdirSync(dir)] : []),
      ),
    );
    verifyAttestation(vault, record);
    const after = new Set(
      [join(vault, "Brain", "log"), join(vault, ".open-second-brain", "attestations")].flatMap(
        (dir) => (existsSync(dir) ? [...readdirSync(dir)] : []),
      ),
    );
    expect([...after].toSorted()).toEqual([...before].toSorted());
  });

  test("a new hook-audit week shard after signing is growth, not unexplained drift", () => {
    // The audit writer names its files `<ISO-week>[.<device>].jsonl`, so
    // the next week boundary creates a file no attestation listed - the
    // same normal growth a new log day is, and never damage.
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: "2026-05-28T10:00:00Z",
      actor: "@tester",
      action: "capture",
      target: "session-1",
      ok: true,
    });
    const record = signedRecord();
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: `${DATE}T10:00:00Z`,
      actor: "@tester",
      action: "capture",
      target: "session-2",
      ok: true,
    });
    const result = verifyAttestation(vault, record);
    expect(result.signatureValid).toBe(true);
    expect(result.unexplainedDrift).toBe(false);
    expect(result.storeDigestMatches).toBe(false);
  });

  test("an invalid name in an attested ledger directory is still drift", () => {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: "2026-05-28T10:00:00Z",
      actor: "@tester",
      action: "capture",
      target: "session-1",
      ok: true,
    });
    const record = signedRecord();
    writeFileSync(join(hookAuditDir(vault), "not-a-week.jsonl"), "{}\n", "utf8");
    const result = verifyAttestation(vault, record);
    expect(result.unexplainedDrift).toBe(true);
  });

  test("a removed attested ledger file is still drift", () => {
    const file = appendAuditRecord(hookAuditDir(vault), {
      timestamp: "2026-05-28T10:00:00Z",
      actor: "@tester",
      action: "capture",
      target: "session-1",
      ok: true,
    });
    const record = signedRecord();
    rmSync(file);
    const result = verifyAttestation(vault, record);
    expect(result.unexplainedDrift).toBe(true);
  });

  test("a first continuity month created after signing is growth, not unexplained drift", () => {
    // The continuity store lives beside the log under Brain/log and may
    // not exist at all when the store is signed; its first month shard
    // is exactly the ledger subdirectory growth the rule allows, as long
    // as every name it brings parses under the month grammar.
    const record = signedRecord();
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: `${DATE}T10:30:00Z`,
      payload: { text: "the first continuity record" },
    });
    const result = verifyAttestation(vault, record);
    expect(result.signatureValid).toBe(true);
    expect(result.unexplainedDrift).toBe(false);
    expect(result.storeDigestMatches).toBe(false);
  });

  test("a first repository store created after signing is growth, not unexplained drift", () => {
    // The git record store may not exist at all when the vault is
    // signed; its first link creates the store directory with exactly
    // the writer's initial layout - the ingest watermark, the rendered
    // digest, and the commits shard - which is growth the ledger rule
    // can name, never damage.
    const record = signedRecord();
    const store = gitStoreDir(vault, "some-repo");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "state.json"),
      `${JSON.stringify({
        repoPath: "/tmp/some-repo",
        lastSha: "0".repeat(40),
        lastIngestedAt: `${DATE}T10:30:00Z`,
      })}\n`,
      "utf8",
    );
    writeFileSync(join(store, "digest.md"), "# some-repo\n\nthe digest projection\n", "utf8");
    writeFileSync(join(store, "commits.jsonl"), "", "utf8");
    const result = verifyAttestation(vault, record);
    expect(result.signatureValid).toBe(true);
    expect(result.unexplainedDrift).toBe(false);
    expect(result.storeDigestMatches).toBe(false);
  });

  test("an unrelated file in a new repository store is still drift", () => {
    const record = signedRecord();
    const store = gitStoreDir(vault, "some-repo");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "state.json"), "{}\n", "utf8");
    writeFileSync(join(store, "digest.md"), "# some-repo\n", "utf8");
    writeFileSync(join(store, "commits.jsonl"), "", "utf8");
    writeFileSync(join(store, "notes.txt"), "planted\n", "utf8");
    const result = verifyAttestation(vault, record);
    expect(result.unexplainedDrift).toBe(true);
  });

  test("an addition to Brain/preferences stays drift: those files are authored state", () => {
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-one.md"),
      "---\ntitle: one\n---\n\nx\n",
    );
    const record = signedRecord();
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-two.md"),
      "---\ntitle: two\n---\n\nx\n",
    );
    const result = verifyAttestation(vault, record);
    expect(result.unexplainedDrift).toBe(true);
  });

  test("a Safeguard is accepted and consulted; a progress sink is accepted", () => {
    append(1);
    const record = signedRecord();
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
    const result = verifyAttestation(vault, record, {
      safeguard: guarded,
      onProgress: () => {},
    });
    expect(checkpoints).toBeGreaterThanOrEqual(1);
    expect(result.shards.length).toBe(1);
  });

  test("a safeguard abort during the manifest recompute aborts instead of reading as drift", () => {
    append(1);
    const record = signedRecord();
    // Checkpoint order for a one-shard record: post-signature, the shard
    // walk, the pre-digest boundary, then the recompute's own boundaries.
    // Aborting from the fourth call onward lands inside the recompute -
    // the arm whose catch-all would otherwise fold the abort into a
    // normal-looking `storeDigestMatches: false`.
    let checkpoints = 0;
    const aborting = Object.freeze({
      operation: "attestation-test",
      timeoutMs: 1_000,
      checkpoint: () => {
        checkpoints++;
        if (checkpoints >= 4) {
          throw new SafeguardAbortError("attestation-test");
        }
      },
    });
    let thrown: unknown = null;
    try {
      verifyAttestation(vault, record, { safeguard: aborting });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SafeguardAbortError);
  });
});
