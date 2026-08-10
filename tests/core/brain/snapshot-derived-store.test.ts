/**
 * U6: derived-store coverage in the snapshot archive.
 *
 * The unit under test is a refusal discipline as much as a feature, so
 * the cases below are weighted towards what must NOT happen: no partial
 * archive after a refusal, no store touched by a restore that has no
 * record of one, no silent overwrite of an existing archive on a host
 * without zstd, and no `unknown` rendered as `excluded`.
 *
 * The fixture is a REAL index built by `indexVault` over a seeded vault,
 * through the same search-fixture helpers the search tests use. A
 * hand-written sqlite file would pass `PRAGMA quick_check` just as well,
 * but it would not exercise the writer lock the archiver takes on the
 * live store path, and that lock is the whole reason the copy is
 * consistent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  BrainSnapshotError,
  BrainSnapshotStoreError,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
} from "../../../src/core/brain/snapshot.ts";
import {
  manifestSidecarPath,
  readManifestSidecar,
  SNAPSHOT_STORE_EXCLUSION,
} from "../../../src/core/brain/manifest.ts";
import { brainDirs, snapshotPath, snapshotStorePath } from "../../../src/core/brain/paths.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { BRAIN_ARTIFACTS_DIR } from "../../../src/core/brain/path-constants.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

/** Coverage on, ceiling high enough that only the explicit cases trip it. */
const COVERED = { include: true, maxBytes: 1024 * 1024 * 1024 } as const;

/**
 * The reason every fixture here takes its snapshot for. `createSnapshot`
 * requires one; these cases are about derived-store coverage, and the
 * provenance axis is covered in `snapshot-reason.test.ts`.
 */
