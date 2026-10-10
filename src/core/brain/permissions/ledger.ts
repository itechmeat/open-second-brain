/**
 * The decision ledger (write-side-trust, Task 2).
 *
 * The queryable record of which rule allowed, asked or denied which
 * operation: JSONL month/device shards under `Brain/logs/decisions/`, on
 * the idempotency-ledger model. The per-device shard is the Syncthing
 * answer - two machines never append to one file - and the merged read
 * orders by (timestamp, shard id, line), so every device replays the same
 * sequence no matter the order the shards arrived in.
 *
 * The append contract is absolute: a failed append NEVER throws. The
 * ledger rides behind gates that must refuse or stage a write even when
 * accountability cannot be recorded, so every failure - a malformed
 * timestamp, an unwritable directory, a lock another writer holds - comes
 * back as `{ logged: false, audit_reason }` for the caller to surface.
 * Nothing here is silent: the audit reason is the caller's evidence.
 *
 * LEAF MODULE like its sibling `document.ts`: it imports the shared shard
 * grammar and the Brain root name, and nothing that reaches back into the
 * gates, so a guard can record a refusal without importing the layer the
 * refusal came from.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { ensureInsideVault } from "../../path-safety.ts";
import {
  JSONL_LEDGER_EXT,
  listShardedFiles,
  mergeShardedRows,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
  type ShardedRow,
} from "../ledger-shards.ts";
import { BRAIN_ROOT_REL } from "../path-constants.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import type { PermissionAction } from "./document.ts";

/** Month-sharded JSONL root under `Brain/logs/`, beside the idempotency ledger. */
const DECISIONS_REL = `${BRAIN_ROOT_REL}/logs/decisions`;

/** Shard base: one file per UTC month, per device. */
const MONTH_BASE = "\\d{4}-\\d{2}";
const MONTH_RE = new RegExp(`^${MONTH_BASE}$`);

/** The ledger's file-name layout, handed to the shared shard grammar. */
const DECISIONS_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: MONTH_BASE,
  extensions: Object.freeze([JSONL_LEDGER_EXT]),
});

/**
 * One durable accountability row. `action` narrows to the permission
 * vocabulary plus `resolution` - the row a staged document's apply or
 * reject lands. `verdict` stays a plain string so gate modes and refusal
 * tokens can appear beside allow/ask/deny; `source` names the deciding
 * rule (an entry id, an agent or role, `default`, or a gate key).
 */
export interface DecisionLedgerRow {
  ts: string;
  actor: string;
  via: string;
  action: PermissionAction | "resolution";
  target: string;
  verdict: string;
  source: string;
  reason: string;
  tool?: string;
  correlation_id?: string;
}

/** The append outcome. `logged: false` always carries `audit_reason`. */
export interface DecisionLedgerAppendResult {
  logged: boolean;
  audit_reason?: string;
}

/** Every field a filter may narrow by; absent fields match everything. */
export interface DecisionLedgerFilter {
  actor?: string;
  action?: string;
  verdict?: string;
  target?: string;
  /** Inclusive lower bound on `ts` (ISO-8601 compares as a string). */
  since?: string;
  /** Inclusive upper bound on `ts`. */
  until?: string;
  /** Applied after the deterministic sort, never during it. */
  limit?: number;
}

/**
 * The directory every decision shard lives in. Exported so the state
 * surface inventory and the CLI resolve this ledger's location through
 * the module that owns it.
 */
export function decisionLedgerDir(vault: string): string {
  return ensureInsideVault(join(vault, DECISIONS_REL), vault);
}

/**
 * One month's shard for one device: `<month>[.<shardId>].jsonl`. Exported
 * for the lock and the doctor probes; the append path derives it itself.
 */
export function decisionLedgerShardPath(vault: string, month: string, shardId: string): string {
  if (!MONTH_RE.test(month)) throw new Error(`invalid decision ledger month: ${month}`);
  return shardedFileName(month, shardId, JSONL_LEDGER_EXT);
}

/**
 * Append one row to this device's shard for the row's month.
 *
 * Never throws. The vault-identity guard runs INSIDE the failure net: a
 * guard refusal means the row must not be written where it was aimed, and
 * refusing-with-a-reason is exactly the append contract - the caller
 * still gets its verdict through and carries the reason.
 */
