/**
 * C1 (t_213f356b): client-supplied idempotency-key ledger.
 *
 * The ledger maps a client key -> content hash under
 * `Brain/logs/idempotency/<YYYY-MM>.jsonl` (month-sharded JSONL,
 * mirroring the continuity store's append/list model). It answers three
 * outcomes: `inserted` (first time), `duplicate_match` (same key + same
 * hash), and `payload_mismatch` (same key + different hash — never a
 * silent overwrite).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  computePayloadHash,
  idempotencyLogPath,
  lookupKey,
  REMEMBER_KEY_STATUS,
  rememberKey,
} from "../../../src/core/brain/idempotency-ledger.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-idempotency-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("idempotency ledger", () => {
  test("first remember inserts and persists under the month shard", () => {
    const r = rememberKey(vault, {
      key: "client-key-1",
      contentHash: "hash-a",
      createdAt: "2026-05-14T10:00:00Z",
    });
    expect(r.status).toBe(REMEMBER_KEY_STATUS.inserted);
    expect(r.record.key).toBe("client-key-1");
    expect(r.record.contentHash).toBe("hash-a");

    const shard = idempotencyLogPath(vault, "2026-05");
    expect(existsSync(shard)).toBe(true);
    expect(readFileSync(shard, "utf8")).toContain("client-key-1");
  });

  test("same key + same hash is a deduped no-op (no second line)", () => {
    rememberKey(vault, { key: "k", contentHash: "hash-a", createdAt: "2026-05-14T10:00:00Z" });
    const shard = idempotencyLogPath(vault, "2026-05");
    const before = readFileSync(shard, "utf8");

    const r = rememberKey(vault, {
      key: "k",
      contentHash: "hash-a",
      createdAt: "2026-05-14T10:05:00Z",
    });
    expect(r.status).toBe(REMEMBER_KEY_STATUS.duplicate_match);
    // No new line appended — the shard is byte-identical.
    expect(readFileSync(shard, "utf8")).toBe(before);
  });

  test("same key + different hash reports payload_mismatch and writes nothing", () => {
    rememberKey(vault, { key: "k", contentHash: "hash-a", createdAt: "2026-05-14T10:00:00Z" });
    const shard = idempotencyLogPath(vault, "2026-05");
    const before = readFileSync(shard, "utf8");

    const r = rememberKey(vault, {
      key: "k",
      contentHash: "hash-b",
      createdAt: "2026-05-14T10:05:00Z",
    });
    expect(r.status).toBe(REMEMBER_KEY_STATUS.payload_mismatch);
    // The stored (original) hash is surfaced, never overwritten.
    expect(r.record.contentHash).toBe("hash-a");
    expect(readFileSync(shard, "utf8")).toBe(before);
  });

  test("lookupKey finds a stored key across shards and returns null otherwise", () => {
    rememberKey(vault, {
      key: "k",
      contentHash: "hash-a",
      createdAt: "2026-04-30T23:59:00Z",
      ref: { id: "sig-2026-04-30-topic" },
    });
    const found = lookupKey(vault, "k");
    expect(found?.contentHash).toBe("hash-a");
    expect(found?.ref).toEqual({ id: "sig-2026-04-30-topic" });
    expect(lookupKey(vault, "absent")).toBeNull();
  });

  test("a dedupe survives across a fresh read (the retry-after-crash case)", () => {
    rememberKey(vault, {
      key: "retry-key",
      contentHash: "hash-a",
      createdAt: "2026-05-14T10:00:00Z",
    });
    // A brand-new call (no in-memory state) still sees the prior key.
    const retry = rememberKey(vault, {
      key: "retry-key",
      contentHash: "hash-a",
      createdAt: "2026-05-14T11:00:00Z",
    });
    expect(retry.status).toBe(REMEMBER_KEY_STATUS.duplicate_match);
  });

  test("an empty key is rejected", () => {
    expect(() => rememberKey(vault, { key: "  ", contentHash: "hash-a" })).toThrow();
  });

  test("computePayloadHash is deterministic and key-order-insensitive", () => {
    const a = computePayloadHash({ topic: "t", principle: "p", scope: "s" });
    const b = computePayloadHash({ scope: "s", principle: "p", topic: "t" });
    expect(a).toBe(b);
    const c = computePayloadHash({ topic: "t", principle: "different", scope: "s" });
    expect(c).not.toBe(a);
  });
});

/**
 * Per-device shards (who-wrote-what, Task B / t_1814b9bf). A key
 * remembered on one device must be honoured on another once Syncthing
 * has delivered its shard - and neither device may write the other's
 * file.
 */
describe("idempotency per-device shards", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "o2b-idempotency-cfg-"));
    const configPath = join(configHome, "config.yaml");
    savedEnv["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    savedEnv["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    delete process.env["O2B_DEVICE_ID"];
    writeFileSync(configPath, `vault: ${vault}\ndevice_id: "testdev1"\n`, "utf8");
  });

  afterEach(() => {
    rmSync(configHome, { recursive: true, force: true });
    for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "O2B_DEVICE_ID"]) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a device with an id writes its own shard and never the bare file", () => {
    rememberKey(vault, { key: "k", contentHash: "hash-a", createdAt: "2026-05-14T10:00:00Z" });
    expect(existsSync(idempotencyLogPath(vault, "2026-05", "testdev1"))).toBe(true);
    expect(existsSync(idempotencyLogPath(vault, "2026-05", ""))).toBe(false);
  });

  test("lookupKey finds a key another device remembered", () => {
    const path = idempotencyLogPath(vault, "2026-05", "devb");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ key: "remote", contentHash: "hash-r", createdAt: "2026-05-14T09:00:00Z" })}\n`,
      "utf8",
    );
    expect(lookupKey(vault, "remote")?.contentHash).toBe("hash-r");
  });

  test("a key another device remembered dedupes this device's write", () => {
    const path = idempotencyLogPath(vault, "2026-05", "devb");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ key: "shared", contentHash: "hash-a", createdAt: "2026-05-14T09:00:00Z" })}\n`,
      "utf8",
    );
    const r = rememberKey(vault, {
      key: "shared",
      contentHash: "hash-a",
      createdAt: "2026-05-14T10:00:00Z",
    });
    expect(r.status).toBe(REMEMBER_KEY_STATUS.duplicate_match);
    expect(existsSync(idempotencyLogPath(vault, "2026-05", "testdev1"))).toBe(false);
  });

  test("a sync-conflict copy is not a shard and is never read", () => {
    const dir = dirname(idempotencyLogPath(vault, "2026-05", ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-05.sync-conflict-20260514-120000-ABCDEFG.jsonl"),
      `${JSON.stringify({ key: "conflict", contentHash: "hash-c", createdAt: "2026-05-14T09:00:00Z" })}\n`,
      "utf8",
    );
    expect(lookupKey(vault, "conflict")).toBeNull();
  });

  test("the lock this device takes is on its own shard", () => {
    const own = idempotencyLogPath(vault, "2026-05", "testdev1");
    const handle = acquireLockSync(own);
    try {
      expect(() =>
        rememberKey(vault, { key: "k", contentHash: "hash-a", createdAt: "2026-05-14T10:00:00Z" }),
      ).toThrow("lock busy");
    } finally {
      handle.release();
    }
  });
});
