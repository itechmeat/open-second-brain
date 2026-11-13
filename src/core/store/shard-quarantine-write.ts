/**
 * The write side of the shard quarantine ledger (change store-hardening,
 * design D4): record and release one line under the local lock. Kept apart
 * from `shard-quarantine.ts` so a reader of the ledger loads no lock module.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { StorePartition } from "./constants.ts";
import { withLocalLock } from "./local-lock.ts";
import {
  compareLines,
  dropLoadedLedger,
  isLine,
  ledgerPath,
  QUARANTINE_LEDGER_VERSION,
  sameLine,
  SHARD_QUARANTINE_DIR,
  type QuarantineLine,
} from "./shard-quarantine.ts";
import { storesStateDir } from "./store-paths.ts";

/**
 * The ledger file exists but this release cannot rewrite it without losing
 * entries: it cannot be read, does not parse, has another `version`, or
 * holds an entry this release does not read (a newer build's kind, for
 * example). The write refuses instead of overwriting it. `remedy` replaces
 * the default advice when repairing the file is not the way out.
 */
export class QuarantineLedgerUnreadableError extends Error {
  constructor(
    readonly path: string,
    detail: string,
    remedy = "it is left as it is. Repair or remove it, then run the command again",
  ) {
    super(`the shard quarantine ledger ${path} ${detail}; ${remedy}`);
    this.name = "QuarantineLedgerUnreadableError";
  }
}

/** The error's code (`EACCES`, `EIO`, ...), or its message when it carries none. */
function readFailure(err: unknown): { code: string | null; text: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : null,
    text: err instanceof Error ? err.message : String(err),
  };
}

/** The ledger's entries, parsed strictly: absent is empty, anything unreadable throws. */
function loadStrict(path: string): QuarantineLine[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const failure = readFailure(err);
    if (failure.code === "ENOENT") {
      // Removed by something outside the lock between the check and the read.
      throw new QuarantineLedgerUnreadableError(
        path,
        "was removed while it was being read",
        "nothing was changed. Run the command again",
      );
    }
    throw new QuarantineLedgerUnreadableError(
      path,
      `could not be read (${failure.text})`,
      "it is left as it is. Check that this account can read it, then run the command again",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new QuarantineLedgerUnreadableError(
      path,
      `does not parse as JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new QuarantineLedgerUnreadableError(path, "is not a JSON object");
  }
  const { version, lines } = parsed as { version?: unknown; lines?: unknown };
  if (version !== QUARANTINE_LEDGER_VERSION) {
    throw new QuarantineLedgerUnreadableError(
      path,
      `has version ${String(version)}, not ${QUARANTINE_LEDGER_VERSION}`,
    );
  }
  if (!Array.isArray(lines)) {
    throw new QuarantineLedgerUnreadableError(path, "holds no list of lines");
  }
  if (!lines.every(isLine)) {
    throw new QuarantineLedgerUnreadableError(path, "holds an entry this release does not read");
  }
  return [...lines];
}

/** What a change did: `write` false leaves the file untouched. */
interface Change<T> {
  readonly result: T;
  readonly write: boolean;
}

/**
 * Apply `change` to the ledger of `root` under the local lock and write it
 * back when it changed something. Throws
 * {@link QuarantineLedgerUnreadableError} for a ledger it cannot rewrite.
 */
function update<T>(root: string, change: (lines: QuarantineLine[]) => Change<T>): T {
  const path = ledgerPath(root);
  mkdirSync(join(storesStateDir(), SHARD_QUARANTINE_DIR), { recursive: true });
  return withLocalLock(path, () => {
    const lines = loadStrict(path);
    const { result, write } = change(lines);
    // A no-op leaves the mtime alone, so no cache keyed on the stamp drops.
    if (!write) return result;
    const sorted = lines.toSorted(compareLines);
    atomicWriteFileSync(
      path,
      `${JSON.stringify({ version: QUARANTINE_LEDGER_VERSION, root: resolve(root), lines: sorted }, null, 2)}\n`,
    );
    dropLoadedLedger(path);
    return result;
  });
}

/**
 * Record `line` in the ledger of the store at `root`. `already` when the
 * ledger names the same line with the same bytes and the same kind; an
 * entry for the same offset with other bytes or another kind is replaced,
 * since the reader marks a line only for an entry of its own kind (a
 * `corrupt-line` entry never skips a pending record, nor the reverse).
 */
export function addQuarantine(
  root: string,
  line: Omit<QuarantineLine, "quarantined_at">,
  now: Date = new Date(),
): "quarantined" | "already" {
  return update(root, (lines) => {
    const at = lines.findIndex((l) => sameLine(l, line.partition, line.shard, line.offset));
    const same = at !== -1 && lines[at]!.sha256 === line.sha256 && lines[at]!.kind === line.kind;
    if (same) return { result: "already", write: false };
    const entry: QuarantineLine = {
      partition: line.partition,
      shard: line.shard,
      offset: line.offset,
      sha256: line.sha256,
      kind: line.kind,
      reason: line.reason,
      quarantined_at: now.toISOString(),
    };
    if (at === -1) lines.push(entry);
    else lines[at] = entry;
    return { result: "quarantined", write: true };
  });
}

/** Remove the entry of the line at `offset` of a shard; `not-quarantined` when there is none. */
export function releaseQuarantine(
  root: string,
  partition: StorePartition,
  shard: string,
  offset: number,
): "released" | "not-quarantined" {
  return update(root, (lines) => {
    const at = lines.findIndex((l) => sameLine(l, partition, shard, offset));
    if (at === -1) return { result: "not-quarantined", write: false };
    lines.splice(at, 1);
    return { result: "released", write: true };
  });
}
