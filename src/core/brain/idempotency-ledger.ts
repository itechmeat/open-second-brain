/**
 * Client-supplied idempotency-key ledger (C1 / t_213f356b).
 *
 * OSB is multi-runtime (Hermes, Claude Code, Codex, opencode) and the
 * feedback / signal write path is a file-append operation. A retried or
 * double-delivered tool call can therefore append a duplicate record,
 * and the implicit slug-based dedupe silently MERGES genuinely-different
 * content that happens to share a topic slug. This ledger gives those
 * writes a first-class idempotency key:
 *
 *   - {@link rememberKey} records `key -> contentHash`. Same key + same
 *     hash is a deduped no-op (`duplicate_match`); same key + different
 *     hash is an explicit `payload_mismatch` (never a silent overwrite);
 *     an unseen key is `inserted`.
 *   - {@link lookupKey} reads the stored record for a key (audit / C6 /
 *     the pre-write dedupe consult the writers perform).
 *
 * Storage mirrors the continuity store's append/list model: month-sharded
 * JSONL under `<vault>/Brain/logs/idempotency/<YYYY-MM>.jsonl`, appended
 * under a per-shard lock. Reads scan every shard because a retry may land
 * in a later month than the original write.
 *
 * Concurrency boundary (inherited from the continuity model): the
 * check-and-append is atomic within a single shard under its lock. Two
 * genuinely-concurrent FIRST writers of the same key can both observe
 * "absent" and both proceed — a rare race the append-only store does not
 * guard. The primary target — a SEQUENTIAL retry after a crash / double
 * delivery — is fully deduped because the prior write is already durable
 * on disk before the retry runs.
 *
 * The kernel stays deterministic: no LLM, no wall-clock beyond the
 * caller-supplied (or defaulted) `createdAt`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_ROOT_REL, ensureInsideVault } from "./paths.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";

/** Month-sharded JSONL root, distinct from `Brain/log/` (the human trail). */
const IDEMPOTENCY_REL = `${BRAIN_ROOT_REL}/logs/idempotency`;

/** Hard cap on a client key. Long enough for `<session-id>:<slug>` joins. */
const KEY_MAX_LEN = 256;

export const REMEMBER_KEY_STATUS = Object.freeze({
  inserted: "inserted",
  duplicate_match: "duplicate_match",
  payload_mismatch: "payload_mismatch",
} as const);

export type RememberKeyStatus = (typeof REMEMBER_KEY_STATUS)[keyof typeof REMEMBER_KEY_STATUS];

/** One durable ledger entry. `ref` is an opaque, JSON-serialisable set of
 * coordinates the caller stores on insert so a later dedupe can return the
 * original write's identity (e.g. `{ id, path }`). */
export interface IdempotencyRecord {
  readonly key: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly ref?: Readonly<Record<string, unknown>>;
}

export interface RememberKeyInput {
  readonly key: string;
  readonly contentHash: string;
  /** Canonical UTC ISO-8601; defaults to `isoSecond(new Date())`. Drives the
   * month shard, so a backfilled write lands in its real month. */
  readonly createdAt?: string;
  readonly ref?: Readonly<Record<string, unknown>>;
}

export interface RememberKeyResult {
  readonly status: RememberKeyStatus;
  /**
   * The effective record: the freshly-inserted one on `inserted`, or the
   * PRE-EXISTING stored record on `duplicate_match` / `payload_mismatch`
   * (so callers can read the original `contentHash` / `ref`).
   */
  readonly record: IdempotencyRecord;
}

/**
 * Thrown by the writers ({@link import('./signal.ts').writeSignal} et al.)
 * when a supplied idempotency key was already used with a DIFFERENT
 * payload. Carries both hashes so the caller can explain the conflict.
 * The ledger itself never throws this — it returns `payload_mismatch` and
 * the writer decides to surface it as an error (C4's batch path inspects
 * the status instead, without aborting the whole batch).
 */
export class IdempotencyPayloadMismatchError extends Error {
  readonly key: string;
  readonly existingHash: string;
  readonly attemptedHash: string;

