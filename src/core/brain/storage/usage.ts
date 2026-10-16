/**
 * The storage usage meter: per-surface, measured-or-refused byte census
 * over a vault.
 *
 * Every byte this tool keeps inside a vault belongs to exactly one named
 * surface here, and every surface is reported one of two ways: a measured
 * byte total, or a named refusal in `unmeasured` - never a plausible
 * zero. A chmod-denied directory and an empty one produce different
 * answers, because "0 bytes" and "I could not look" are different facts,
 * and a capacity forecast built over the first would silently
 * understate usage by exactly the surface it could not read. The
 * measured-or-refused posture follows `HOST_PRESSURE`
 * (`../maintenance/host-pressure.ts`), applied to bytes instead of load.
 *
 * ## The per-dot-dir policy
 *
 * The index walker excludes dot-directories, and a usage meter that
 * reused that rule would miss most of what fills a vault. Each
 * dot-directory is therefore a NAMED surface with its own tier, decided
 * the way `STATE_SURFACES` decides it - recoverability, not location:
 *
 *   - `.artifacts` - MCP tool-result scratch with a TTL; `derived`.
 *   - `.snapshots` - recovery points; `vault-content`, because they are
 *     the vault's own bytes copied and deleting them removes the only
 *     rollback path.
 *   - `.archives` - the content-addressed source evidence (no TTL);
 *     `vault-content`.
 *   - `.payloads` - externalized session content a restore must bring
 *     back; `vault-content`.
 *   - `.state` - internal machinery (the session-lineage ledger, the
 *     write images, the anticipatory cache); `vault-content` as a whole,
 *     because its regenerable minority (the anticipatory cache) does not
 *     outweigh the records nothing can replay, and a capacity report
 *     that overstated the deletable side would be the dangerous
 *     direction to err in.
 *
 * Everything else under `Brain/` - pages, ledgers, the config file -
 * is the `brain_tree` surface, `vault-content`. The derived store
 * (`brain.sqlite` plus its WAL and SHM sidecars) is resolved through the
 * search layer's own resolver so the meter can never disagree with the
 * indexer about which file is the store; it is `derived`. The rest of
 * the store's directory (`.open-second-brain/` - the hook audit, the
 * watchdog fallback audit, the dead letters, the checkpoints, the
 * session ledgers, the maintenance journal and lease database) is the
 * `derived_store_dir` surface: it accumulates for months outside any
 * `Brain/` lane, and a census that skipped it would read a busy
 * hook-driven vault as flat while the disk filled. It reports as
 * `vault-content` as a whole - most of it is regenerable, but the
 * secret custody, the dead letters and the lockfiles are not, and a
 * capacity report that overstated the deletable side would be the
 * dangerous direction to err in.
 *
 * The meter is read-only, never follows symlinks, and takes no
 * wall-clock reading: the timestamp it stamps comes from the injected
 * `now` alone.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_ROOT_REL, DERIVED_STORE_DIR } from "../path-constants.ts";
import { resolveConfiguredIndexPath } from "../../search/paths.ts";

/** Recoverability tiers, mirroring the state catalogue's vocabulary. */
export const STORAGE_TIER = Object.freeze({
  derived: "derived",
  vaultContent: "vault-content",
} as const);

export type StorageTier = (typeof STORAGE_TIER)[keyof typeof STORAGE_TIER];

/** The tiers, most-recoverable first, for report rendering. */
export const STORAGE_TIERS: ReadonlyArray<StorageTier> = Object.freeze([
  STORAGE_TIER.derived,
  STORAGE_TIER.vaultContent,
]);

/** The closed set of surfaces one measurement names. */
export const STORAGE_SURFACE = Object.freeze({
  /** Every `Brain/` byte outside the named dot-directories. */
  brainTree: "brain_tree",
  /** `Brain/.snapshots/` - recovery points. */
  snapshots: "snapshots",
  /** `Brain/.artifacts/` - TTL'd tool-result scratch. */
  artifacts: "artifacts",
  /** `Brain/.archives/` - content-addressed source evidence. */
  archives: "archives",
  /** `Brain/.payloads/` - externalized session content. */
  payloads: "payloads",
  /** `Brain/.state/` - internal machinery ledgers and write images. */
  internalState: "internal_state",
  /** The derived store and its WAL/SHM sidecars. */
  derivedStore: "derived_store",
  /**
   * `<vault>/.open-second-brain/` minus the store files - the
   * accumulating machinery state the store's directory carries beside
   * the store.
   */
  derivedStoreDir: "derived_store_dir",
} as const);

export type StorageSurface = (typeof STORAGE_SURFACE)[keyof typeof STORAGE_SURFACE];

/** Every surface, in canonical report order. */
export const STORAGE_SURFACES: ReadonlyArray<StorageSurface> = Object.freeze([
  STORAGE_SURFACE.brainTree,
  STORAGE_SURFACE.snapshots,
  STORAGE_SURFACE.artifacts,
  STORAGE_SURFACE.archives,
  STORAGE_SURFACE.payloads,
  STORAGE_SURFACE.internalState,
  STORAGE_SURFACE.derivedStore,
  STORAGE_SURFACE.derivedStoreDir,
]);

