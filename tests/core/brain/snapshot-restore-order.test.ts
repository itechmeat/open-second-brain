/**
 * A restore changes nothing live until every step that can fail has run.
 *
 * `restoreSnapshot` used to replace the live `Brain/` tree and only then
 * decompress the archived derived store, so a `zstd` failure or timeout, a
 * corrupt payload or a full disk at that point left the rolled-back tree
 * beside the store it was meant to replace. The tree and the store are now
 * both staged and verified first, the recovery-point seam runs after that,
 * and the swap is a run of renames that is undone when one of them fails.
 *
 * Every failure case below asserts the same thing: `Brain/` (file by file),
 * `.snapshots/` (entry by entry) and the derived store (byte for byte) are
 * exactly what they were before the call, and no staging file is left.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import lockfile from "proper-lockfile";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { manifestSidecarPath } from "../../../src/core/brain/manifest.ts";
import { BRAIN_ARTIFACTS_DIR } from "../../../src/core/brain/path-constants.ts";
import { brainDirs, snapshotPath, snapshotStorePath } from "../../../src/core/brain/paths.ts";
import {
  BrainSnapshotError,
  createSnapshot,
  isStoreFamilyEntry,
  restoreSnapshot,
  SNAPSHOT_TOOL_TIMEOUT_ENV,
  StoreLockToken,
  storePlacement,
} from "../../../src/core/brain/snapshot.ts";
import { restoreSnapshotWithRecoveryPoint } from "../../../src/core/brain/snapshot-gate.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { acquireWriterLockSync } from "../../../src/core/search/store/writer-lock.ts";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const COVERED = { include: true, maxBytes: 1024 * 1024 * 1024 } as const;
const DREAM = BRAIN_SNAPSHOT_REASON.dream;
const RUN_ID = "dream-restore-order";

let root: string;
let vault: string;
let dbPath: string;
let originalPath: string | undefined;
let originalToolTimeout: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "o2b-restore-order-"));
  vault = join(root, "vault");
  mkdirSync(vault);
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(
    join(brainDirs(vault).preferences, "pref-foo.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nseed\n",
  );

  dbPath = resolveIndexPath(vault, null);
  const notes = join(vault, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "seed.md"), "# Seed\n\nA paragraph long enough to be indexed.\n");
  await indexVault(makeConfig({ vault, dbPath }));

  originalPath = process.env["PATH"];
  originalToolTimeout = process.env[SNAPSHOT_TOOL_TIMEOUT_ENV];
});

afterEach(() => {
  process.env["PATH"] = originalPath;
  if (originalToolTimeout === undefined) delete process.env[SNAPSHOT_TOOL_TIMEOUT_ENV];
  else process.env[SNAPSHOT_TOOL_TIMEOUT_ENV] = originalToolTimeout;
  // A test that made `Brain/` read-only must not leave the cleanup stuck.
  try {
    chmodSync(brainDirs(vault).brain, 0o755);
  } catch {
    // gone already
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * Take the covered snapshot, then move the live state on: a changed file,
 * a new file the archive never held, and a table only the live store has.
 */
function snapshotThenDiverge(): void {
  createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
  diverge();
}

/** Move the live tree and store on from whatever the snapshot holds. */
function diverge(): void {
  const dirs = brainDirs(vault);
  writeFileSync(
    join(dirs.preferences, "pref-foo.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nchanged after the snapshot\n",
  );
  writeFileSync(join(dirs.brain, "post-snapshot-marker.md"), "# only in the live tree\n");
  const live = new Database(dbPath);
  live.exec("CREATE TABLE post_snapshot_marker (id INTEGER PRIMARY KEY)");
  live.close();
}

/** Everything under `dir`, as relative path -> content (or link target). */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      const rel = relative(dir, abs);
      if (entry.isSymbolicLink()) out[rel] = `-> ${readlinkSync(abs)}`;
      else if (entry.isDirectory()) {
        out[`${rel}/`] = "";
        walk(abs);
      } else out[rel] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** The observable live state a failed restore must leave as it was. */
function liveState(): { brain: Record<string, string>; store: string; storeDir: string[] } {
  return {
    brain: treeOf(brainDirs(vault).brain),
    store: sha256Hex(readFileSync(dbPath)),
    storeDir: readdirSync(dirname(dbPath)).toSorted(),
  };
}

/** Rewrite the store archive and keep the manifest digest in step with it. */
function replaceStoreArchive(bytes: Buffer): void {
  writeFileSync(snapshotStorePath(vault, RUN_ID), bytes);
  const sidecar = manifestSidecarPath(vault, RUN_ID);
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as {
    derived_store: Record<string, unknown>;
  };
  parsed.derived_store["archive_sha256"] = sha256Hex(bytes);
  writeFileSync(sidecar, JSON.stringify(parsed, null, 2) + "\n");
}

function markerTableExists(): boolean {
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

/** Run `fn` expecting a refusal, and prove nothing live changed. */
function expectUntouched(fn: () => unknown, message: RegExp): void {
  const before = liveState();
  let threw: unknown = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(BrainSnapshotError);
  expect((threw as Error).message).toMatch(message);
  expect(liveState()).toEqual(before);
  expect(markerTableExists()).toBe(true);
}

describe("a derived-store failure before the swap leaves the live state untouched", () => {
  test("a corrupt store payload (decompression fails)", () => {
    snapshotThenDiverge();
    // gzip magic so the restore inflates it in-process on every host,
    // followed by bytes no inflater accepts. The digest is updated, so this
    // is a payload that is wrong, not an archive that was swapped.
    replaceStoreArchive(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00]));
    let recoveryPointTaken = false;
    expectUntouched(
      () =>
        restoreSnapshot(vault, RUN_ID, {
          beforeDiscard: () => {
            recoveryPointTaken = true;
          },
        }),
      /gzip decompress failed/u,
    );
    // The failure arrived before the recovery-point seam: nothing was
    // about to be discarded yet.
    expect(recoveryPointTaken).toBe(false);
  });

  test("a payload that decompresses but is not a sound database", () => {
    snapshotThenDiverge();
    replaceStoreArchive(gzipSync(Buffer.from("not a sqlite database at all\n")));
    expectUntouched(() => restoreSnapshot(vault, RUN_ID), /failed verification/u);
  });

  test("a store archive that does not match its recorded digest", () => {
    snapshotThenDiverge();
    writeFileSync(snapshotStorePath(vault, RUN_ID), gzipSync(Buffer.from("swapped")));
    expectUntouched(() => restoreSnapshot(vault, RUN_ID), /does not match the digest/u);
  });

  test("the store's writer lock held by another writer", () => {
    snapshotThenDiverge();
    const release = lockfile.lockSync(dbPath, { realpath: false });
    try {
      expectUntouched(() => restoreSnapshot(vault, RUN_ID), /writer lock/u);
    } finally {
      release();
    }
  });
});