  constructor(key: string, existingHash: string, attemptedHash: string) {
    super(
      `idempotency key '${key}' was already used with a different payload ` +
        `(stored ${existingHash.slice(0, 12)}…, attempted ${attemptedHash.slice(0, 12)}…). ` +
        "Reusing a key with different content is rejected to avoid a silent overwrite.",
    );
    this.name = "IdempotencyPayloadMismatchError";
    this.key = key;
    this.existingHash = existingHash;
    this.attemptedHash = attemptedHash;
  }
}

/**
 * SHA-256 (hex) over a canonical, key-order-insensitive JSON encoding of
 * `fields`. `undefined`-valued keys are dropped so an optional field left
 * unset hashes identically to it being absent. Callers pass the SEMANTIC
 * payload of a write (never timestamps or allocated slugs) so a retry with
 * the same content produces the same hash.
 */
export function computePayloadHash(fields: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order,
 * `undefined` object entries omitted. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function idempotencyLogPath(vault: string, month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`invalid idempotency month: ${month}`);
  return ensureInsideVault(join(vault, IDEMPOTENCY_REL, `${month}.jsonl`), vault);
}

/**
 * Look up the stored record for a client key across all month shards.
 * Returns the first-written record for the key (shards read in ascending
 * month order, lines in append order) or `null` when the key is unseen.
 */
export function lookupKey(vault: string, key: string): IdempotencyRecord | null {
  const normalised = normaliseKey(key);
  for (const record of readAllRecords(vault)) {
    if (record.key === normalised) return record;
  }
  return null;
}

/**
 * Record `key -> contentHash`. See {@link RememberKeyResult} for the three
 * outcomes. Only `inserted` appends a line; `duplicate_match` and
 * `payload_mismatch` write nothing.
 */
export function rememberKey(vault: string, input: RememberKeyInput): RememberKeyResult {
  const key = normaliseKey(input.key);
  const contentHash = requireHash(input.contentHash);
  const createdAt = input.createdAt ?? isoSecond(new Date());
  const month = monthOf(createdAt);

  mkdirSync(join(vault, IDEMPOTENCY_REL), { recursive: true });
  const shardPath = idempotencyLogPath(vault, month);
  const handle = acquireLockSync(shardPath);
  try {
    // Re-scan under the lock so a same-shard concurrent insert is caught.
    const existing = lookupKey(vault, key);
    if (existing) {
      return {
        status:
          existing.contentHash === contentHash
            ? REMEMBER_KEY_STATUS.duplicate_match
            : REMEMBER_KEY_STATUS.payload_mismatch,
        record: existing,
      };
    }
    const record: IdempotencyRecord = Object.freeze({
      key,
      contentHash,
      createdAt,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    });
    writeFileSync(shardPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
    return { status: REMEMBER_KEY_STATUS.inserted, record };
  } finally {
    handle.release();
  }
}

// ----- internals -----------------------------------------------------------

function normaliseKey(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("idempotency key must be a non-empty string");
  }
  const trimmed = key.trim();
  if (trimmed.length > KEY_MAX_LEN) {
    throw new Error(`idempotency key too long (max ${KEY_MAX_LEN} chars)`);
  }
  return trimmed;
}

function requireHash(hash: unknown): string {
  if (typeof hash !== "string" || hash.trim() === "") {
    throw new Error("idempotency contentHash must be a non-empty string");
  }
  return hash.trim();
}

function monthOf(createdAt: string): string {
  const month = createdAt.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(
      `idempotency createdAt must start with YYYY-MM; got ${JSON.stringify(createdAt)}`,
    );
  }
  return month;
}

function readAllRecords(vault: string): IdempotencyRecord[] {
  const dir = ensureInsideVault(join(vault, IDEMPOTENCY_REL), vault);
  if (!existsSync(dir)) return [];
  const records: IdempotencyRecord[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = ensureInsideVault(join(dir, name), vault);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as IdempotencyRecord);
      } catch {
        continue;
      }
    }
  }
  return records;
}