const DREAM = BRAIN_SNAPSHOT_REASON.dream;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-store-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-store-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });

  const dirs = brainDirs(vault);
  writeFileSync(
    join(dirs.preferences, "pref-foo.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nseed\n",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Build a real derived store for `vault` and return its path. */
async function seedDerivedStore(): Promise<string> {
  const dbPath = resolveIndexPath(vault, null);
  const notes = join(vault, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    join(notes, "seed.md"),
    "# Seed\n\nA paragraph long enough to be chunked and indexed by the walker.\n",
  );
  await indexVault(makeConfig({ vault, dbPath }));
  return dbPath;
}

describe("createSnapshot — derived-store coverage off (the default)", () => {
  test("writes no store archive and records not-requested with a live size", async () => {
    const dbPath = await seedDerivedStore();
    const runId = "dream-store-off";

    const res = createSnapshot(vault, runId, { reason: DREAM });

    expect(existsSync(snapshotStorePath(vault, runId))).toBe(false);
    expect(res.derived_store.included).toBe(false);
    expect(res.derived_store.exclusion_reason).toBe(SNAPSHOT_STORE_EXCLUSION.not_requested);
    // The whole point of measuring it even when nothing is archived: an
    // operator who has never enabled coverage still sees the cost.
    expect(res.derived_store.live_size).toBe(statSync(dbPath).size);
    expect(res.derived_store.live_size).not.toBeNull();

    const manifest = readManifestSidecar(vault, runId);
    expect(manifest?.derived_store).toEqual(res.derived_store);
  });

  test("records a null live size when there is no store to measure", () => {
    const res = createSnapshot(vault, "dream-store-off-absent", { reason: DREAM });
    expect(res.derived_store.live_size).toBeNull();
    expect(res.derived_store.exclusion_reason).toBe(SNAPSHOT_STORE_EXCLUSION.not_requested);
  });
});

describe("createSnapshot — derived-store coverage on", () => {
  test("writes the archive and the manifest digest matches its bytes", async () => {
    const dbPath = await seedDerivedStore();
    const runId = "dream-store-on";

    const res = createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });

    const archive = snapshotStorePath(vault, runId);
    expect(existsSync(archive)).toBe(true);
    expect(res.derived_store.included).toBe(true);
    expect(res.derived_store.exclusion_reason).toBeNull();
    expect(res.derived_store.source_path).toBe(dbPath);
    expect(res.derived_store.archive_sha256).toBe(sha256Hex(readFileSync(archive)));
    expect(res.derived_store.archive_size).toBe(statSync(archive).size);
    expect(res.derived_store.live_size).toBe(statSync(dbPath).size);

    const manifest = readManifestSidecar(vault, runId);
    expect(manifest?.derived_store).toEqual(res.derived_store);
  });

  test("the archive is a sibling of the tar, never a member of it", async () => {
    await seedDerivedStore();
    const runId = "dream-store-sibling";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });

    const listing = execFileSync("tar", ["-tf", snapshotPath(vault, runId)], {
      encoding: "utf8",
    });
    // Every member starts at `Brain/`; the extractor and the restore
    // both depend on that being the only top-level name in the tar.
    for (const line of listing.split("\n").filter((l) => l.trim() !== "")) {
      expect(line.startsWith("Brain/")).toBe(true);
    }
  });

  test("refuses an absent store and leaves no tar behind", () => {
    const runId = "dream-store-absent";
    try {
      createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainSnapshotStoreError);
      expect((err as BrainSnapshotStoreError).reason).toBe(SNAPSHOT_STORE_EXCLUSION.absent);
    }
    expect(existsSync(snapshotPath(vault, runId))).toBe(false);
    expect(existsSync(snapshotStorePath(vault, runId))).toBe(false);
    expect(existsSync(manifestSidecarPath(vault, runId))).toBe(false);
  });

  test("refuses a condemned store and leaves no tar behind", async () => {
    const dbPath = await seedDerivedStore();
    // Not a SQLite database any more. `new Database` is lazy, so this is
    // caught by the integrity scanner rather than by the open.
    writeFileSync(dbPath, "this is not a database");

    const runId = "dream-store-faulted";
    try {
      createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainSnapshotStoreError);
      expect((err as BrainSnapshotStoreError).reason).toBe(
        SNAPSHOT_STORE_EXCLUSION.integrity_fault,
      );
    }
    expect(existsSync(snapshotPath(vault, runId))).toBe(false);
    expect(existsSync(snapshotStorePath(vault, runId))).toBe(false);
  });

  test("refuses a store over the ceiling, naming the measured size", async () => {
    const dbPath = await seedDerivedStore();
    const liveSize = statSync(dbPath).size;
    const runId = "dream-store-too-big";

    try {
      createSnapshot(vault, runId, { reason: DREAM, derivedStore: { include: true, maxBytes: 1 } });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainSnapshotStoreError);
      expect((err as BrainSnapshotStoreError).reason).toBe(
        SNAPSHOT_STORE_EXCLUSION.over_size_ceiling,
      );
      // The measured size, not a vague "too large": it is the number the
      // operator sets the ceiling against.
      expect((err as Error).message).toContain(String(liveSize));
    }
    expect(existsSync(snapshotPath(vault, runId))).toBe(false);
    expect(existsSync(snapshotStorePath(vault, runId))).toBe(false);
  });

  test("refuses an existing store archive rather than overwriting it", async () => {
    await seedDerivedStore();
    const runId = "dream-store-collide";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });
    // Remove only the tar, so the second attempt reaches the store step
    // with the store archive already in place.
    rmSync(snapshotPath(vault, runId), { force: true });
    const archive = snapshotStorePath(vault, runId);
    const before = readFileSync(archive);

    expect(() => createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED })).toThrow(
      /refusing to overwrite/,
    );
    // And the refusal does not then clean up the file it refused to
    // overwrite. That archive belongs to another snapshot; removing it
    // while tidying after our own failure would reintroduce the
    // data-loss path through the back door.
    expect(readFileSync(archive).equals(before)).toBe(true);
  });
});

