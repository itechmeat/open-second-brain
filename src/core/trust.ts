/**
 * Shared trust conventions for Open Second Brain's guarded host writes
 * (t_b6bcd984 + t_f4555087). What this leaf actually guarantees, no
 * more:
 *
 * 1. {@link CONSENT_VERDICTS} - the OPERATOR-consent/refusal
 *    vocabulary: `headless-refused` rides every `--json` refusal
 *    envelope, `refused` stays reserved for a future interactive-no
 *    envelope, and `confirmed` is the pre-ladder hard-coded write
 *    verdict, unrecorded since the lanes began deriving what happened.
 *    The verdict an apply records today is a `LaneConsentVerdict`
 *    (see `RepairConsent` in src/core/brain/diagnostics.ts):
 *    `yes-flag | interactive-yes | unchanged` on the CLI lanes
 *    (install apply, protect, unprotect, doctor repair) and
 *    `caller-apply` on the doctor MCP path, one vocabulary across all
 *    of them.
 * 2. {@link formatTrustReceiptLine} and the {@link TrustReceipt} head:
 *    the fixed receipt fields (actor, pid, before-hash, summary) and a
 *    renderer that keeps the head first. A formatting helper ready for
 *    lane adoption - no lane routes its receipts through it yet, so
 *    its compliance is pinned by fixture
 *    (tests/core/trust-conventions.test.ts) alone. The PreToolUse
 *    host-backup hook appends these same head fields to its audit
 *    record; it stays stdlib-only and restates the shape, so its
 *    compliance is pinned by fixture too, not by an import.
 * 3. The backup layout the host-backup hook uses, as constants and
 *    functions: a sibling `.o2b-backups/` beside the protected file,
 *    one folder per protected file name, each backup a file named by
 *    {@link backupFolderStamp} (UTC compact `YYYY-MM-DD-HHMMSS`), and
 *    the `*`-ignore marker ({@link ensureBackupRootIgnored}) that keeps
 *    project-level backups out of the surrounding repository.
 *
 * Production imports today: the backup layout
 * (src/core/brain/pretool-host-backup.ts) alone - the lanes take their
 * verdicts from `LaneConsentVerdict` in src/core/brain/diagnostics.ts,
 * so the vocabulary value and the formatter here are pinned by fixture
 * (tests/core/trust-conventions.test.ts) until a lane adopts them.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { compactRunStamp } from "./brain/time.ts";

/**
 * The OPERATOR-consent/refusal vocabulary of the guarded write lanes:
 *
 * - `confirmed` — reserved; the verdict the lanes hard-coded on a write
 *   before they began deriving it (no lane records it today);
 * - `refused` — reserved for a future interactive-no envelope (a
 *   non-y answer today cancels the run and records nothing);
 * - `headless-refused` — a `--json`/non-TTY run was refused fail-closed
 *   for want of `--yes`; nothing was written. The one verdict here with
 *   an emitter: the lanes' `--json` refusal envelopes carry it.
 *
 * The verdict a write records lives one module over:
 * `LaneConsentVerdict` in src/core/brain/diagnostics.ts derives
 * `yes-flag | interactive-yes | unchanged` on the CLI lanes and the
 * doctor MCP path records `caller-apply`; its `REFUSAL_VERDICTS` shares
 * this constant's refusal spellings.
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
 * The receipt head's field names, in line order. A tail key carrying one
 * of these names is dropped, not overridden, so a lane tail can never
 * clobber the head - not even into a duplicate key.
 */
const TRUST_RECEIPT_HEAD_FIELDS: ReadonlyArray<string> = ["actor", "pid", "before_hash", "summary"];

/**
 * Render one receipt line (JSONL) with the fixed head first and the
 * per-lane tail after; a tail key can never clobber a head field.
 *
 * A convention helper, not yet a lane's code path: no production caller
 * renders receipts through this today (the install renderer, the
 * protect/unprotect JSON envelopes and the audit appends each emit
 * their own fields), so the head-first guarantee is pinned by fixture
 * here rather than by lane adoption.
 */
export function formatTrustReceiptLine(
  receipt: TrustReceipt,
  tail: Readonly<Record<string, unknown>> = {},
): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tail)) {
    if (!TRUST_RECEIPT_HEAD_FIELDS.includes(key)) rest[key] = value;
  }
  return JSON.stringify({ ...receipt, ...rest });
}

/**
 * Directory name of the per-file backup root the host-backup hook uses:
 * a sibling `.o2b-backups/` beside the protected file, holding one
 * folder per protected file name. Each backup inside that folder is a
 * FILE named by {@link backupFolderStamp} (a same-second collision
 * ladders `-2`, `-3`, ... onto the name) - the stamp is the backup's
 * file name, not a folder of its own. Kept beside the target (not under
 * `~/.claude` at large) so the backup of a file is findable next to the
 * file it protects.
 */
export const BACKUP_DIR_NAME = ".o2b-backups";

/**
 * The file name for one backup: the repo's compact UTC run stamp,
 * `YYYY-MM-DD-HHMMSS`. Whole-second precision; a second backup within
 * the same second ladders the name (`collisionCandidateName`), never
 * overwrites.
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

/**
 * The git-ignore marker written into a `.o2b-backups/` root on first
 * use. A project-level backup root lives inside someone's repository,
 * and a `.claude/settings.local.json` copy can hold local permissions,
 * env values and tokens - without the marker the next `git add -A`
 * commits the backup. `*` ignores every backup; `!.gitignore` keeps
 * the marker itself committable so a fresh clone is covered too.
 */
export const BACKUP_IGNORE_FILE_TEXT = "*\n!.gitignore\n";

/**
 * Drop {@link BACKUP_IGNORE_FILE_TEXT} into the `.o2b-backups/` root
 * that owns `backupRoot` (`<dir>/.o2b-backups/<name>`), creating that
 * root if needed, unless the marker is already there. Returns `true`
 * when the marker was written. Throws on an unwritable location -
 * callers treat that as hygiene, not as a guard, and decide their own
 * failure policy.
 */
export function ensureBackupRootIgnored(backupRoot: string): boolean {
  const backupsDir = dirname(backupRoot);
  mkdirSync(backupsDir, { recursive: true });
  const marker = join(backupsDir, ".gitignore");
  if (existsSync(marker)) return false;
  writeFileSync(marker, BACKUP_IGNORE_FILE_TEXT, { mode: 0o644 });
  return true;
}