export function appendDecisionLedger(
  vault: string,
  row: DecisionLedgerRow,
): DecisionLedgerAppendResult {
  try {
    assertVaultIdentityForWrite(vault);
    const ts = requireTimestamp(row.ts);
    const month = monthOf(ts);
    const shardId = resolveAppendShardId();
    const dir = decisionLedgerDir(vault);
    mkdirSync(dir, { recursive: true });
    const shardPath = join(dir, decisionLedgerShardPath(vault, month, shardId));
    withShardLock(shardPath, () => {
      writeFileSync(shardPath, `${JSON.stringify(stripEmptyOptionals(row))}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    });
    return { logged: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { logged: false, audit_reason: `decision ledger append failed: ${message}` };
  }
}

/**
 * Every row the vault holds, merged across shards into the one order
 * every device agrees on - (timestamp, shard id, line) - then narrowed by
 * `filter`. An empty vault answers `[]` and creates nothing.
 *
 * A shard that cannot be READ propagates: an unreadable shard read as an
 * empty one would answer "this write was never gated", which is the one
 * wrong answer an accountability ledger must never give. A malformed LINE
 * is skipped, on the idempotency-ledger precedent: history stays legible
 * around a torn line instead of disappearing behind it.
 */
export function queryDecisionLedger(
  vault: string,
  filter: DecisionLedgerFilter = {},
): DecisionLedgerRow[] {
  const dir = decisionLedgerDir(vault);
  const shards = listShardedFiles(dir, DECISIONS_GRAMMAR);
  if (shards.length === 0) return [];
  const sharded: Array<ShardedRow<DecisionLedgerRow>> = [];
  for (const shard of shards) {
    let text: string;
    try {
      text = readShardText(vault, shard.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const [line, content] of text.split("\n").entries()) {
      if (content.trim() === "") continue;
      try {
        sharded.push({
          value: JSON.parse(content) as DecisionLedgerRow,
          shardId: shard.shardId,
          line,
        });
      } catch {
        continue;
      }
    }
  }
  const merged = mergeShardedRows(sharded, (row) => row.ts);
  return merged.filter((row) => matches(row, filter)).slice(0, positiveLimit(filter));
}

// ----- internals -------------------------------------------------------------

function readShardText(vault: string, path: string): string {
  return readFileSync(ensureInsideVault(path, vault), "utf8");
}

function requireTimestamp(ts: string): string {
  if (typeof ts !== "string" || !MONTH_RE.test(ts.slice(0, 7)) || ts.length < 7) {
    throw new Error(`row ts must start with YYYY-MM; got ${JSON.stringify(ts)}`);
  }
  return ts;
}

function monthOf(ts: string): string {
  return ts.slice(0, 7);
}

/**
 * Serialise the append across processes: proper-lockfile on the shard
 * path, with the bounded retry the secrets store's writer lock uses. The
 * sync lockfile API has no retry option, so contention spins briefly
 * before the caller sees the failure as an audit reason.
 */
function withShardLock(shardPath: string, fn: () => void): void {
  const maxAttempts = 20;
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts && release === null; attempt++) {
    try {
      release = lockfile.lockSync(shardPath, { stale: 10_000, realpath: false });
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== "ELOCKED") throw exc;
      lastError = exc;
      if (attempt < maxAttempts - 1) Bun.sleepSync(25);
    }
  }
  if (release === null) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`another writer holds the decision ledger shard lock: ${msg}`);
  }
  try {
    fn();
  } finally {
    void release();
  }
}

function stripEmptyOptionals(row: DecisionLedgerRow): DecisionLedgerRow {
  return {
    ...row,
    ...(row.tool !== undefined ? { tool: row.tool } : {}),
    ...(row.correlation_id !== undefined ? { correlation_id: row.correlation_id } : {}),
  };
}

function matches(row: DecisionLedgerRow, filter: DecisionLedgerFilter): boolean {
  if (filter.actor !== undefined && row.actor !== filter.actor) return false;
  if (filter.action !== undefined && row.action !== filter.action) return false;
  if (filter.verdict !== undefined && row.verdict !== filter.verdict) return false;
  if (filter.target !== undefined && row.target !== filter.target) return false;
  if (filter.since !== undefined && row.ts < filter.since) return false;
  if (filter.until !== undefined && row.ts > filter.until) return false;
  return true;
}

/** A filter without a limit reads everything; a nonsense limit reads nothing extra. */
function positiveLimit(filter: DecisionLedgerFilter): number {
  if (filter.limit === undefined) return Number.POSITIVE_INFINITY;
  return filter.limit > 0 ? filter.limit : 0;
}