const realZstd = Bun.which("zstd");
const realTar = Bun.which("tar");
const realSleep = Bun.which("sleep");

/**
 * A PATH holding the real `tar` and a stand-in `zstd` that runs the real
 * one for the Brain tar (staged as `brain.tar`) and runs `body` for any
 * other target, which in a restore is only the derived store.
 */
function storeOnlyZstd(body: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(realTar!, join(bin, "tar"));
  const script = [
    "#!/bin/sh",
    'case "$*" in',
    `  *brain.tar*) exec '${realZstd}' "$@" ;;`,
    "esac",
    body,
    "",
  ].join("\n");
  writeFileSync(join(bin, "zstd"), script);
  chmodSync(join(bin, "zstd"), 0o755);
  process.env["PATH"] = bin;
}

function expectZstdArchives(): void {
  // The stand-in is only reached for zstd archives; a gzip fallback here
  // would make the test pass without exercising the failure.
  for (const archive of [snapshotPath(vault, RUN_ID), snapshotStorePath(vault, RUN_ID)]) {
    const magic = readFileSync(archive).subarray(0, 4);
    expect([...magic]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  }
}

describe.skipIf(
  process.platform === "win32" || realZstd === null || realTar === null || realSleep === null,
)("a failing zstd on the store archive", () => {
  test("exits non-zero", () => {
    snapshotThenDiverge();
    expectZstdArchives();
    storeOnlyZstd("exit 3");
    expectUntouched(() => restoreSnapshot(vault, RUN_ID), /zstd exited with status 3/u);
  });

  test("runs past the snapshot tool timeout", () => {
    snapshotThenDiverge();
    expectZstdArchives();
    // Absolute: the PATH here holds only `tar` and the stand-in.
    storeOnlyZstd(`exec '${realSleep}' 30`);
    process.env[SNAPSHOT_TOOL_TIMEOUT_ENV] = "1500";
    expectUntouched(() => restoreSnapshot(vault, RUN_ID), /zstd did not finish within 1500 ms/u);
  });
});

describe.skipIf(CHMOD_CANNOT_DENY)("a rename that fails during the swap", () => {
  test("is undone, and the error says so", () => {
    snapshotThenDiverge();
    // Live entries cannot be moved out of a read-only `Brain/`, while the
    // staging directory under `.snapshots/` stays writable: the restore
    // gets all the way to the swap and fails at its first rename.
    chmodSync(brainDirs(vault).brain, 0o555);
    expectUntouched(
      () => restoreSnapshot(vault, RUN_ID),
      /failed during the swap.*every Brain\/ rename was undone.*as they were/u,
    );
  });
});

/** An errno-shaped error, as a failing `rename(2)` or `unlink(2)` raises it. */
function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: simulated by the test, ${path}`), { code });
}

/**
 * Run `fn` with `renameSync` failing wherever `failOn` returns true. The
 * real rename runs otherwise, so every other step of the restore is real.
 * `renameWithRetry` (`src/core/fs-atomic.ts`) calls the namespace's
 * `renameSync`, which is what the spy replaces.
 */
function withFailingRename<T>(failOn: (from: string, to: string) => boolean, fn: () => T): T {
  const realRename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (failOn(String(from), String(to))) throw fsError("EIO", String(to));
    realRename(from, to);
  });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/** True for a rename of a staged Brain/ entry into the live `Brain/`. */
function isMoveIn(from: string, to: string): boolean {
  return (
    from.includes(".restore-staging-") &&
    basename(dirname(from)) === "incoming" &&
    dirname(to) === brainDirs(vault).brain
  );
}

/** Run `fn` expecting a {@link BrainSnapshotError}; return its message. */
function refusal(fn: () => unknown): string {
  let threw: unknown = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(BrainSnapshotError);
  return (threw as Error).message;
}

describe("a failure in the middle of the swap", () => {
  test("a later move-in failing undoes the entries moved both ways, in reverse", () => {
    snapshotThenDiverge();
    let moveIns = 0;
    expectUntouched(
      () =>
        withFailingRename(
          (from, to) => isMoveIn(from, to) && ++moveIns === 2,
          () => restoreSnapshot(vault, RUN_ID),
        ),
      // Every live entry was out and one restored entry in when it failed.
      /(\d+) of \1 live Brain\/ top-level entries had been moved aside and 1 of \d+ restored ones moved in; every Brain\/ rename was undone, so Brain\/ and the derived store are as they were/u,
    );
    expect(moveIns).toBe(2);
    expect(readdirSync(brainDirs(vault).snapshots).some((n) => n.startsWith(".restore-"))).toBe(
      false,
    );
  });

  test("an undo that also fails keeps the staging directory and says Brain/ is mixed", () => {
    snapshotThenDiverge();
    const dirs = brainDirs(vault);
    let moveIns = 0;
    let firstIn = "";
    const message = refusal(() =>
      withFailingRename(
        (from, to) => {
          if (isMoveIn(from, to)) {
            moveIns += 1;
            if (moveIns === 1) firstIn = basename(to);
            return moveIns === 2;
          }
          // The undo of the one entry that made it in.
          return from === join(dirs.brain, firstIn) && basename(dirname(to)) === "incoming";
        },
        () => restoreSnapshot(vault, RUN_ID),
      ),
    );
    expect(message).toMatch(/undoing it also failed \(could not move the restored /u);
    expect(message).toMatch(/Brain\/ is a mix of the restored and the pre-restore tree/u);
    // The staging directory outlived the restore, with the pre-restore
    // entries put back and the stuck restored one still live.
    const staging = readdirSync(dirs.snapshots).filter((n) => n.startsWith(".restore-staging-"));
    expect(staging).toHaveLength(1);
    const kept = join(dirs.snapshots, staging[0]!);
    expect(message).toContain(join(kept, "outgoing"));
    expect(existsSync(join(kept, "outgoing"))).toBe(true);
    expect(existsSync(join(dirs.brain, firstIn))).toBe(true);
    expect(existsSync(join(dirs.brain, "post-snapshot-marker.md"))).toBe(true);
  });

  test("a failing store rename-back is reported as a torn store, with Brain/ undone", () => {
    snapshotThenDiverge();
    const before = liveState();
    const backup = `${dbPath}.bak`;
    const message = refusal(() =>
      withFailingRename(
        (from, to) => to === dbPath && (from.startsWith(`${dbPath}.restore-`) || from === backup),
        () => restoreSnapshot(vault, RUN_ID),
      ),
    );
    expect(message).toMatch(/the pre-restore store could not be renamed back either/u);
    expect(message).toContain(`is at ${backup}`);
    expect(message).toMatch(
      /Brain\/ is as it was before the restore, but the derived store is not/u,
    );
    expect(treeOf(brainDirs(vault).brain)).toEqual(before.brain);
    expect(existsSync(dbPath)).toBe(false);
    expect(sha256Hex(readFileSync(backup))).toBe(before.store);
  });

  test("a live store that cannot be moved aside fails with the store-swap context", () => {
    snapshotThenDiverge();
    expectUntouched(
      () =>
        withFailingRename(
          (from, to) => from === dbPath && to === `${dbPath}.bak`,
          () => restoreSnapshot(vault, RUN_ID),
        ),
      /derived store swap failed \(could not move the live store .* aside .*the live store was not touched\).*as they were/u,
    );
  });

  test("a -wal that cannot be removed after the store swap undoes the whole restore", () => {
    snapshotThenDiverge();
    // A log left beside the live store, held open the way a Windows
    // reader holds it: the removal fails on every attempt.
    const wal = `${dbPath}-wal`;
    writeFileSync(wal, "");
    const realUnlink = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === wal) throw fsError("EBUSY", wal);
      realUnlink(path);
    });
    try {
      expectUntouched(
        () => restoreSnapshot(vault, RUN_ID),
        /could not remove .*-wal .*the store swap was undone.*every Brain\/ rename was undone, so Brain\/ and the derived store are as they were/u,
      );
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(wal)).toBe(true);
  });
});

describe("a restore staging directory left under Brain/", () => {
  test("is neither archived nor swapped by a later restore", () => {
    const dirs = brainDirs(vault);
    // What a restore killed mid-swap leaves when it staged under Brain/.
    const leftover = join(dirs.brain, ".restore-staging-killed-abc123");
    mkdirSync(join(leftover, "incoming"), { recursive: true });
    writeFileSync(join(leftover, "incoming", "half.md"), "half-written\n");

    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    expect(readFileSync(manifestSidecarPath(vault, RUN_ID), "utf8")).not.toContain(
      ".restore-staging-",
    );
    diverge();
    writeFileSync(join(leftover, "incoming", "half.md"), "changed after the snapshot\n");

    restoreSnapshot(vault, RUN_ID);

    // Left exactly where and as it was: not moved aside, not replaced by
    // an archived copy.
    expect(readFileSync(join(leftover, "incoming", "half.md"), "utf8")).toBe(
      "changed after the snapshot\n",
    );
    expect(readdirSync(leftover)).toEqual(["incoming"]);
    expect(markerTableExists()).toBe(false);
  });
});

describe("a successful restore", () => {
  test("restores the tree and the store, keeps the excluded entries, leaves no staging", () => {
    const dirs = brainDirs(vault);
    // Read before the snapshot: `createSnapshot` logs itself after the
    // archive is written, so the tree afterwards holds one entry more.
    const snapshotTree = treeOf(dirs.brain);
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    diverge();
    const artifacts = join(dirs.brain, BRAIN_ARTIFACTS_DIR);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "run.json"), "{}");
    const snapshotsBefore = readdirSync(dirs.snapshots).toSorted();

    let staged = null as { tree: boolean; store: boolean } | null;
    const result = restoreSnapshot(vault, RUN_ID, {
      // Both stagings exist by the time the recovery point is taken.
      beforeDiscard: () => {
        staged = {
          tree: readdirSync(dirs.snapshots).some((n) => n.startsWith(".restore-staging-")),
          store: readdirSync(dirname(dbPath)).some((n) =>
            n.startsWith(`${basename(dbPath)}.restore-`),
          ),
        };
      },
    });

    expect(staged).toEqual({ tree: true, store: true });
    expect(result.derived_store.replaced).toBe(true);
    expect(result.derived_store.path).toBe(dbPath);
    expect(markerTableExists()).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    // Brain/ equals the snapshot, except the two excluded entries, which
    // are exactly what they were before the restore.
    const after = treeOf(dirs.brain);
    expect(withoutExcluded(after)).toEqual(withoutExcluded(snapshotTree));
    expect(readFileSync(join(artifacts, "run.json"), "utf8")).toBe("{}");
    expect(readdirSync(dirs.snapshots).toSorted()).toEqual(snapshotsBefore);
    expect(
      readdirSync(dirname(dbPath)).filter((n) => n.startsWith(`${basename(dbPath)}.restore`)),
    ).toEqual([]);
    expect(result.restored_files).toBe(
      Object.keys(withoutExcluded(snapshotTree)).filter((p) => !p.endsWith("/")).length,
    );
  });

  test.skipIf(process.platform === "win32")("keeps an in-tree relative symlink", () => {
    const dirs = brainDirs(vault);
    symlinkSync("pref-foo.md", join(dirs.preferences, "alias.md"));
    createSnapshot(vault, RUN_ID, { reason: DREAM });
    rmSync(join(dirs.preferences, "alias.md"));

    restoreSnapshot(vault, RUN_ID);

    const link = join(dirs.preferences, "alias.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("pref-foo.md");
    expect(readFileSync(link, "utf8")).toContain("seed");
  });

  test.skipIf(process.platform === "win32")(
    "keeps a top-level link to another top-level entry that is staged after it",
    () => {
      // `aa-link.md` sorts before `zz-target.md`, so it is staged first; the
      // staged link resolves only once its target is staged too.
      writeFileSync(join(vault, "Brain", "zz-target.md"), "target\n");
      symlinkSync("zz-target.md", join(vault, "Brain", "aa-link.md"));
      createSnapshot(vault, RUN_ID, { reason: DREAM });
      rmSync(join(vault, "Brain", "aa-link.md"));
      rmSync(join(vault, "Brain", "zz-target.md"));

      restoreSnapshot(vault, RUN_ID);

      const link = join(vault, "Brain", "aa-link.md");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(link, "utf8")).toBe("target\n");
    },
  );
});

/** A {@link treeOf} result without the entries a restore never touches. */
function withoutExcluded(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).filter(
      ([p]) => !p.startsWith(".snapshots") && !p.startsWith(BRAIN_ARTIFACTS_DIR),
    ),
  );
}

/** Turn on derived-store coverage in the vault's own policy, as an operator does. */
function coverStoreByPolicy(): void {
  atomicWriteFileSync(
    join(brainDirs(vault).brain, "_brain.yaml"),
    "schema_version: 1\nsnapshots:\n  include_derived_store: true\n",
  );
}

/** Names of the tables in the store at `path`. */
function tablesOf(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
      .toSorted();
  } finally {
    db.close();
  }
}

type LockSync = typeof lockfile.lockSync;

/**
 * Run `fn` with every writer lock taken on the live store wrapped by
 * `wrapRelease`. Locks on other paths, and locks the test itself takes
 * while `bypass()` is true, are the real ones.
 */
function withStoreLockRelease<T>(
  wrapRelease: (real: () => void) => () => void,
  fn: () => T,
  bypass: () => boolean = () => false,
): T {
  const realLockSync: LockSync = lockfile.lockSync.bind(lockfile);
  const spy = spyOn(lockfile, "lockSync").mockImplementation(((path, opts) => {
    const release = realLockSync(path, opts);
    return String(path) === dbPath && !bypass() ? wrapRelease(release) : release;
  }) as LockSync);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe("the gated restore holds the store lock from the recovery point through the swap", () => {
  test("a writer cannot commit between the recovery point and the swap", () => {
    coverStoreByPolicy();
    snapshotThenDiverge();

    // A writer waiting on the lock: the moment any holder releases it
    // before the store is swapped, it takes the lock and commits.
    let swapped = false;
    let inWriter = false;
    let lateCommits = 0;
    const writer = (): void => {
      inWriter = true;
      try {
        const release = acquireWriterLockSync(dbPath);
        try {
          const db = new Database(dbPath);
          db.exec(`CREATE TABLE late_commit_${lateCommits} (id INTEGER PRIMARY KEY)`);
          db.close();
          lateCommits++;
        } finally {
          release();
        }
      } finally {
        inWriter = false;
      }
    };

    // What the swap replaces, read at the swap itself, and whether a
    // writer could take the lock at that point.
    let replaced: string[] | null = null;
    let writerAtSwap: unknown = null;
    const realRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === dbPath && String(to) === `${dbPath}.bak`) {
        replaced = tablesOf(dbPath);
        try {
          inWriter = true;
          acquireWriterLockSync(dbPath)();
        } catch (err) {
          writerAtSwap = err;
        } finally {
          inWriter = false;
        }
        swapped = true;
      }
      realRename(from, to);
    });
    let recoveryRunId: string;
    try {
      const result = withStoreLockRelease(
        (real) => () => {
          real();
          if (!swapped) writer();
        },
        () => restoreSnapshotWithRecoveryPoint(vault, RUN_ID),
        () => inWriter,
      );
      recoveryRunId = result.recoveryPoint.runId;
    } finally {
      renameSpy.mockRestore();
    }

    // The lock was never released before the swap, so no writer got in,
    // and one that tried at the swap was refused.
    expect(lateCommits).toBe(0);
    expect(String(writerAtSwap)).toMatch(/another writer holds the search index lock/u);
    expect(replaced).not.toBeNull();
    expect(replaced!).toContain("post_snapshot_marker");
    expect(markerTableExists()).toBe(false);

    // The recovery point holds every table the restore replaced.
    restoreSnapshot(vault, recoveryRunId);
    expect(tablesOf(dbPath)).toEqual(replaced!);
  });

  test("a lock release that fails after the swap committed says so and names the recovery point", () => {
    coverStoreByPolicy();
    snapshotThenDiverge();
    let threw: unknown = null;
    try {
      withStoreLockRelease(
        (real) => () => {
          real();
          throw new Error("simulated unlock failure");
        },
        () => restoreSnapshotWithRecoveryPoint(vault, RUN_ID),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(BrainSnapshotError);
    expect((threw as Error).message).toMatch(
      /the restore committed: Brain\/ and the derived store now hold snapshot dream-restore-order, but releasing the derived store's writer lock failed \(simulated unlock failure\).*the recovery point manual-\S+ \(.+\) holds the pre-restore state/u,
    );
    // It did commit: the live state is the snapshot's.
    expect(markerTableExists()).toBe(false);
    expect(existsSync(join(brainDirs(vault).brain, "post-snapshot-marker.md"))).toBe(false);
  });

  test("a lock release that fails after a failed swap does not mask the swap error", () => {
    snapshotThenDiverge();
    expectUntouched(
      () =>
        withStoreLockRelease(
          (real) => () => {
            real();
            throw new Error("simulated unlock failure");
          },
          () => withFailingRename(isMoveIn, () => restoreSnapshot(vault, RUN_ID)),
        ),
      /^snapshot\[dream-restore-order\]: restore failed during the swap: a Brain\/ rename failed.*as they were before the restore\nalso: releasing the derived store's writer lock failed \(simulated unlock failure\)$/su,
    );
  });
});

describe("a -wal removal failure with no live store before the restore", () => {
  test("does not claim a pre-restore store was put back", () => {
    snapshotThenDiverge();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    const wal = `${dbPath}-wal`;
    writeFileSync(wal, "");
    const realUnlink = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === wal) throw fsError("EBUSY", wal);
      realUnlink(path);
    });
    let threw: unknown = null;
    try {
      restoreSnapshot(vault, RUN_ID);
    } catch (err) {
      threw = err;
    } finally {
      spy.mockRestore();
    }
    expect(threw).toBeInstanceOf(BrainSnapshotError);
    const message = (threw as Error).message;
    expect(message).toMatch(/the store swap was undone, and no store was live before it/u);
    expect(message).not.toMatch(/back in place/u);
    expect(existsSync(dbPath)).toBe(false);
  });
});

/** A store at an override path, distinct from the configured one. */
function overrideStore(): { derivedStorePath: string; derivedStore: typeof COVERED } {
  const override = join(root, "override", "index.sqlite");
  mkdirSync(dirname(override), { recursive: true });
  const live = new Database(dbPath);
  live.exec(`VACUUM INTO '${override.replaceAll("'", "''")}'`);
  live.close();
  return { derivedStorePath: override, derivedStore: COVERED };
}

