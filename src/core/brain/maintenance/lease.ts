/**
 * Expiring maintenance lease (write-time-integrity-governance,
 * t_166d1226). A tiny dedicated SQLite database in the vault-local
 * state dir - deliberately NOT brain.sqlite, so holding the lease
 * never contends with the search index writer lock - holds one row
 * per lease name. Acquisition is a single conditional upsert, so two
 * workers racing across processes cannot both win; a crashed worker's
 * lease frees itself by expiry, never by manual cleanup.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAINTENANCE_LEASE_NAME = "maintenance";

export interface AcquireLeaseOptions {
  readonly name?: string;
  readonly holder: string;
  readonly ttlMs: number;
  readonly now: Date;
}

export interface ReleaseLeaseOptions {
  readonly name?: string;
  readonly holder: string;
}

export interface LeaseState {
  readonly name: string;
  readonly holder: string;
  readonly expiresAt: string;
}

function leaseDbPath(vault: string): string {
  return join(vault, ".open-second-brain", "maintenance.sqlite");
}

function openLeaseDb(vault: string): Database {
  const path = leaseDbPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS leases (" +
      "  name       TEXT PRIMARY KEY," +
      "  holder     TEXT NOT NULL," +
      "  expires_at TEXT NOT NULL" +
      ")",
  );
  return db;
}

/**
 * Try to take the lease. True when this holder now owns it - either
 * it was free, expired, or already ours (re-entrant renew).
 */
export function acquireLease(vault: string, opts: AcquireLeaseOptions): boolean {
  const name = opts.name ?? MAINTENANCE_LEASE_NAME;
  const nowIso = opts.now.toISOString();
  const expiresAt = new Date(opts.now.getTime() + opts.ttlMs).toISOString();
  const db = openLeaseDb(vault);
  try {
    db.run(
      "INSERT INTO leases(name, holder, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at " +
        "WHERE leases.expires_at < ? OR leases.holder = excluded.holder",
      [name, opts.holder, expiresAt, nowIso],
    );
    const row = db
      .query<{ holder: string }, [string]>("SELECT holder FROM leases WHERE name = ?")
      .get(name);
    return row?.holder === opts.holder;
  } finally {
    db.close();
  }
}

/** Release the lease; only the current holder may. */
export function releaseLease(vault: string, opts: ReleaseLeaseOptions): boolean {
  const name = opts.name ?? MAINTENANCE_LEASE_NAME;
  const db = openLeaseDb(vault);
  try {
    db.run("DELETE FROM leases WHERE name = ? AND holder = ?", [name, opts.holder]);
    const gone = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM leases WHERE name = ?")
      .get(name);
    return (gone?.n ?? 0) === 0;
  } finally {
    db.close();
  }
}

/** The live lease, or null when free or expired. */
export function currentLease(
  vault: string,
  opts: { readonly name?: string; readonly now?: Date } = {},
): LeaseState | null {
  const name = opts.name ?? MAINTENANCE_LEASE_NAME;
  const now = opts.now ?? new Date();
  const db = openLeaseDb(vault);
  try {
    const row = db
      .query<{ name: string; holder: string; expires_at: string }, [string]>(
        "SELECT name, holder, expires_at FROM leases WHERE name = ?",
      )
      .get(name);
    if (!row || row.expires_at < now.toISOString()) return null;
    return { name: row.name, holder: row.holder, expiresAt: row.expires_at };
  } finally {
    db.close();
  }
}
