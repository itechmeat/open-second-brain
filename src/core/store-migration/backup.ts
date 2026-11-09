/**
 * The backups a migration takes before it imports anything (design D11
 * step 3), in the migration's device-local folder, never synced:
 *
 *  - a snapshot of `Brain/` through the existing snapshot path (the gate
 *    that keeps retention, `snapshot-gate.ts`), with a copy of the archive
 *    kept here so retention can never prune the migration's recovery point;
 *  - an explicit copy of every surface the map sends to `backup` (secrets,
 *    keys, attestations, checkpoints, lockfiles, settings), which the
 *    snapshot path excludes or does not reach, with a manifest of hashes.
 *
 * Each backup is verified by a test restore: the copy is restored into a
 * scratch folder and every file is compared, by hash, with the manifest
 * and with the original. Any failure throws {@link MigrationBackupError}
 * before the migration moves anything.
 *
 * {@link archiveUnparseable} keeps every item the migration could not read
 * (path, line, reason and the raw bytes) in the same folder, so nothing
 * the store does not take is lost.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { WRITE_LANE } from "../brain/freeze-marker.ts";
import { sleepSync } from "../fs-atomic.ts";
import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { takeSnapshot } from "../brain/snapshot-gate.ts";
import { BRAIN_SNAPSHOT_REASON } from "../brain/types.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import type { CatalogueEntry } from "./catalogue.ts";
import { journalScope, sameVault, type JournalScope } from "./journal-scope.ts";
import { DESTINATION_KIND } from "./destinations.ts";
import {
  MIGRATION_BACKUP_DIR as BACKUP_DIR,
  MIGRATION_BACKUP_FILES_DIR as FILES_DIR,
} from "./device-state-layout.ts";
import { rawLines } from "./legacy-scan.ts";
import { copyOwnerOnly, ensureOwnerOnlyRoot } from "./owner-only-copy.ts";

/** A backup that could not be taken or did not verify. */
export class MigrationBackupError extends Error {
  override readonly name = "MigrationBackupError";
}