function addTable(path: string, name: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
  db.close();
}

describe("the recovery point archives exactly the store the restore replaces", () => {
  test("with a derivedStorePath override, the recovery point holds the override store", () => {
    const store = overrideStore();
    createSnapshot(vault, RUN_ID, { reason: DREAM, ...store });
    addTable(store.derivedStorePath, "override_marker");

    const res = restoreSnapshotWithRecoveryPoint(vault, RUN_ID, store);

    expect(tablesOf(store.derivedStorePath)).not.toContain("override_marker");
    const recorded = JSON.parse(
      readFileSync(manifestSidecarPath(vault, res.recoveryPoint.runId), "utf8"),
    ) as { derived_store: { included: boolean; source_path: string } };
    expect(recorded.derived_store.included).toBe(true);
    expect(recorded.derived_store.source_path).toBe(store.derivedStorePath);

    // The discarded override store comes back from the recovery point.
    restoreSnapshot(vault, res.recoveryPoint.runId, store);
    expect(tablesOf(store.derivedStorePath)).toContain("override_marker");
  });

  test("a store the restore replaces is archived even when the policy leaves it out", () => {
    // The snapshot covered the store; the restore runs under the default
    // policy, which would leave the store out of an ordinary snapshot.
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    addTable(dbPath, "late_marker");

    const res = restoreSnapshotWithRecoveryPoint(vault, RUN_ID, {
      derivedStore: { include: false, maxBytes: COVERED.maxBytes },
    });

    expect(tablesOf(dbPath)).not.toContain("late_marker");
    const recorded = JSON.parse(
      readFileSync(manifestSidecarPath(vault, res.recoveryPoint.runId), "utf8"),
    ) as { derived_store: { included: boolean } };
    expect(recorded.derived_store.included).toBe(true);
    restoreSnapshot(vault, res.recoveryPoint.runId);
    expect(tablesOf(dbPath)).toContain("late_marker");
  });

  test("an absent live store does not block the restore that recreates it", () => {
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

    restoreSnapshotWithRecoveryPoint(vault, RUN_ID);

    expect(existsSync(dbPath)).toBe(true);
    expect(tablesOf(dbPath).length).toBeGreaterThan(0);
  });

  test("a condemned live store is healed by the restore, not preserved by refusing it", () => {
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "this is not a database");

    restoreSnapshotWithRecoveryPoint(vault, RUN_ID);

    expect(tablesOf(dbPath).length).toBeGreaterThan(0);
  });

  test("with coverage on by the vault's policy, an absent live store is recreated", () => {
    coverStoreByPolicy();
    createSnapshot(vault, RUN_ID, { reason: DREAM });
    const archived = tablesOf(dbPath);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

    const res = restoreSnapshotWithRecoveryPoint(vault, RUN_ID);

    expect(tablesOf(dbPath)).toEqual(archived);
    expect(recordedStore(res.recoveryPoint.runId)).toEqual({
      included: false,
      exclusion_reason: "not-requested",
    });
  });

  test("with coverage on by the vault's policy, a condemned live store is healed", () => {
    coverStoreByPolicy();
    createSnapshot(vault, RUN_ID, { reason: DREAM });
    const archived = tablesOf(dbPath);
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "this is not a database");

    const res = restoreSnapshotWithRecoveryPoint(vault, RUN_ID);

    expect(tablesOf(dbPath)).toEqual(archived);
    expect(recordedStore(res.recoveryPoint.runId)).toEqual({
      included: false,
      exclusion_reason: "not-requested",
    });
  });

  test("a recovery point that left the replaced store out refuses the swap", () => {
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    addTable(dbPath, "late_marker");
    const storeBefore = sha256Hex(readFileSync(dbPath));

    expect(() =>
      restoreSnapshot(vault, RUN_ID, {
        beforeDiscard: ({ heldStoreLock }) => {
          const point = createSnapshot(vault, "manual-no-store", {
            reason: BRAIN_SNAPSHOT_REASON.manual,
            derivedStore: { include: false, maxBytes: COVERED.maxBytes },
            ...(heldStoreLock !== null ? { heldStoreLock } : {}),
          });
          return { runId: "manual-no-store", path: point.path };
        },
      }),
    ).toThrow(/did not include the derived store/);
    expect(sha256Hex(readFileSync(dbPath))).toBe(storeBefore);
    expect(tablesOf(dbPath)).toContain("late_marker");
  });

  test("a recovery point of another store refuses the swap before anything is touched", () => {
    const store = overrideStore();
    createSnapshot(vault, RUN_ID, { reason: DREAM, ...store });
    addTable(store.derivedStorePath, "override_marker");
    // Read after the recovery point lands: its log lines are the only
    // change to the tree the refused restore may leave.
    let brainBefore: Record<string, string> = {};

    let threw: unknown = null;
    try {
      restoreSnapshot(vault, RUN_ID, {
        ...store,
        beforeDiscard: () => {
          // Resolves its own source: the configured store, not the override.
          const point = createSnapshot(vault, "manual-wrong-store", {
            reason: BRAIN_SNAPSHOT_REASON.manual,
            derivedStore: COVERED,
          });
          brainBefore = treeOf(brainDirs(vault).brain);
          return { runId: "manual-wrong-store", path: point.path };
        },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(BrainSnapshotError);
    expect((threw as Error).message).toMatch(
      /recorded the derived store at .+, but this restore replaces .+override.+refusing before the Brain tree is touched/u,
    );
    expect(tablesOf(store.derivedStorePath)).toContain("override_marker");
    expect(withoutExcluded(treeOf(brainDirs(vault).brain))).toEqual(withoutExcluded(brainBefore));
  });
});

describe("createSnapshot skips its own store lock only for the restore's live token on that store", () => {
  const LOCKED = /another writer holds the search index lock/u;

  test("the restore's token is used; a path string, a look-alike or a hand-made token is not", () => {
    coverStoreByPolicy();
    snapshotThenDiverge();
    let seen: { storeTarget: string | null; token: StoreLockToken | null } | null = null;

    const res = restoreSnapshot(vault, RUN_ID, {
      beforeDiscard: ({ storeTarget, heldStoreLock }) => {
        seen = { storeTarget, token: heldStoreLock };
        // The old hint: a string naming the locked path. The restore still
        // holds the lock, so the snapshot's own acquire refuses.
        expect(() =>
          createSnapshot(vault, "dream-string-hint", {
            reason: DREAM,
            heldStoreLock: dbPath as unknown as StoreLockToken,
          }),
        ).toThrow(LOCKED);
        // Objects that look like a token without being minted by the restore.
        expect(() =>
          createSnapshot(vault, "dream-look-alike", {
            reason: DREAM,
            heldStoreLock: { path: dbPath } as unknown as StoreLockToken,
          }),
        ).toThrow(LOCKED);
        expect(() =>
          createSnapshot(vault, "dream-prototype-forgery", {
            reason: DREAM,
            heldStoreLock: Object.create(StoreLockToken.prototype) as StoreLockToken,
          }),
        ).toThrow(LOCKED);
        // A token cannot be constructed without the module-private mint.
        expect(() => new StoreLockToken(Symbol("store-lock-token-mint"), dbPath)).toThrow(
          TypeError,
        );

        const point = createSnapshot(vault, "manual-under-token", {
          reason: BRAIN_SNAPSHOT_REASON.manual,
          ...(heldStoreLock !== null ? { heldStoreLock } : {}),
        });
        expect(point.derived_store.included).toBe(true);
        return { runId: "manual-under-token", path: point.path };
      },
    });

    expect(res.derived_store.replaced).toBe(true);
    expect(seen).not.toBeNull();
    expect(seen!.storeTarget).toBe(dbPath);
    expect(seen!.token).toBeInstanceOf(StoreLockToken);
    expect(seen!.token!.path).toBe(dbPath);
    expect(markerTableExists()).toBe(false);
  });

  test("a token kept past the restore no longer skips the lock", () => {
    coverStoreByPolicy();
    snapshotThenDiverge();
    let kept: StoreLockToken | null = null;
    restoreSnapshot(vault, RUN_ID, {
      beforeDiscard: ({ heldStoreLock }) => {
        kept = heldStoreLock;
        const point = createSnapshot(vault, "manual-before-keep", {
          reason: BRAIN_SNAPSHOT_REASON.manual,
          ...(heldStoreLock !== null ? { heldStoreLock } : {}),
        });
        return { runId: "manual-before-keep", path: point.path };
      },
    });
    expect(kept).toBeInstanceOf(StoreLockToken);

    // Another writer holds the lock now; the released token must not
    // stand in for it.
    const release = acquireWriterLockSync(dbPath);
    try {
      expect(() =>
        createSnapshot(vault, "dream-released-token", { reason: DREAM, heldStoreLock: kept! }),
      ).toThrow(LOCKED);
    } finally {
      release();
    }
  });

  test("a token whose path getter is shadowed does not skip another store's lock", () => {
    const store = overrideStore();
    createSnapshot(vault, RUN_ID, { reason: DREAM, ...store });

    restoreSnapshot(vault, RUN_ID, {
      ...store,
      beforeDiscard: ({ heldStoreLock }) => {
        expect(heldStoreLock).not.toBeNull();
        // Redirect the genuine token to the configured store, which another
        // writer holds: the module reads the path it minted, not the getter.
        Object.defineProperty(heldStoreLock, "path", { value: dbPath });
        const release = acquireWriterLockSync(dbPath);
        try {
          expect(() =>
            createSnapshot(vault, "dream-shadowed-token", {
              reason: DREAM,
              derivedStore: COVERED,
              ...(heldStoreLock !== null ? { heldStoreLock } : {}),
            }),
          ).toThrow(LOCKED);
        } finally {
          release();
        }
        const point = createSnapshot(vault, "manual-shadow-point", {
          reason: BRAIN_SNAPSHOT_REASON.manual,
          ...store,
          ...(heldStoreLock !== null ? { heldStoreLock } : {}),
        });
        return { runId: "manual-shadow-point", path: point.path };
      },
    });
  });

  test("a live token on another store does not skip the lock of this one", () => {
    const store = overrideStore();
    createSnapshot(vault, RUN_ID, { reason: DREAM, ...store });
    addTable(store.derivedStorePath, "override_marker");

    restoreSnapshot(vault, RUN_ID, {
      ...store,
      beforeDiscard: ({ heldStoreLock }) => {
        expect(heldStoreLock?.path).toBe(store.derivedStorePath);
        // The configured store is held by another writer; the restore's
        // live token names the override store, so it does not count here.
        const release = acquireWriterLockSync(dbPath);
        try {
          expect(() =>
            createSnapshot(vault, "dream-other-store-token", {
              reason: DREAM,
              derivedStore: COVERED,
              ...(heldStoreLock !== null ? { heldStoreLock } : {}),
            }),
          ).toThrow(LOCKED);
        } finally {
          release();
        }
        const point = createSnapshot(vault, "manual-override-point", {
          reason: BRAIN_SNAPSHOT_REASON.manual,
          ...store,
          ...(heldStoreLock !== null ? { heldStoreLock } : {}),
        });
        return { runId: "manual-override-point", path: point.path };
      },
    });
    expect(tablesOf(store.derivedStorePath)).not.toContain("override_marker");
  });
});

/** The derived-store record a snapshot's manifest carries. */
function recordedStore(runId: string): { included: boolean; exclusion_reason: string | null } {
  const { derived_store } = JSON.parse(readFileSync(manifestSidecarPath(vault, runId), "utf8")) as {
    derived_store: { included: boolean; exclusion_reason: string | null };
  };
  return { included: derived_store.included, exclusion_reason: derived_store.exclusion_reason };
}

/** A copy of the configured store at `path`, as a `derivedStorePath` override. */
function storeAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const live = new Database(dbPath);
  live.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  live.close();
  return path;
}

