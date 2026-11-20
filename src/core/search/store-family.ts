/**
 * The files the search index's store layer itself keeps beside the store
 * file, as one closed list: the one definition the snapshot restore's
 * Brain swap (`brain/snapshot.ts`) and the store migration's claim of the
 * search index (`store-migration/surface-map.ts`) both read, so a suffix
 * the store layer adds is added here once and both follow it.
 */

/**
 * True where the filesystem compares names without case by default
 * (APFS, HFS+, NTFS), so `Index.sqlite` and `index.sqlite` are one file.
 */
export function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** `name` as the platform compares it. */
export function compareKey(name: string, platform: NodeJS.Platform): string {
  return foldsCase(platform) ? name.toLowerCase() : name;
}

/** SQLite's journal siblings of a database file: WAL mode and DELETE mode. */
const STORE_JOURNAL_SUFFIXES: ReadonlyArray<string> = Object.freeze(["-wal", "-shm", "-journal"]);

/**
 * The database files the store layer keeps beside the store, as suffixes
 * of its name: the store itself, the reindex staging file (`.new`), the
 * parked previous index (`.bak`, also the restore's outgoing store, and
 * `.old`).
 */
const STORE_DATABASE_SUFFIXES: ReadonlyArray<string> = Object.freeze(["", ".new", ".bak", ".old"]);

/**
 * The progress a running rebuild records beside the store
 * (`build-progress.ts`): a plain file, never journaled.
 */
export const STORE_BUILD_PROGRESS_SUFFIX = ".building.json";

/**
 * A search reading a running rebuild's staging file announces itself with
 * a file `<store>.building.reader-<pid>-<8 hex>` for as long as it holds
 * the file (`build-progress.ts`).
 */
export const STORE_BUILD_READER_PREFIX = ".building.reader-";

/** {@link STORE_BUILD_READER_PREFIX} with its pid and random tail. */
const STORE_BUILD_READER_PATTERN = /^\.building\.reader-\d+-[0-9a-f]{8}$/u;

/** The writer lock `proper-lockfile` takes on the store: a directory. */
const STORE_LOCK_SUFFIX = ".lock";

/** The lock a rebuild's write opens take on its staging file (`.new`): a directory. */
const STAGING_LOCK_SUFFIX = ".new.lock";

/** The restore's staged store: `<store>.restore-<pid>-<8 hex>`. */
const STAGED_STORE_PATTERN = /^\.restore-\d+-[0-9a-f]{8}$/u;

/**
 * True for a top-level `Brain/` entry that belongs to the store named
 * `base` when the store sits directly under `Brain/`. A closed list, so a
 * note or directory that merely starts with the store's name is restored
 * like any other entry:
 *
 *   - the store and each database file the store layer derives from it
 *     (`.new`, `.bak`, `.old`), each with its journals (`-wal`, `-shm`,
 *     `-journal`);
 *   - the restore's staged store (`.restore-<pid>-<hex>`) with its
 *     journals;
 *   - the progress file of a running rebuild (`.building.json`) and the
 *     files of the searches reading its staging file
 *     (`.building.reader-<pid>-<hex>`);
 *   - the writer lock directories: the store's (`.lock`) and the one a
 *     rebuild takes on its staging file (`.new.lock`), the only
 *     directories in the family.
 *
 * Names compare without case where the platform folds it. A suffix the
 * store layer adds later must be listed here; until it is, the Brain swap
 * treats that file as Brain content.
 */
export function isStoreFamilyEntry(
  name: string,
  base: string,
  isDirectory: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const key = compareKey(name, platform);
  const stem = compareKey(base, platform);
  if (!key.startsWith(stem)) return false;
  const suffix = key.slice(stem.length);
  if (isDirectory) return suffix === STORE_LOCK_SUFFIX || suffix === STAGING_LOCK_SUFFIX;
  if (suffix === STORE_BUILD_PROGRESS_SUFFIX || STORE_BUILD_READER_PATTERN.test(suffix))
    return true;
  // At most one journal suffix comes off: `-wal-shm` is not a journal.
  const journal = STORE_JOURNAL_SUFFIXES.find((j) => suffix.endsWith(j));
  const file = journal === undefined ? suffix : suffix.slice(0, -journal.length);
  return STORE_DATABASE_SUFFIXES.includes(file) || STAGED_STORE_PATTERN.test(file);
}