describe("listSnapshots and pruneSnapshots over a covered snapshot", () => {
  test("the listing carries the sidecar's derived-store record", async () => {
    await seedDerivedStore();
    createSnapshot(vault, "dream-list-covered", { reason: DREAM, derivedStore: COVERED });

    const [info] = listSnapshots(vault);
    expect(info?.derived_store?.included).toBe(true);
    expect(info?.store_archive_path).toBe(snapshotStorePath(vault, "dream-list-covered"));
  });

  test("a sidecar written before this feature renders as unknown, not excluded", () => {
    const runId = "dream-legacy-sidecar";
    createSnapshot(vault, runId, { reason: DREAM });
    // Exactly the shape a pre-feature peer wrote: schema version 1, no
    // derived-store key at all.
    const sidecar = manifestSidecarPath(vault, runId);
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    delete parsed["derived_store"];
    writeFileSync(sidecar, JSON.stringify(parsed, null, 2) + "\n");

    const [info] = listSnapshots(vault);
    // `null` is UNKNOWN. An `excluded` record would claim a check ran.
    expect(info?.derived_store).toBeNull();
    expect(readManifestSidecar(vault, runId)).not.toBeNull();
  });

  test("retention removes the store archive alongside the tar and the sidecar", async () => {
    await seedDerivedStore();
    const old = "dream-prune-covered-old";
    const fresh = "dream-prune-covered-new";
    createSnapshot(vault, old, { reason: DREAM, derivedStore: COVERED });
    const t = new Date("2026-05-09T00:00:00Z");
    utimesSync(snapshotPath(vault, old), t, t);
    createSnapshot(vault, fresh, { reason: DREAM, derivedStore: COVERED });

    pruneSnapshots(vault, 1);

    expect(existsSync(snapshotPath(vault, old))).toBe(false);
    expect(existsSync(snapshotStorePath(vault, old))).toBe(false);
    expect(existsSync(manifestSidecarPath(vault, old))).toBe(false);
    expect(existsSync(snapshotStorePath(vault, fresh))).toBe(true);
  });

  test("a snapshot without a store archive still prunes cleanly", () => {
    const old = "dream-prune-bare-old";
    createSnapshot(vault, old, { reason: DREAM });
    const t = new Date("2026-05-09T00:00:00Z");
    utimesSync(snapshotPath(vault, old), t, t);
    createSnapshot(vault, "dream-prune-bare-new", { reason: DREAM });

    const res = pruneSnapshots(vault, 1);
    expect(res.deleted).toContain(snapshotPath(vault, old));
    expect(existsSync(snapshotPath(vault, old))).toBe(false);
  });
});