describe("a derived store that lives inside Brain/", () => {
  test("directly under Brain/, it is restored by the store swap and kept out of the tree swap", () => {
    const brain = brainDirs(vault).brain;
    const derivedStorePath = storeAt(join(brain, "index.sqlite"));
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStorePath, derivedStore: COVERED });
    const archived = tablesOf(derivedStorePath);
    writeFileSync(join(brain, "post-snapshot-marker.md"), "# only in the live tree\n");
    addTable(derivedStorePath, "late_marker");

    const res = restoreSnapshotWithRecoveryPoint(vault, RUN_ID, { derivedStorePath });

    expect(res.derived_store.replaced).toBe(true);
    expect(tablesOf(derivedStorePath)).toEqual(archived);
    expect(existsSync(join(brain, "post-snapshot-marker.md"))).toBe(false);
    expect(readdirSync(brain).filter((e) => e.startsWith("index.sqlite.restore"))).toEqual([]);
    // The store family is not counted as restored Brain content.
    const restored = Object.keys(treeOf(brain)).filter(
      (p) =>
        !p.endsWith("/") &&
        !p.startsWith(".snapshots") &&
        !p.startsWith(BRAIN_ARTIFACTS_DIR) &&
        !p.startsWith("index.sqlite"),
    );
    expect(res.restored_files).toBe(restored.length);

    // The recovery point holds the store the restore discarded.
    restoreSnapshot(vault, res.recoveryPoint.runId, { derivedStorePath });
    expect(tablesOf(derivedStorePath)).toContain("late_marker");
  });

  test("directly under Brain/ and not covered, the Brain archive's copy is not restored over it", () => {
    const brain = brainDirs(vault).brain;
    const derivedStorePath = storeAt(join(brain, "index.sqlite"));
    // The Brain archive still holds a raw copy of the store as a top-level
    // entry; the store record says the store was left out.
    createSnapshot(vault, RUN_ID, {
      reason: DREAM,
      derivedStorePath,
      derivedStore: { include: false, maxBytes: COVERED.maxBytes },
    });
    addTable(derivedStorePath, "late_marker");
    const storeBefore = sha256Hex(readFileSync(derivedStorePath));

    const res = restoreSnapshot(vault, RUN_ID, { derivedStorePath });

    expect(res.derived_store.replaced).toBe(false);
    expect(sha256Hex(readFileSync(derivedStorePath))).toBe(storeBefore);
    expect(tablesOf(derivedStorePath)).toContain("late_marker");
  });

  test("directly under Brain/, entries that only share the store's name prefix are restored", () => {
    const brain = brainDirs(vault).brain;
    const derivedStorePath = storeAt(join(brain, "index.sqlite"));
    writeFileSync(join(brain, "index.sqlite-notes.md"), "# snapshot notes\n");
    mkdirSync(join(brain, "index.sqlite-assets"));
    writeFileSync(join(brain, "index.sqlite-assets", "a.md"), "# snapshot asset\n");
    writeFileSync(join(brain, "index.sqlite.notes.md"), "# only in the snapshot\n");
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStorePath, derivedStore: COVERED });
    writeFileSync(join(brain, "index.sqlite-notes.md"), "# changed after the snapshot\n");
    writeFileSync(join(brain, "index.sqlite-assets", "b.md"), "# added after the snapshot\n");
    rmSync(join(brain, "index.sqlite.notes.md"));

    const res = restoreSnapshot(vault, RUN_ID, { derivedStorePath });

    expect(readFileSync(join(brain, "index.sqlite-notes.md"), "utf8")).toBe("# snapshot notes\n");
    expect(readdirSync(join(brain, "index.sqlite-assets"))).toEqual(["a.md"]);
    expect(readFileSync(join(brain, "index.sqlite.notes.md"), "utf8")).toBe(
      "# only in the snapshot\n",
    );
    // They count as restored Brain content; the store's own files (the
    // store, its journals, the outgoing store parked at `.bak`) do not.
    const restored = Object.keys(treeOf(brain)).filter(
      (p) =>
        !p.endsWith("/") &&
        !p.startsWith(".snapshots") &&
        !p.startsWith(BRAIN_ARTIFACTS_DIR) &&
        !/^index\.sqlite(\.bak)?(-wal|-shm|-journal)?$/u.test(p),
    );
    expect(res.restored_files).toBe(restored.length);
  });

  test("a store path that is the Brain/ directory itself is refused before anything is touched", () => {
    const brain = brainDirs(vault).brain;
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStore: COVERED });
    writeFileSync(join(brain, "post-snapshot-marker.md"), "# only in the live tree\n");
    const brainBefore = treeOf(brain);
    const snapshotsBefore = readdirSync(brainDirs(vault).snapshots).toSorted();

    let threw: unknown = null;
    try {
      restoreSnapshotWithRecoveryPoint(vault, RUN_ID, { derivedStorePath: brain });
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(BrainSnapshotError);
    expect((threw as Error).message).toMatch(
      /the derived store path .+ is the Brain\/ directory itself; refusing before anything is touched/u,
    );
    expect(treeOf(brain)).toEqual(brainBefore);
    expect(readdirSync(brainDirs(vault).snapshots).toSorted()).toEqual(snapshotsBefore);
  });

  test("nested inside a Brain/ directory, the restore refuses before anything is touched", () => {
    const brain = brainDirs(vault).brain;
    const derivedStorePath = storeAt(join(brain, "data", "index.sqlite"));
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStorePath, derivedStore: COVERED });
    writeFileSync(join(brain, "post-snapshot-marker.md"), "# only in the live tree\n");
    addTable(derivedStorePath, "late_marker");
    const brainBefore = treeOf(brain);
    const snapshotsBefore = readdirSync(brainDirs(vault).snapshots).toSorted();

    let threw: unknown = null;
    try {
      restoreSnapshotWithRecoveryPoint(vault, RUN_ID, { derivedStorePath });
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(BrainSnapshotError);
    expect((threw as Error).message).toMatch(
      /the derived store .+ is inside Brain\/data, which a restore replaces as a whole; refusing before anything is touched/u,
    );
    expect(treeOf(brain)).toEqual(brainBefore);
    expect(readdirSync(brainDirs(vault).snapshots).toSorted()).toEqual(snapshotsBefore);
    expect(tablesOf(derivedStorePath)).toContain("late_marker");
  });
});

