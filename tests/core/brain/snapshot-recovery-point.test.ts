/**
 * The recovery point a destructive operation is actually protected by.
 *
 * Four reproduced defects, all of which ended in the same place: a
 * `covered` verdict, or a clean-looking rollback, with no archive on disk
 * behind it.
 *
 *   1. `takeSnapshot` ran the retention pass immediately after writing
 *      its archive and never looked at what the pass removed. The
 *      docblock called that safe "by arithmetic ... this archive is the
 *      newest in the directory", but `listSnapshots` orders by MTIME, not
 *      by creation order. One pre-existing archive whose mtime is an hour
 *      ahead - `rsync -t`, `cp -p`, NFS clock skew, a stepped clock - and
 *      the prune evicted the point it had just made, at retention 1. The
 *      gate then reported `covered` and ran the caller's operation.
 *      Equal-millisecond mtimes reach the same place through the stable
 *      sort's `readdir` fallback.
 *
 *   2. The rollback's recovery point took its own retention pass mid
 *      restore. Only the TAR has been extracted at that moment: the
 *      manifest sidecar and the derived-store archive are still read out
 *      of `.snapshots/` afterwards, so the prune could remove the archive
 *      being restored - and with derived-store coverage on, the store was
 *      silently never restored while the operator was told coverage was
 *      unknown. `assertDerivedStoreRestorable`'s "nothing is half
 *      restored" was defeated because the operation changed the state it
 *      had validated.
 *
 *   3. `pruneSnapshots` removed an archive's sidecar manifest and store
 *      archive OUTSIDE the success branch, so an archive that resisted
 *      removal was left orphaned: rollback against it then skips manifest
 *      drift detection and silently never restores its derived store.
 *
 *   4. `restoreSnapshot` derived its recoverability verdict from
 *      `opts.beforeDiscard !== undefined` - the existence of a FUNCTION,
 *      not of an archive. Any caller passing a callback that took no
 *      snapshot was told `covered`.
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  assertRecoveryPointOnDisk,
  restoreSnapshotWithRecoveryPoint,
  takeSnapshot,
  withDestructiveSnapshot,
} from "../../../src/core/brain/snapshot-gate.ts";
import {
  BrainSnapshotError,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
} from "../../../src/core/brain/snapshot.ts";
import { manifestSidecarPath } from "../../../src/core/brain/manifest.ts";
import { loadSnapshotRetentionSafe } from "../../../src/core/brain/policy.ts";
import { BrainConfigError } from "../../../src/core/brain/policy/errors.ts";
import {
  brainConfigPath,
  brainDirs,
  snapshotPath,
  snapshotStorePath,
} from "../../../src/core/brain/paths.ts";
import {
  RECOVERABILITY_BLOCKER,
  RECOVERABILITY_STATE,
} from "../../../src/core/brain/gates/recoverability.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

/** Coverage on, ceiling high enough that no fixture here trips it. */
const COVERED_STORE = { include: true, maxBytes: 1024 * 1024 * 1024 } as const;

const DREAM = BRAIN_SNAPSHOT_REASON.dream;

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recovery-point-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-recovery-point-cfg-"));
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

/** Rewrite the vault's configured retention to `count`. */
function setRetention(count: number): void {
  const path = brainConfigPath(vault);
  const text = readFileSync(path, "utf8").replace(
    /^(\s*)retention_count:\s*\d+/m,
    `$1retention_count: ${count}`,
  );
  writeFileSync(path, text);
}

/** Set an archive's mtime, in milliseconds since the epoch. */
function setMtime(path: string, ms: number): void {
  const t = new Date(ms);
  utimesSync(path, t, t);
}

/**
 * A REAL SQLite store carrying one recognisable value, because the
 * archiver runs `PRAGMA quick_check` over it and refuses anything else.
 */
function seedStore(state: string): string {
  const dir = join(vault, "Brain", ".artifacts");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "index.sqlite");
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.run("CREATE TABLE marker (state TEXT NOT NULL)");
    db.run("INSERT INTO marker (state) VALUES (?)", [state]);
  } finally {
    db.close();
  }
  return dbPath;
}

/** Read the marker back out of a store the restore has swapped in. */
function storeState(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT state FROM marker").get() as { state: string }).state;
  } finally {
    db.close();
  }
}

