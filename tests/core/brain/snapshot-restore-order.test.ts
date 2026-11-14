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

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  restoreSnapshot,
  SNAPSHOT_TOOL_TIMEOUT_ENV,
} from "../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
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
});

/** A {@link treeOf} result without the entries a restore never touches. */
function withoutExcluded(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).filter(
      ([p]) => !p.startsWith(".snapshots") && !p.startsWith(BRAIN_ARTIFACTS_DIR),
    ),
  );
}