describe("the store family kept out of the tree swap is a closed list", () => {
  test("the store's own artifacts match; other names sharing its prefix do not", () => {
    const family = [
      "index.sqlite",
      "index.sqlite-wal",
      "index.sqlite-shm",
      "index.sqlite-journal",
      "index.sqlite.new",
      "index.sqlite.new-wal",
      "index.sqlite.bak",
      "index.sqlite.bak-shm",
      "index.sqlite.old",
      "index.sqlite.restore-4242-0a1b2c3d",
      "index.sqlite.restore-4242-0a1b2c3d-wal",
    ];
    for (const name of family)
      expect(isStoreFamilyEntry(name, "index.sqlite", false, "linux")).toBe(true);
    expect(isStoreFamilyEntry("index.sqlite.lock", "index.sqlite", true, "linux")).toBe(true);

    const content = [
      "index.sqlite-notes.md",
      "index.sqlite.notes.md",
      "index.sqlite.old-notes",
      "index.sqlite-wal-shm",
      "index.sqlite.restore-notes",
      "index.sqlite.lock",
      "index.sqlite.takeover",
      "index.sqlite.1234.tmp",
    ];
    for (const name of content) {
      expect(isStoreFamilyEntry(name, "index.sqlite", false, "linux")).toBe(false);
    }
    // Directories are family only as the writer lock.
    for (const name of ["index.sqlite", "index.sqlite-assets", "index.sqlite.bak"]) {
      expect(isStoreFamilyEntry(name, "index.sqlite", true, "linux")).toBe(false);
    }
  });

  test("names compare without case only where the platform folds case", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(isStoreFamilyEntry("index.sqlite-WAL", "Index.sqlite", false, platform)).toBe(true);
      expect(isStoreFamilyEntry("INDEX.SQLITE.LOCK", "index.sqlite", true, platform)).toBe(true);
      expect(isStoreFamilyEntry("index.SQLITE-notes.md", "Index.sqlite", false, platform)).toBe(
        false,
      );
    }
    expect(isStoreFamilyEntry("index.sqlite-wal", "Index.sqlite", false, "linux")).toBe(false);
  });

  test("an absent store takes the spelling of the entry beside it where case folds", () => {
    const brain = brainDirs(vault).brain;
    writeFileSync(join(brain, "index.sqlite"), "");
    const configured = join(brain, "Index.sqlite");

    // Both hold on any host: only the ancestors go through the native
    // realpath, and the last component is spelled by the platform the call
    // names, so a case-folding filesystem under the test does not rewrite
    // the `linux` answer to the on-disk `index.sqlite`.

    expect(storePlacement(brain, configured, "darwin")).toEqual({
      kind: "top",
      base: "index.sqlite",
    });
    expect(storePlacement(brain, configured, "linux")).toEqual({
      kind: "top",
      base: "Index.sqlite",
    });
  });

  test("Brain/ itself, an entry under it in another case, and paths outside are told apart", () => {
    const brain = brainDirs(vault).brain;
    const upper = join(dirname(brain), basename(brain).toUpperCase());

    expect(storePlacement(brain, brain, "linux")).toEqual({ kind: "brain" });
    expect(storePlacement(brain, upper, "darwin")).toEqual({ kind: "brain" });
    expect(storePlacement(brain, join(upper, "index.sqlite"), "darwin")).toEqual({
      kind: "top",
      base: "index.sqlite",
    });
    expect(storePlacement(brain, join(root, "index.sqlite"), "darwin")).toEqual({
      kind: "outside",
    });
  });

  // Skipped where the filesystem under the test folds case (NTFS, default
  // APFS): there `BRAIN` IS `Brain/`, and the native realpath answers with
  // the on-disk spelling whatever platform the call names, so the
  // case-sensitive comparison has two equal paths to compare. The
  // platform-independent cases above still run on those hosts.
  test.skipIf(filesystemFoldsCase(tmpdir()))(
    "on a case-sensitive filesystem, Brain/ in another case is another directory",
    () => {
      const brain = brainDirs(vault).brain;
      const upper = join(dirname(brain), basename(brain).toUpperCase());
      expect(storePlacement(brain, join(upper, "index.sqlite"), "linux")).toEqual({
        kind: "outside",
      });
    },
  );
});