describe("restoreSnapshot — the derived store", () => {
  test("a missing store archive refuses before the Brain tree is touched", async () => {
    // The store step used to run after the Markdown tree had been deleted
    // and re-copied, so this threw over work that had in fact completed:
    // the caller reported a failed rollback, logged nothing, and the vault
    // was rolled back anyway. Reachable whenever the sidecar survives
    // without its companion archive - partial replication, a sync rule
    // excluding large binaries, an operator reclaiming disk.
    await seedDerivedStore();
    const runId = "dream-archive-gone";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });

    // A marker the restore would have removed, so its survival proves the
    // tree was never touched rather than merely that the call threw.
    const marker = join(vault, "Brain", "post-snapshot-marker.md");
    writeFileSync(marker, "# only in the live tree\n");

    rmSync(snapshotStorePath(vault, runId), { force: true });

    expect(() => restoreSnapshot(vault, runId)).toThrow(/refusing before the Brain tree/u);
    expect(existsSync(marker)).toBe(true);
  });

  test("a derived-store record this build cannot read refuses rather than guessing", async () => {
    // Coverage is indeterminate here, so neither replacing the live store
    // nor leaving it can be justified - and the Markdown tree must not be
    // spent finding that out.
    await seedDerivedStore();
    const runId = "dream-record-unreadable";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });

    const marker = join(vault, "Brain", "post-snapshot-marker.md");
    writeFileSync(marker, "# only in the live tree\n");

    const sidecar = manifestSidecarPath(vault, runId);
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    writeFileSync(sidecar, JSON.stringify({ ...parsed, derived_store: "included" }));

    expect(() => restoreSnapshot(vault, runId)).toThrow(/indeterminate/u);
    expect(existsSync(marker)).toBe(true);
  });

  test("swaps the store and says so when the manifest recorded one", async () => {
    const dbPath = await seedDerivedStore();
    const runId = "dream-restore-covered";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });

    // Move the live store on: a row nothing in the archive knows about.
    const live = new Database(dbPath);
    live.exec("CREATE TABLE post_snapshot_marker (id INTEGER PRIMARY KEY)");
    live.close();
    expect(markerTableExists(dbPath)).toBe(true);

    const result = restoreSnapshot(vault, runId);

    expect(result.derived_store.replaced).toBe(true);
    expect(result.derived_store.coverage_known).toBe(true);
    expect(result.derived_store.path).toBe(dbPath);
    expect(result.derived_store.exclusion_reason).toBeNull();
    // The swap really happened: the post-snapshot table is gone.
    expect(markerTableExists(dbPath)).toBe(false);
    // No orphan WAL siblings of the file that was replaced.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  test("reports a non-included snapshot and leaves the live store alone", async () => {
    const dbPath = await seedDerivedStore();
    const runId = "dream-restore-uncovered";
    createSnapshot(vault, runId, { reason: DREAM });

    const live = new Database(dbPath);
    live.exec("CREATE TABLE post_snapshot_marker (id INTEGER PRIMARY KEY)");
    live.close();

    const result = restoreSnapshot(vault, runId);

    expect(result.derived_store.replaced).toBe(false);
    expect(result.derived_store.coverage_known).toBe(true);
    expect(result.derived_store.exclusion_reason).toBe(SNAPSHOT_STORE_EXCLUSION.not_requested);
    expect(markerTableExists(dbPath)).toBe(true);
  });

  test("reports unknown for a snapshot taken before coverage existed", async () => {
    const dbPath = await seedDerivedStore();
    const runId = "dream-restore-unknown";
    createSnapshot(vault, runId, { reason: DREAM });
    rmSync(manifestSidecarPath(vault, runId), { force: true });

    const result = restoreSnapshot(vault, runId);

    expect(result.derived_store.coverage_known).toBe(false);
    expect(result.derived_store.replaced).toBe(false);
    // Unknown must never be reported as an exclusion.
    expect(result.derived_store.exclusion_reason).toBeNull();
    // Nothing was archived, so there is no archive to contradict the
    // "no record" reading.
    expect(result.derived_store.store_archive_present).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  test("a lost record with the archive still on disk is a missing record, not a missing feature", async () => {
    // The sidecar write is non-fatal in `createSnapshot`, so coverage can
    // run to completion and leave no record of itself. The archive sitting
    // beside the tar is the proof, and reporting this as "the snapshot
    // predates derived-store coverage" states something the disk refutes.
    await seedDerivedStore();
    const runId = "dream-restore-record-lost";
    createSnapshot(vault, runId, { reason: DREAM, derivedStore: COVERED });
    expect(existsSync(snapshotStorePath(vault, runId))).toBe(true);

    const sidecar = manifestSidecarPath(vault, runId);
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    delete parsed["derived_store"];
    writeFileSync(sidecar, JSON.stringify(parsed, null, 2) + "\n");

    const result = restoreSnapshot(vault, runId);

    expect(result.derived_store.coverage_known).toBe(false);
    expect(result.derived_store.replaced).toBe(false);
    expect(result.derived_store.exclusion_reason).toBeNull();
    // The one fact that separates this from a pre-feature snapshot.
    expect(result.derived_store.store_archive_present).toBe(true);
  });
});

describe("the artifact directory documented as never backed up", () => {
  test("is neither archived nor hashed into the manifest", () => {
    const dirs = brainDirs(vault);
    const artifacts = join(dirs.brain, BRAIN_ARTIFACTS_DIR);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "run-1.json"), '{"ephemeral":true}');

    const runId = "dream-artifacts-excluded";
    createSnapshot(vault, runId, { reason: DREAM });

    const listing = execFileSync("tar", ["-tf", snapshotPath(vault, runId)], {
      encoding: "utf8",
    });
    expect(listing).not.toContain(BRAIN_ARTIFACTS_DIR);

    const manifest = readManifestSidecar(vault, runId);
    const hashed = Object.keys(manifest?.files ?? {});
    expect(hashed.some((p) => p.startsWith(`${BRAIN_ARTIFACTS_DIR}/`))).toBe(false);
  });

  test("survives a restore rather than being deleted by it", () => {
    const dirs = brainDirs(vault);
    const runId = "dream-artifacts-survive";
    createSnapshot(vault, runId, { reason: DREAM });

    const artifacts = join(dirs.brain, BRAIN_ARTIFACTS_DIR);
    mkdirSync(artifacts, { recursive: true });
    const cached = join(artifacts, "run-2.json");
    writeFileSync(cached, '{"ephemeral":true}');

    restoreSnapshot(vault, runId);

    // The archive holds no `.artifacts/`, so deleting the live copy
    // would restore nothing over it - a net loss for no benefit.
    expect(existsSync(cached)).toBe(true);
  });
});