describe("the retention pass behind a recovery point cannot evict it", () => {
  test("a pre-existing archive with a FUTURE mtime is pruned, not the new point", () => {
    setRetention(1);
    // The state `rsync -t`, `cp -p` or a stepped system clock leaves: an
    // older archive that claims to be newer than anything written after
    // it. `listSnapshots` orders by mtime, so this archive sorts first.
    const stale = createSnapshot(vault, "dream-clock-skewed", { reason: DREAM }).path;
    setMtime(stale, Date.now() + 60 * 60 * 1000);

    const point = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual, {
      now: new Date("2026-06-01T00:00:00Z"),
    });

    expect(existsSync(point.path)).toBe(true);
    expect(point.prune?.deleted).not.toContain(point.path);
    expect(existsSync(stale)).toBe(false);
    expect(listSnapshots(vault).snapshots.map((s) => s.run_id)).toEqual([point.runId]);
  });

  test("an equal-millisecond mtime does not decide it either", () => {
    // The variant the mtime comparator answers with 0, leaving the order
    // to whatever `readdir` returned. Exercised against the prune
    // directly, because the tie cannot be arranged between a gate's own
    // `createSnapshot` and the retention pass one line behind it.
    const older = createSnapshot(vault, "dream-tie-a", { reason: DREAM }).path;
    const newer = createSnapshot(vault, "dream-tie-b", { reason: DREAM }).path;
    const tied = statSync(newer).mtimeMs;
    setMtime(older, tied);
    setMtime(newer, tied);

    const prune = pruneSnapshots(vault, 1, { protectRunIds: ["dream-tie-a"] });

    expect(prune.deleted).toEqual([newer]);
    expect(existsSync(older)).toBe(true);
    expect(prune.retained).toBe(1);
  });

  test("protecting more archives than the retention keeps every one of them", () => {
    // The second mechanism, on its own: reordering alone would leave the
    // surplus protected archives in the victim slice.
    const a = createSnapshot(vault, "dream-keep-a", { reason: DREAM }).path;
    const b = createSnapshot(vault, "dream-keep-b", { reason: DREAM }).path;
    const c = createSnapshot(vault, "dream-drop-c", { reason: DREAM }).path;

    const prune = pruneSnapshots(vault, 1, {
      protectRunIds: ["dream-keep-a", "dream-keep-b"],
    });

    expect(prune.deleted).toEqual([c]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("a configured retention of zero is refused at config load, not silently inverted", () => {
    // The prune's own floor turns 0 from "keep nothing" into "keep
    // everything", which reverses an operator's stated intent. It is
    // never reached through configuration: `retention_count` is
    // validated as a positive integer, so a vault configured with 0
    // raises on every read of the block rather than quietly keeping the
    // archives the operator asked to drop.
    setRetention(0);
    expect(() => loadSnapshotRetentionSafe(vault)).toThrow(BrainConfigError);

    // And the gate aborts on it rather than proceeding under a retention
    // it cannot honour: the config is read on the way IN to the snapshot,
    // so a vault configured with zero takes no recovery point and runs no
    // destructive operation until the operator fixes the value.
    expect(() => takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual)).toThrow(BrainConfigError);
    expect(listSnapshots(vault).snapshots).toEqual([]);
  });

  test("the gate refuses to run the operation when the point is not on disk", () => {
    // The verification itself, exercised directly: the one path that can
    // still reach it is a peer process removing the archive between the
    // write and the check, which no test can schedule.
    expect(() =>
      assertRecoveryPointOnDisk("manual-vanished", join(vault, "nowhere.tar.zst")),
    ).toThrow(BrainSnapshotError);
  });

  test("a destructive operation still sees its archive on disk", () => {
    setRetention(1);
    const stale = createSnapshot(vault, "dream-skew-under-op", { reason: DREAM }).path;
    setMtime(stale, Date.now() + 60 * 60 * 1000);

    let archivesWhenOpRan = -1;
    const out = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.deleteBySource,
      () => {
        archivesWhenOpRan = listSnapshots(vault).snapshots.length;
        return 1;
      },
      { now: new Date("2026-06-01T00:00:00Z") },
    );

    expect(archivesWhenOpRan).toBe(1);
    expect(existsSync(out.snapshot.path)).toBe(true);
    expect(out.recoverability.state).toBe(RECOVERABILITY_STATE.covered);
  });
});

describe("a prune that fails to remove an archive keeps its companions", () => {
  test("the sidecar of an archive that resisted removal survives with it", () => {
    createSnapshot(vault, "dream-stubborn", { reason: DREAM });
    const victim = snapshotPath(vault, "dream-stubborn");
    const sidecar = manifestSidecarPath(vault, "dream-stubborn");
    // A non-empty directory in the archive's place: `rmSync(path, {
    // force: true })` without `recursive` fails on it, which is the same
    // shape as the permission error the `failed` list was added for.
    rmSync(victim, { force: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "occupied"), "x");
    setMtime(victim, Date.now() - 60 * 60 * 1000);

    createSnapshot(vault, "dream-survivor", { reason: DREAM });

    const prune = pruneSnapshots(vault, 1);

    expect(prune.failed).toContain(victim);
    expect(prune.deleted).not.toContain(victim);
    expect(existsSync(victim)).toBe(true);
    // The orphaning: the archive is still there and its manifest is not,
    // so a rollback against it silently skips drift detection.
    expect(existsSync(sidecar)).toBe(true);
  });
});

