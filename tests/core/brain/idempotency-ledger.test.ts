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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
