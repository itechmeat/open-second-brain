/**
 * The bootstrap receipt (write-side-trust, Task 14).
 *
 * `<vault>/.open-second-brain/bootstrap.lock.json` records what one
 * bootstrap actually established: the target, its install model, the
 * owned entries the adapter reported, the provisioned token's NAME and
 * non-secret prefix, and `applied_at`. Modeled on `install.lock.json`
 * and `protect.lock.json` - the receipt is the durable, credential-free
 * answer to "what did bootstrap do to this machine", which is also why
 * the minted material appears nowhere in it.
 *
 * Schema (`schema_version: 1`):
 *
 * ```
 * {
 *   "schema_version": 1,
 *   "entries": {
 *     "<target>": { ...BootstrapReceiptEntry }
 *   }
 * }
 * ```
 *
 * The writer upserts one entry per target. No-churn is the CALLER's
 * rule: a re-run that would recompute the identical entry writes
 * nothing, so an idempotent bootstrap leaves the receipt byte-identical.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../core/fs-atomic.ts";
import { assertVaultIdentityForWrite } from "../../core/brain/vault-identity.ts";
import type { BootstrapMode } from "./targets.ts";

export const BOOTSTRAP_SCHEMA_VERSION = 1;

/** The non-secret token identification a receipt carries. */
export interface BootstrapTokenEntry {
  readonly name: string;
  readonly prefix: string;
}

export interface BootstrapReceiptEntry {
  readonly target: string;
  readonly mode: BootstrapMode;
  readonly agent: string;
  readonly config_path: string | null;
  readonly owned_keys?: ReadonlyArray<string>;
  readonly owned_paths?: ReadonlyArray<string>;
  readonly owned_block_marker?: string;
  readonly token?: BootstrapTokenEntry;
  readonly applied_at: string;
}

export interface BootstrapReceipt {
  readonly schema_version: typeof BOOTSTRAP_SCHEMA_VERSION;
  readonly entries: Record<string, BootstrapReceiptEntry>;
}

export class BootstrapReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapReceiptError";
  }
}

const EMPTY_RECEIPT: BootstrapReceipt = { schema_version: BOOTSTRAP_SCHEMA_VERSION, entries: {} };

export function bootstrapReceiptPath(vault: string): string {
  return join(vault, ".open-second-brain", "bootstrap.lock.json");
}

export function readBootstrapReceipt(vault: string): BootstrapReceipt {
  const path = bootstrapReceiptPath(vault);
  if (!existsSync(path)) return EMPTY_RECEIPT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BootstrapReceiptError(
      `bootstrap receipt is corrupted JSON: ${path} (${(e as Error).message})`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BootstrapReceiptError(`bootstrap receipt is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== BOOTSTRAP_SCHEMA_VERSION) {
    throw new BootstrapReceiptError(
      `bootstrap receipt schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${String(BOOTSTRAP_SCHEMA_VERSION)}): ${path}`,
    );
  }
  const entries = obj["entries"];
  if (entries === undefined) return EMPTY_RECEIPT;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    throw new BootstrapReceiptError(`bootstrap receipt entries is not an object: ${path}`);
  }
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    entries: entries as Record<string, BootstrapReceiptEntry>,
  };
}

/** Upsert one target's entry, preserving every other entry verbatim. */
export function upsertBootstrapReceiptEntry(vault: string, entry: BootstrapReceiptEntry): void {
  assertVaultIdentityForWrite(vault);
  const current = readBootstrapReceipt(vault);
  const next: BootstrapReceipt = {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    entries: { ...current.entries, [entry.target]: entry },
  };
  const path = bootstrapReceiptPath(vault);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Whether a receipt entry and a store record tell the same token story.
 * Both absent: consistent (a tokenless bootstrap). Both present: name
 * and non-secret prefix must agree. Exactly one present: the receipt
 * and the store disagree, and `--check` must say so.
 */
export function receiptTokenMatches(
  entry: BootstrapReceiptEntry | undefined,
  record: { name: string; token_prefix: string } | undefined,
): boolean {
  if (entry === undefined && record === undefined) return true;
  if (entry === undefined || record === undefined) return false;
  const token = entry.token;
  if (token === undefined) return false;
  return token.name === record.name && token.prefix === record.token_prefix;
}

/**
 * Whether two entries agree on everything but `applied_at` - the
 * comparison behind the no-churn rule. A byte-identical re-run must not
 * touch the receipt, so the writer skips when this answers true.
 */
export function receiptEntryEqualsExcludingTimestamp(
  left: BootstrapReceiptEntry,
  right: BootstrapReceiptEntry,
): boolean {
  const strip = (e: BootstrapReceiptEntry): string => {
    const { applied_at: _applied_at, ...rest } = e;
    return JSON.stringify(rest);
  };
  return strip(left) === strip(right);
}