/**
 * True when the filesystem under `dir` folds case, so `CASE-PROBE` names
 * the file created as `case-probe`.
 */
function filesystemFoldsCase(dir: string): boolean {
  const probeDir = mkdtempSync(join(dir, "o2b-case-probe-"));
  try {
    writeFileSync(join(probeDir, "case-probe"), "");
    return existsSync(join(probeDir, "CASE-PROBE"));
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

describe("the store target is one directory entry for the placement and the swap", () => {
  // Symlinks need elevated rights on Windows; the other suites building
  // symlink fixtures skip there for the same reason.
  test.skipIf(process.platform === "win32")(
    "a live Brain/index.sqlite linking to a database outside Brain/ is restored at the link",
    () => {
      const brain = brainDirs(vault).brain;
      const external = storeAt(join(root, "external", "index.sqlite"));
      // The snapshot predates the link: its store sat outside Brain/.
      createSnapshot(vault, RUN_ID, {
        reason: DREAM,
        derivedStorePath: external,
        derivedStore: COVERED,
      });
      const archived = tablesOf(external);
      addTable(external, "late_marker");
      const link = join(brain, "index.sqlite");
      symlinkSync(external, link);

      // The entry the swap renames is what is classified.
      expect(storePlacement(brain, link)).toEqual({ kind: "top", base: "index.sqlite" });
      // A link to Brain/ itself is still Brain/.
      symlinkSync(brain, join(root, "brain-link"));
      expect(storePlacement(brain, join(root, "brain-link"))).toEqual({ kind: "brain" });

      const res = restoreSnapshot(vault, RUN_ID, { derivedStorePath: link });

      expect(res.derived_store.replaced).toBe(true);
      // The restored database replaced the link; the link went aside with
      // the outgoing store's name, and the database it pointed to is as
      // it was.
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(tablesOf(link)).toEqual(archived);
      expect(readlinkSync(`${link}.bak`)).toBe(external);
      expect(tablesOf(external)).toContain("late_marker");
      expect(readdirSync(brain).filter((e) => e.startsWith("index.sqlite.restore"))).toEqual([]);
    },
  );
});

/**
 * {@link expectUntouched} without opening the store: SQLite would take a
 * stand-in journal beside it for a hot one and try to roll it back.
 */
function expectUntouchedOnDisk(fn: () => unknown, message: RegExp): void {
  const before = liveState();
  expect(refusal(fn)).toMatch(message);
  expect(liveState()).toEqual(before);
}

describe("the outgoing store's rollback journal moves with it", () => {
  /**
   * Stand-in for a hot rollback journal: the swap moves the file by name
   * and never reads it, so its bytes only need to be recognisable.
   */
  const HOT_JOURNAL = "hot rollback journal of the pre-restore store\n";

  test("a store outside Brain/: the journal does not stay beside the replacement", () => {
    snapshotThenDiverge();
    const journal = `${dbPath}-journal`;
    writeFileSync(journal, HOT_JOURNAL);

    restoreSnapshot(vault, RUN_ID);

    expect(markerTableExists()).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expect(readFileSync(`${dbPath}.bak-journal`, "utf8")).toBe(HOT_JOURNAL);
  });

  test("a store directly under Brain/: the journal does not stay beside the replacement", () => {
    const brain = brainDirs(vault).brain;
    const derivedStorePath = storeAt(join(brain, "index.sqlite"));
    createSnapshot(vault, RUN_ID, { reason: DREAM, derivedStorePath, derivedStore: COVERED });
    const archived = tablesOf(derivedStorePath);
    addTable(derivedStorePath, "late_marker");
    writeFileSync(`${derivedStorePath}-journal`, HOT_JOURNAL);

    restoreSnapshot(vault, RUN_ID, { derivedStorePath });

    expect(tablesOf(derivedStorePath)).toEqual(archived);
    expect(existsSync(`${derivedStorePath}-journal`)).toBe(false);
    expect(readFileSync(`${derivedStorePath}.bak-journal`, "utf8")).toBe(HOT_JOURNAL);
  });

  test("a journal with no live store beside it does not meet the replacement either", () => {
    snapshotThenDiverge();
    rmSync(dbPath);
    const journal = `${dbPath}-journal`;
    writeFileSync(journal, HOT_JOURNAL);

    restoreSnapshot(vault, RUN_ID);

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(journal)).toBe(false);
    expect(readFileSync(`${dbPath}.bak-journal`, "utf8")).toBe(HOT_JOURNAL);
  });

  test("an undo puts the journal back beside the pre-restore store", () => {
    snapshotThenDiverge();
    writeFileSync(`${dbPath}-journal`, HOT_JOURNAL);
    expectUntouchedOnDisk(
      () =>
        withFailingRename(
          (from, to) => to === dbPath && from.startsWith(`${dbPath}.restore-`),
          () => restoreSnapshot(vault, RUN_ID),
        ),
      /derived store swap failed.*as they were/u,
    );
    expect(readFileSync(`${dbPath}-journal`, "utf8")).toBe(HOT_JOURNAL);
    expect(existsSync(`${dbPath}.bak-journal`)).toBe(false);
  });

  test("a journal that cannot be moved aside undoes the whole restore", () => {
    snapshotThenDiverge();
    const journal = `${dbPath}-journal`;
    writeFileSync(journal, HOT_JOURNAL);
    expectUntouchedOnDisk(
      () =>
        withFailingRename(
          (from) => from === journal,
          () => restoreSnapshot(vault, RUN_ID),
        ),
      /could not move the rollback journal .*the restored store must not open beside it.*every Brain\/ rename was undone, so Brain\/ and the derived store are as they were/u,
    );
    expect(readFileSync(journal, "utf8")).toBe(HOT_JOURNAL);
  });

  test("a journal that cannot be put back is reported as a torn store, with Brain/ undone", () => {
    snapshotThenDiverge();
    const journal = `${dbPath}-journal`;
    const outgoingJournal = `${dbPath}.bak-journal`;
    writeFileSync(journal, HOT_JOURNAL);
    const before = liveState();
    const message = refusal(() =>
      withFailingRename(
        (from, to) =>
          (to === dbPath && from.startsWith(`${dbPath}.restore-`)) ||
          (from === outgoingJournal && to === journal),
        () => restoreSnapshot(vault, RUN_ID),
      ),
    );
    expect(message).toMatch(
      /the rollback journal of the pre-restore store could not be renamed back/u,
    );
    expect(message).toContain(`is at ${outgoingJournal}`);
    expect(message).toMatch(
      /Brain\/ is as it was before the restore, but the derived store is not/u,
    );
    expect(treeOf(brainDirs(vault).brain)).toEqual(before.brain);
    expect(readFileSync(outgoingJournal, "utf8")).toBe(HOT_JOURNAL);
    expect(sha256Hex(readFileSync(`${dbPath}.bak`))).toBe(before.store);
  });
});