describe("a host with gzip but no zstd", () => {
  test("refuses an existing archive exactly as the zstd path does", () => {
    const runId = "dream-gzip-collision";
    const originalPath = process.env["PATH"];
    const bin = gzipOnlyPath();
    process.env["PATH"] = bin.dir;
    try {
      createSnapshot(vault, runId, { reason: DREAM });
      const archive = snapshotPath(vault, runId);
      expect(existsSync(archive)).toBe(true);
      // Proves the fallback really was gzip: gzip's magic, not zstd's.
      const magic = readFileSync(archive).subarray(0, 2);
      expect([magic[0], magic[1]]).toEqual([0x1f, 0x8b]);
      const before = readFileSync(archive);

      // The run-id collision resolution in `snapshot-gate.ts` RETRIES on
      // exactly this failure. Without it, two concurrent destructive
      // operations on a gzip-only host destroy each other's recovery
      // point with no error at all.
      expect(() => createSnapshot(vault, runId, { reason: DREAM })).toThrow(BrainSnapshotError);
      expect(readFileSync(archive).equals(before)).toBe(true);
    } finally {
      process.env["PATH"] = originalPath;
      bin.cleanup();
    }
  });
});

/** A PATH directory holding `tar` and `gzip` but deliberately not `zstd`. */
function gzipOnlyPath(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "o2b-gzip-only-bin-"));
  for (const tool of ["tar", "gzip"]) {
    symlinkSync(which(tool), join(dir, tool));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function which(tool: string): string {
  return execFileSync("which", [tool], { encoding: "utf8" }).trim();
}

/** Whether the post-snapshot marker table is present in the store. */
function markerTableExists(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("post_snapshot_marker") !== null
    );
  } finally {
    db.close();
  }
}

describe("createSnapshot — which file is the store", () => {
  // The archiver used to answer this question with the default location
  // alone. On a vault that moved its store, that names a file the search
  // layer never reads: absent, if nothing is there, and - worse - a stale
  // database archived and reported as a success if something is. The pack
  // stamp shipped the same bug against the same config key.
  test("honours a search_db_path override and ignores a decoy at the default location", async () => {
    const moved = join(configHome, "moved-store.sqlite");
    const notes = join(vault, "Notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "seed.md"), "# Seed\n\nA paragraph long enough to be chunked.\n");
    await indexVault(makeConfig({ vault, dbPath: moved }));

    // A decoy where the archiver used to look. If it wins, the archive
    // describes a database nothing queries.
    const decoyPath = resolveIndexPath(vault, null);
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const decoy = new Database(decoyPath);
    decoy.run("CREATE TABLE decoy (id INTEGER PRIMARY KEY)");
    decoy.close();

    atomicWriteFileSync(configPath, `vault: ${vault}\nsearch_db_path: ${moved}\n`);
    const savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const savedDbEnv = process.env["OPEN_SECOND_BRAIN_SEARCH_DB"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    delete process.env["OPEN_SECOND_BRAIN_SEARCH_DB"];
    try {
      const res = createSnapshot(vault, "dream-store-moved", {
        reason: DREAM,
        derivedStore: COVERED,
      });
      expect(res.derived_store.included).toBe(true);
      expect(res.derived_store.source_path).toBe(moved);
      expect(res.derived_store.source_path).not.toBe(decoyPath);
      expect(res.derived_store.live_size).toBe(statSync(moved).size);
    } finally {
      if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
      if (savedDbEnv !== undefined) process.env["OPEN_SECOND_BRAIN_SEARCH_DB"] = savedDbEnv;
    }
  });

  test("an explicit derivedStorePath still wins over the resolved one", async () => {
    const dbPath = await seedDerivedStore();
    const res = createSnapshot(vault, "dream-store-explicit", {
      reason: DREAM,
      derivedStore: COVERED,
      derivedStorePath: dbPath,
    });
    expect(res.derived_store.source_path).toBe(dbPath);
  });
});