describe("the restore verdict is derived from an archive, not from a callback", () => {
  test("a beforeDiscard that takes no snapshot reads unproven", () => {
    createSnapshot(vault, "dream-verdict-source", { reason: DREAM });

    const res = restoreSnapshot(vault, "dream-verdict-source", {
      beforeDiscard: () => {
        // Deliberately nothing: the shape any caller can pass today.
      },
    });

    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(res.recoverability.blockers).toContain(RECOVERABILITY_BLOCKER.noRecoveryPoint);
  });

  test("evidence naming an archive that is not on disk reads unproven", () => {
    createSnapshot(vault, "dream-verdict-absent", { reason: DREAM });

    const res = restoreSnapshot(vault, "dream-verdict-absent", {
      beforeDiscard: () => ({
        runId: "manual-never-written",
        path: snapshotPath(vault, "manual-never-written"),
      }),
    });

    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
  });

  test("the gated rollback reads covered, and the archive it names exists", () => {
    createSnapshot(vault, "dream-verdict-gated", { reason: DREAM });

    const res = restoreSnapshotWithRecoveryPoint(vault, "dream-verdict-gated");

    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.covered);
    expect(existsSync(res.recoveryPoint.path)).toBe(true);
  });
});

describe("the rollback's recovery point cannot evict what the restore still reads", () => {
  test("the target archive and its manifest survive the retention pass", () => {
    setRetention(1);
    const target = createSnapshot(vault, "manual-baseline", { reason: DREAM }).path;
    setMtime(target, Date.now() - 2 * 60 * 60 * 1000);
    // A second archive, so the target is not the newest and retention 1
    // would otherwise evict it the moment the recovery point lands.
    const newer = createSnapshot(vault, "dream-after-baseline", { reason: DREAM }).path;
    setMtime(newer, Date.now() - 60 * 60 * 1000);

    const res = restoreSnapshotWithRecoveryPoint(vault, "manual-baseline");

    expect(res.restored_files).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(manifestSidecarPath(vault, "manual-baseline"))).toBe(true);
    expect(res.recoveryPoint.prune?.deleted ?? []).not.toContain(target);
  });

  test("a covered derived store is restored rather than reported unknown", () => {
    setRetention(1);
    const dbPath = seedStore("state-a");

    createSnapshot(vault, "manual-store-baseline", {
      reason: DREAM,
      derivedStore: COVERED_STORE,
      derivedStorePath: dbPath,
    });
    const target = snapshotPath(vault, "manual-store-baseline");
    setMtime(target, Date.now() - 2 * 60 * 60 * 1000);
    expect(existsSync(snapshotStorePath(vault, "manual-store-baseline"))).toBe(true);

    const newer = createSnapshot(vault, "dream-store-after", { reason: DREAM }).path;
    setMtime(newer, Date.now() - 60 * 60 * 1000);
    seedStore("state-b");

    const res = restoreSnapshotWithRecoveryPoint(vault, "manual-store-baseline", {
      derivedStorePath: dbPath,
    });

    expect(res.derived_store.coverage_known).toBe(true);
    expect(res.derived_store.replaced).toBe(true);
    expect(storeState(dbPath)).toBe("state-a");
  });

  test("a beforeDiscard that removes the target's records aborts before the tree is touched", () => {
    const dbPath = seedStore("state-a");
    createSnapshot(vault, "manual-records-removed", {
      reason: DREAM,
      derivedStore: COVERED_STORE,
      derivedStorePath: dbPath,
    });
    const dirs = brainDirs(vault);
    // Written AFTER the archive, so a restore that reached the tree would
    // remove it. Its survival is what proves the abort came first.
    const addedAfter = join(dirs.preferences, "pref-added-after.md");
    writeFileSync(addedAfter, "---\nkind: brain-preference\n---\n\n## Principle\n\nlater\n");

    expect(() =>
      restoreSnapshot(vault, "manual-records-removed", {
        derivedStorePath: dbPath,
        beforeDiscard: () => {
          // Exactly what the unprotected retention pass did: remove the
          // records the restore has not read yet.
          rmSync(manifestSidecarPath(vault, "manual-records-removed"), { force: true });
          rmSync(snapshotStorePath(vault, "manual-records-removed"), { force: true });
        },
      }),
    ).toThrow(BrainSnapshotError);

    // Nothing half-restored: the live tree is exactly as it was.
    expect(existsSync(addedAfter)).toBe(true);
  });
});