/** Why a surface has no byte reading. */
export const STORAGE_UNMEASURED_REASON = Object.freeze({
  /** The surface exists and a read of it was denied. */
  surfaceUnreadable: "surface_unreadable",
} as const);

export type StorageUnmeasuredReason =
  (typeof STORAGE_UNMEASURED_REASON)[keyof typeof STORAGE_UNMEASURED_REASON];

export const STORAGE_UNMEASURED_REASONS: ReadonlyArray<StorageUnmeasuredReason> = Object.freeze(
  Object.values(STORAGE_UNMEASURED_REASON),
);

/** One surface's measured byte total. */
export interface StorageSurfaceReading {
  readonly surface: StorageSurface;
  readonly tier: StorageTier;
  readonly bytes: number;
}

/** One surface the meter could not read, named with its reason. */
export interface StorageUnmeasuredSurface {
  readonly surface: StorageSurface;
  readonly reason: StorageUnmeasuredReason;
}

/** One complete measured-or-refused census of a vault. */
export interface StorageUsage {
  /** ISO-8601 UTC stamp from the injected `now`. */
  readonly measuredAt: string;
  /** False when at least one surface was refused; see `unmeasured`. */
  readonly complete: boolean;
  /** The measured surfaces, in canonical order. Refused surfaces are absent. */
  readonly surfaces: ReadonlyArray<StorageSurfaceReading>;
  /** Byte totals per tier, over the measured surfaces only. */
  readonly bytesByTier: Readonly<Record<StorageTier, number>>;
  /** Sum of every measured byte. */
  readonly totalBytes: number;
  /** The refusals, in canonical surface order. */
  readonly unmeasured: ReadonlyArray<StorageUnmeasuredSurface>;
}

export interface MeasureStorageUsageOptions {
  /** Wall clock for the report stamp; defaults to the current time. */
  readonly now?: Date;
  /**
   * The derived store's file path, when the caller has already resolved
   * it (the doctor's context carries one). Absent, the store resolves
   * through the search layer's CONFIGURED resolution - the override
   * (`search_db_path` / `OPEN_SECOND_BRAIN_SEARCH_DB`) included - so the
   * census measures the store the indexer actually opens, never a stale
   * file the override left behind at the default location.
   */
  readonly storePath?: string;
  /**
   * The machine-config file the caller resolved the search config from,
   * when it did so through an explicit `--config` path. Used for the
   * configured resolution above, so a `search_db_path` override in THAT
   * file moves the measured store the same way it moves the indexer;
   * absent, the resolver reads its own default file, which is the same
   * file an override-unaware caller would read.
   */
  readonly configPath?: string;
}

/** The tier each surface reports, named once beside the surface list. */
const SURFACE_TIERS: Readonly<Record<StorageSurface, StorageTier>> = Object.freeze({
  [STORAGE_SURFACE.brainTree]: STORAGE_TIER.vaultContent,
  [STORAGE_SURFACE.snapshots]: STORAGE_TIER.vaultContent,
  [STORAGE_SURFACE.artifacts]: STORAGE_TIER.derived,
  [STORAGE_SURFACE.archives]: STORAGE_TIER.vaultContent,
  [STORAGE_SURFACE.payloads]: STORAGE_TIER.vaultContent,
  [STORAGE_SURFACE.internalState]: STORAGE_TIER.vaultContent,
  [STORAGE_SURFACE.derivedStore]: STORAGE_TIER.derived,
  [STORAGE_SURFACE.derivedStoreDir]: STORAGE_TIER.vaultContent,
});

/** The sqlite sidecar suffixes that belong to the store surface. */
const STORE_WAL_SUFFIX = "-wal";
const STORE_SHM_SUFFIX = "-shm";

/**
 * Whether an fs error names a missing path. Missing is a true answer
 * (the surface is measured-empty); every other error is a refusal.
 */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT";
}

/**
 * Byte-accumulate one regular file, or record the refusal. Symlinks are
 * skipped outright: `statSync` on one would follow it, and a usage meter
 * that followed links out of the vault would count bytes the vault does
 * not hold.
 */
function addFile(path: string, add: (bytes: number) => void, refuse: () => void): void {
  let info;
  try {
    info = statSync(path);
  } catch (err) {
    if (!isAbsent(err)) refuse();
    return;
  }
  if (!info.isFile()) return;
  add(info.size);
}

/**
 * Walk one directory tree, accumulating regular-file bytes. A directory
 * that cannot be enumerated refuses its surface once - and the bytes
 * read below the point of refusal are discarded with it: the caller
 * (`measureDirSurface`) records a refused surface in its refusal set
 * only, so no caller can read a partial total as the surface's size.
 * `skipFiles` names absolute paths counted by a surface of their own
 * (the store files inside the store's directory), so no byte is counted
 * twice.
 */
