/**
 * Shared trust conventions for Open Second Brain's guarded host writes
 * (t_b6bcd984 + t_f4555087). Three agreements every guarded write lane
 * (install JSON-merge, protect, doctor repair) and the standalone
 * PreToolUse host-backup hook satisfy, pinned by
 * tests/core/trust-conventions.test.ts:
 *
 * 1. the consent vocabulary recorded in every lane's receipt;
 * 2. the receipt-line schema: actor, pid, before-hash, summary plus a
 *    per-lane tail;
 * 3. the timestamped backup-folder layout for the host-backup hook.
 *
 * The CLI lanes import the vocabulary and the receipt formatter from
 * here. The hook wrapper stays stdlib-only and re-states the receipt
 * shape itself; its compliance is pinned by fixture, not by an import.
 */

import { basename, dirname, join } from "node:path";

import { compactRunStamp } from "./brain/time.ts";

/**
 * The only consent verdicts a guarded write lane may record:
 *
 * - `confirmed` — a human said yes, interactively or via `--yes`;
 * - `refused` — an interactive operator answered no (or a non-y answer);
 * - `headless-refused` — a `--json`/non-TTY run was refused fail-closed
 *   for want of `--yes`; nothing was written.
 */
export const CONSENT_VERDICTS = ["confirmed", "refused", "headless-refused"] as const;

export type ConsentVerdict = (typeof CONSENT_VERDICTS)[number];

/**
 * The fixed head of every receipt line the guarded lanes emit: who
 * wrote (`actor`), from which process (`pid`), the sha-256 of the file
 * content before the write (`before_hash`, hex `sha256:<digest>`; the
 * absent-file case hashes the empty string), and a one-line human
 * `summary`. Each lane appends its own `tail` fields (consent verdict,
 * backup path, ...) after the head.
 */
export interface TrustReceipt {
  readonly actor: string;
  readonly pid: number;
  readonly before_hash: string;
  readonly summary: string;
}

/**
 * Render one receipt line (JSONL) with the fixed head first and the
 * per-lane tail after; a tail key can never clobber a head field.
 */
export function formatTrustReceiptLine(
  receipt: TrustReceipt,
  tail: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({ ...tail, ...receipt });
}

/**
 * Directory name of the per-file backup root the host-backup hook uses:
 * a sibling `.o2b-backups/` beside the protected file, holding one
 * folder per {@link backupFolderStamp} with the backup inside. Kept
 * beside the target (not under `~/.claude` at large) so the backup of a
 * file is findable next to the file it protects.
 */
export const BACKUP_DIR_NAME = ".o2b-backups";

/**
 * The timestamped folder name for one backup run: the repo's compact
 * UTC run stamp, `YYYY-MM-DD-HHMMSS`. Whole-second precision; a second
 * backup within the same second ladders the name
 * (`collisionCandidateName`), never overwrites.
 */
export function backupFolderStamp(d: Date): string {
  return compactRunStamp(d);
}

/**
 * Backup root for one protected target `<dir>/<name>`:
 * `<dir>/.o2b-backups/<name>/`.
 */
export function backupRootFor(target: string): string {
  return join(join(dirname(target), BACKUP_DIR_NAME), basename(target));
}