export interface BackupManifestRow {
  /** Vault-relative, `/`-separated. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * The vault a backup was taken of: its identity marker's id (null when it
 * had none) and its real path. A rollback restores a backup only into the
 * same vault ({@link backupVaultMismatch}).
 */
export interface BackupVault {
  readonly vault_id: string | null;
  readonly path: string;
}

export interface MigrationBackup {
  readonly dir: string;
  /** The snapshot run id, or null when the vault holds no `Brain/` tree. */
  readonly snapshot: string | null;
  readonly files: ReadonlyArray<BackupManifestRow>;
  /** The vault the backup is of; null in a manifest that does not say. */
  readonly vault: BackupVault | null;
}

const SNAPSHOT_DIR = "snapshot";
const VERIFY_DIR = ".verify";
const MANIFEST_FILE = "manifest.json";
const UNPARSEABLE_FILE = "unparseable.jsonl";
const SNAPSHOT_ATTEMPTS = 3;

/** Pause before a retry, growing with each attempt, so a sync client can finish its write. */
const RETRY_PAUSE_MS = 250;

function pauseBeforeRetry(attempt: number): void {
  if (attempt > 0) sleepSync(RETRY_PAUSE_MS * attempt);
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The identity of `vault` as a backup records it. */
export function backupVaultOf(vault: string): BackupVault {
  return { vault_id: readVaultIdentity(vault)?.vault_id ?? null, path: realPathOf(vault) };
}

/**
 * The journal scope of a run that imports `vault` on `device`, with the
 * migration folder `dir`, whose backup names the vault this machine
 * migrated first (`journal-scope.ts`). `vaultId`, when given, is the
 * vault's marker id as the caller read it.
 */
export function journalScopeFor(
  vault: string,
  device: string,
  dir: string,
  vaultId?: string | null,
): JournalScope {
  const here = backupVaultOf(vault);
  return journalScope(
    vaultId === undefined ? here : { ...here, vault_id: vaultId },
    readMigrationBackup(dir)?.vault ?? null,
    device,
  );
}

/**
 * Why `backup` is not a backup of `vault`, or null when it is. The
 * identity marker decides when both sides carry one (a vault moved to
 * another path is the same vault); otherwise the real paths do. A
 * manifest that names no vault is refused: what it would restore cannot
 * be told apart from another vault's tree.
 */
export function backupVaultMismatch(backup: MigrationBackup, vault: string): string | null {
  const own = backup.vault;
  if (own === null) return "the backup does not name the vault it was taken of";
  return sameVault(own, backupVaultOf(vault))
    ? null
    : "the backup on this machine was taken of another vault";
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every regular file at or below `path`; links and special files are skipped. */
function filesBelow(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path)
    .toSorted()
    .flatMap((name) => filesBelow(join(path, name)));
}

function rel(vault: string, path: string): string {
  return relative(vault, path).split(sep).join("/");
}

function copyInto(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/** The files of every surface the map sends to `backup`. */
function backupFiles(catalogue: ReadonlyArray<CatalogueEntry>): string[] {
  const out = new Set<string>();
  for (const entry of catalogue) {
    if (entry.mapping.destination.to !== DESTINATION_KIND.backup) continue;
    for (const locator of entry.locators) {
      if (locator.shape !== "tree") continue;
      for (const file of filesBelow(locator.path)) out.add(file);
    }
  }
  return [...out].toSorted();
}

function verifyRestore(root: string, rows: ReadonlyArray<BackupManifestRow>): void {
  const scratch = join(root, VERIFY_DIR);
  rmSync(scratch, { recursive: true, force: true });
  try {
    for (const row of rows) {
      const parts = row.path.split("/");
      const restored = join(scratch, ...parts);
      copyOwnerOnly(join(root, FILES_DIR, ...parts), restored, root);
      // Against the manifest only: the copy was checked against the source
      // when it was taken, and a synced source may have changed since.
      if (sha256File(restored) !== row.sha256) {
        throw new MigrationBackupError(`the backup of ${row.path} did not restore intact`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function asBackupError(error: unknown): MigrationBackupError {
  if (error instanceof MigrationBackupError) return error;
  return new MigrationBackupError(
    `the migration backup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Snapshot `Brain/` and keep a verified copy of the archive in
 * `migrationDir`. Taken after the legacy writers are frozen, on the audit
 * lane the migration gate lets through, so the archive is of a tree at rest.
 * Returns the snapshot run id, or null when the vault holds no `Brain/`.
 */
export function takeMigrationSnapshot(vault: string, migrationDir: string): string | null {
  if (filesBelow(join(vault, BRAIN_ROOT_REL)).length === 0) return null;
  let failure: unknown = null;
  // The Brain log and other machines' synced files stay writable under the
  // gate, so an archive can meet a file being written; a few attempts ride
  // that out.
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    pauseBeforeRetry(attempt);
    try {
      const taken = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.storeMigration, {
        lane: WRITE_LANE.audit,
      });
      const root = join(migrationDir, BACKUP_DIR);
      const copy = join(root, SNAPSHOT_DIR, basename(taken.path));
      ensureOwnerOnlyRoot(root);
      copyOwnerOnly(taken.path, copy, root);
      if (sha256File(copy) !== sha256File(taken.path)) {
        throw new MigrationBackupError(`the copy of snapshot ${taken.runId} does not match it`);
      }
      return taken.runId;
    } catch (error) {
      failure = error;
    }
  }
  throw asBackupError(failure);
}

/**
 * Copy one backup file and describe the copy: the source is hashed right
 * before the copy and the copy right after, and a mismatch (another
 * machine's synced file changing under the copy) is retried a few times,
 * as the snapshot is. The manifest row describes the bytes actually kept.
 */
function copyVerified(file: string, target: string, root: string, path: string): BackupManifestRow {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    pauseBeforeRetry(attempt);
    const before = sha256File(file);
    copyOwnerOnly(file, target, root);
    const copied = sha256File(target);
    if (copied === before) return { path, sha256: copied, bytes: lstatSync(target).size };
  }
  throw new MigrationBackupError(`${path} kept changing while it was backed up`);
}

/**
 * Copy and verify every backup-class surface of `vault` into
 * `migrationDir`. Throws {@link MigrationBackupError} on any failure;
 * nothing is imported then.
 */
export function takeMigrationBackups(
  vault: string,
  catalogue: ReadonlyArray<CatalogueEntry>,
  migrationDir: string,
  snapshot: string | null,
): MigrationBackup {
  const root = join(migrationDir, BACKUP_DIR);
  try {
    // Secrets and signing keys: owner-only whatever mode the source had.
    ensureOwnerOnlyRoot(root);
    mkdirSync(join(root, FILES_DIR), { recursive: true, mode: 0o700 });
    const rows: BackupManifestRow[] = [];
    for (const file of backupFiles(catalogue)) {
      const path = rel(vault, file);
      rows.push(copyVerified(file, join(root, FILES_DIR, ...path.split("/")), root, path));
    }
    const of = backupVaultOf(vault);
    writeFileSync(
      join(root, MANIFEST_FILE),
      `${JSON.stringify({ snapshot, files: rows, vault: of }, null, 2)}\n`,
    );
    verifyRestore(root, rows);
    return { dir: root, snapshot, files: rows, vault: of };
  } catch (error) {
    throw asBackupError(error);
  }
}

/** One item the migration could not read. */
export interface UnparseableItem {
  readonly surface: string;
  /** Absolute path. */
  readonly path: string;
  readonly line: number | null;
  readonly reason: string;
}

/**
 * Keep every unparseable item in the backup folder with its path, line,
 * reason and raw bytes (base64), replacing the previous archive.
 */
export function archiveUnparseable(
  vault: string,
  migrationDir: string,
  items: ReadonlyArray<UnparseableItem>,
): string {
  const path = join(migrationDir, BACKUP_DIR, UNPARSEABLE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  // Each file is read once, and a line is cut from its raw bytes, so the
  // archive keeps a torn or non-UTF-8 line exactly as it was.
  const files = new Map<string, { whole: Buffer; lines: Buffer[] } | null>();
  const fileOf = (file: string) => {
    if (!files.has(file)) {
      try {
        const whole = readFileSync(file);
        files.set(file, { whole, lines: rawLines(whole) });
      } catch {
        files.set(file, null); // gone since the scan: the reason still says what was there
      }
    }
    return files.get(file)!;
  };
  const rows = items.map((item) => {
    const file = fileOf(item.path);
    let bytes: Buffer = Buffer.alloc(0);
    if (file !== null) {
      bytes = item.line === null ? file.whole : (file.lines[item.line - 1] ?? bytes);
    }
    return JSON.stringify({
      surface: item.surface,
      path: rel(vault, item.path),
      line: item.line,
      reason: item.reason,
      bytes_base64: bytes.toString("base64"),
    });
  });
  writeFileSync(path, rows.length === 0 ? "" : `${rows.join("\n")}\n`);
  return path;
}

/** What a migration's backup holds, as its manifest says; null without a backup. */
export function readMigrationBackup(migrationDir: string): MigrationBackup | null {
  const root = join(migrationDir, BACKUP_DIR);
  try {
    const parsed = JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")) as {
      snapshot?: unknown;
      files?: unknown;
      vault?: { vault_id?: unknown; path?: unknown } | null;
    };
    const of = parsed.vault;
    return {
      dir: root,
      snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : null,
      files: Array.isArray(parsed.files) ? (parsed.files as BackupManifestRow[]) : [],
      vault:
        of !== null && typeof of === "object" && typeof of.path === "string"
          ? { vault_id: typeof of.vault_id === "string" ? of.vault_id : null, path: of.path }
          : null,
    };
  } catch {
    return null;
  }
}

/** The copy of the migration snapshot's archive kept in the backup, or null. */
export function snapshotCopyIn(backup: MigrationBackup): string | null {
  if (backup.snapshot === null) return null;
  const dir = join(backup.dir, SNAPSHOT_DIR);
  try {
    const name = readdirSync(dir).find((n) => n.startsWith(backup.snapshot!));
    return name === undefined ? null : join(dir, name);
  } catch {
    return null;
  }
}

/** Put every backed-up file back at its vault path, verified by hash. */
export function restoreMigrationBackups(vault: string, backup: MigrationBackup): number {
  for (const row of backup.files) {
    const parts = row.path.split("/");
    const target = join(vault, ...parts);
    copyInto(join(backup.dir, FILES_DIR, ...parts), target);
    if (sha256File(target) !== row.sha256) {
      throw new MigrationBackupError(`the restored ${row.path} does not match its backup`);
    }
  }
  return backup.files.length;
}