function walkTree(
  root: string,
  skipTopLevel: ReadonlyArray<string>,
  add: (bytes: number) => void,
  refuse: () => void,
  skipFiles: ReadonlyArray<string> = [],
): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (!isAbsent(err)) refuse();
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipTopLevel.includes(entry.name)) continue;
      walkTree(join(root, entry.name), [], add, refuse, skipFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = join(root, entry.name);
    if (skipFiles.includes(filePath)) continue;
    addFile(filePath, add, refuse);
  }
}

/** The `Brain/` dot-directories that are surfaces of their own. */
const DOT_DIR_SURFACES: Readonly<Record<string, StorageSurface>> = Object.freeze({
  [".snapshots"]: STORAGE_SURFACE.snapshots,
  [".artifacts"]: STORAGE_SURFACE.artifacts,
  [".archives"]: STORAGE_SURFACE.archives,
  [".payloads"]: STORAGE_SURFACE.payloads,
  [".state"]: STORAGE_SURFACE.internalState,
});

/** Measure one directory-backed surface. */
function measureDirSurface(
  surface: StorageSurface,
  root: string,
  skipTopLevel: ReadonlyArray<string>,
  readings: Map<StorageSurface, number>,
  refusals: Set<StorageSurface>,
  skipFiles: ReadonlyArray<string> = [],
): void {
  let bytes = 0;
  let refused = refusals.has(surface);
  const add = (n: number): void => {
    bytes += n;
  };
  const refuse = (): void => {
    refused = true;
  };
  walkTree(root, skipTopLevel, add, refuse, skipFiles);
  if (refused) refusals.add(surface);
  else readings.set(surface, bytes);
}

/** Measure the derived store surface: the store file plus its sidecars. */
function measureStoreSurface(
  storePath: string,
  readings: Map<StorageSurface, number>,
  refusals: Set<StorageSurface>,
): void {
  let bytes = 0;
  let refused = false;
  const add = (n: number): void => {
    bytes += n;
  };
  const refuse = (): void => {
    refused = true;
  };
  for (const suffix of ["", STORE_WAL_SUFFIX, STORE_SHM_SUFFIX]) {
    addFile(`${storePath}${suffix}`, add, refuse);
  }
  if (refused) refusals.add(STORAGE_SURFACE.derivedStore);
  else readings.set(STORAGE_SURFACE.derivedStore, bytes);
}

/**
 * Measure every storage surface of `vault`, or refuse by name.
 *
 * Absent surfaces read as measured zero. An unreadable one produces no
 * byte claim at all: it is left out of `surfaces` and named in
 * `unmeasured`, so no caller can mistake "could not look" for "empty".
 */
export function measureStorageUsage(
  vault: string,
  opts: MeasureStorageUsageOptions = {},
): StorageUsage {
  const readings = new Map<StorageSurface, number>();
  const refusals = new Set<StorageSurface>();

  const brain = join(vault, BRAIN_ROOT_REL);
  // The catch-all tree walks everything EXCEPT the dot-dirs that are
  // surfaces of their own; those five roots are measured separately.
  measureDirSurface(
    STORAGE_SURFACE.brainTree,
    brain,
    Object.keys(DOT_DIR_SURFACES),
    readings,
    refusals,
  );
  for (const [dir, surface] of Object.entries(DOT_DIR_SURFACES)) {
    measureDirSurface(surface, join(brain, dir), [], readings, refusals);
  }
  const storePath = opts.storePath ?? resolveConfiguredIndexPath(vault, opts.configPath);
  // The store's directory is a counted surface of its own, minus the
  // store files - they are the derived_store surface, and the skip list
  // is what keeps one byte from landing in two surfaces.
  const storeFiles = [
    storePath,
    `${storePath}${STORE_WAL_SUFFIX}`,
    `${storePath}${STORE_SHM_SUFFIX}`,
  ];
  measureDirSurface(
    STORAGE_SURFACE.derivedStoreDir,
    join(vault, DERIVED_STORE_DIR),
    [],
    readings,
    refusals,
    storeFiles,
  );
  measureStoreSurface(storePath, readings, refusals);

  const surfaces = STORAGE_SURFACES.filter((s) => readings.has(s)).map((s) => ({
    surface: s,
    tier: SURFACE_TIERS[s],
    bytes: readings.get(s)!,
  }));
  const bytesByTier = Object.fromEntries(
    STORAGE_TIERS.map((tier) => [
      tier,
      surfaces.filter((s) => s.tier === tier).reduce((sum, s) => sum + s.bytes, 0),
    ]),
  ) as Record<StorageTier, number>;
  const unmeasured = STORAGE_SURFACES.filter((s) => refusals.has(s)).map((s) => ({
    surface: s,
    reason: STORAGE_UNMEASURED_REASON.surfaceUnreadable,
  }));
  return {
    measuredAt: (opts.now ?? new Date()).toISOString(),
    complete: unmeasured.length === 0,
    surfaces,
    bytesByTier,
    totalBytes: surfaces.reduce((sum, s) => sum + s.bytes, 0),
    unmeasured,
  };
}
