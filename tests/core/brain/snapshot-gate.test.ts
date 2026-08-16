/**
 * D1 (t_7965b04b): snapshot-before-destructive-write gate.
 *
 * `withDestructiveSnapshot(vault, reason, op)` is the thin wrapper that
 * guarantees no destructive brain mutation runs without a recovery
 * point on disk first. The contract:
 *
 *   - it mints a valid, unique run id of the shape `<reason>-<stamp>`;
 *   - it calls `takeSnapshot` BEFORE `op`, so a snapshot failure
 *     aborts the operation (the destructive work never runs);
 *   - if `op` throws, the error propagates but the snapshot stays put
 *     (that IS the recovery point);
 *   - retention is enforced around the recovery point it just wrote.
 *
 * U7 adds one structural assertion to that list: the standalone
 * `takeSnapshot` entry point and the wrapper must produce byte-identical
 * archives for the same input, because the wrapper delegates to it rather
 * than carrying a second copy of the snapshot path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUniqueSnapshot,
  takeSnapshot,
  withDestructiveSnapshot,
} from "../../../src/core/brain/snapshot-gate.ts";
import {
  BrainSnapshotError,
  BrainSnapshotStoreError,
  listSnapshots,
} from "../../../src/core/brain/snapshot.ts";
import { createSnapshot } from "../../../src/core/brain/snapshot.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { isFileAlreadyExists } from "../../../src/core/fs-atomic.ts";
import { brainDirs, snapshotPath, validateRunId } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { FileAlreadyExistsError, atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-gate-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-gate-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });

  const dirs = brainDirs(vault);
  writeFileSync(
    join(dirs.inbox, "sig-2026-05-14-foo.md"),
    "---\nkind: brain-signal\n---\n\n## Raw\n\nseed\n",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("withDestructiveSnapshot", () => {
  test("mints a valid run id and snapshots before running op", () => {
    let archiveCountWhenOpRan = -1;
    const out = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.deleteBySource,
      () => {
        // The snapshot archive must already exist by the time op runs.
        archiveCountWhenOpRan = listSnapshots(vault).snapshots.length;
        return "result-value";
      },
      { now: new Date("2026-06-01T00:00:00Z") },
    );
    expect(out.result).toBe("result-value");
    expect(out.snapshot.runId).toMatch(/^delete-by-source-/);
    // The minted id is a valid filesystem-safe run id.
    expect(() => validateRunId(out.snapshot.runId)).not.toThrow();
    expect(existsSync(out.snapshot.path)).toBe(true);
    expect(archiveCountWhenOpRan).toBe(1);
  });

  test("op runs after the snapshot exists (order proven)", () => {
    let order: string[] = [];
    const before = listSnapshots(vault).snapshots.length;
    withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.entityPrune, () => {
      order.push(`snapshots=${listSnapshots(vault).snapshots.length}`);
    });
    expect(order).toEqual([`snapshots=${before + 1}`]);
  });

  test("aborts the operation when the snapshot cannot be created", () => {
    // Force createSnapshot to fail by making `tar` unfindable: point PATH
    // at an empty dir so tooling detection reports tar missing.
    const emptyDir = mkdtempSync(join(tmpdir(), "o2b-empty-path-"));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    let opRan = false;
    try {
      expect(() =>
        withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => {
          opRan = true;
        }),
      ).toThrow();
      expect(opRan).toBe(false);
    } finally {
      process.env["PATH"] = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("aborts the operation when derived-store coverage cannot be honoured", () => {
    // Coverage on, and no derived store in this vault. `createSnapshot`
    // refuses rather than downgrading to a snapshot that omits what it
    // was asked to protect - and because the gate snapshots FIRST, the
    // destructive operation simply never runs. No new plumbing: the
    // property follows from refusing in the right place.
    const brainYaml = join(brainDirs(vault).brain, "_brain.yaml");
    atomicWriteFileSync(
      brainYaml,
      "schema_version: 1\nsnapshots:\n  include_derived_store: true\n",
    );
    let opRan = false;
    expect(() =>
      withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => {
        opRan = true;
      }),
    ).toThrow(BrainSnapshotStoreError);
    expect(opRan).toBe(false);
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
  });

  test("op error propagates but the snapshot is retained as recovery point", () => {
    const before = listSnapshots(vault).snapshots.length;
    expect(() =>
      withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => {
        throw new Error("op blew up");
      }),
    ).toThrow("op blew up");
    // The snapshot survives - it is the recovery point.
    expect(listSnapshots(vault).snapshots.length).toBe(before + 1);
  });

  test("prunes to the configured retention after a successful op", () => {
    // Retention default is 10; write config with retention_count: 2.
    const brainYaml = join(brainDirs(vault).brain, "_brain.yaml");
    atomicWriteFileSync(brainYaml, "schema_version: 1\nsnapshots:\n  retention_count: 2\n");

    // Create three snapshots through the gate; only the two newest survive.
    for (let i = 0; i < 3; i++) {
      withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => undefined, {
        now: new Date(`2026-06-0${i + 1}T00:00:00Z`),
      });
    }
    expect(listSnapshots(vault).snapshots.length).toBe(2);
  });

  test("mints unique run ids when the base id already exists", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const a = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.deleteBySource,
      () => undefined,
      { now },
    );
    const b = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.deleteBySource,
      () => undefined,
      { now },
    );
    expect(a.snapshot.runId).not.toBe(b.snapshot.runId);
    expect(b.snapshot.runId).toBe(`${a.snapshot.runId}-2`);
  });

  test("the minted snapshot archive contains the seeded Brain content", () => {
    const out = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.deleteBySource,
      () => undefined,
    );
    // Extract and confirm the seeded signal is present.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-gate-verify-"));
    try {
      const zstd = spawnSync("zstd", ["-d", "-c", out.snapshot.path], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(zstd.status).toBe(0);
      const tar = spawnSync("tar", ["-x", "-C", tmp], {
        input: zstd.stdout,
        stdio: ["pipe", "inherit", "pipe"],
      });
      expect(tar.status).toBe(0);
      expect(existsSync(join(tmp, "Brain", "inbox", "sig-2026-05-14-foo.md"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("stamps the reason it was given into the snapshot's sidecar", () => {
    const out = withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.entityPrune, () => undefined);
    const listed = listSnapshots(vault).snapshots.find((s) => s.run_id === out.snapshot.runId);
    expect(listed?.reason).toBe(BRAIN_SNAPSHOT_REASON.entityPrune);
  });
});

/**
 * U7: the extraction must not have forked the snapshot path.
 *
 * `takeSnapshot` exists so a caller that wants a recovery point WITHOUT
 * an operation behind it has somewhere to go other than a second copy of
 * the id-minting and archiving logic. The proof that it is not a second
 * copy is that the wrapper's archive and its own are byte-identical over
 * the same tree.
 *
 * The comparison runs over two vaults rather than two snapshots of one,
 * because a snapshot appends its own log event into `Brain/log/` - so a
 * second archive of the SAME vault legitimately differs, and comparing
 * them would prove nothing about the code path. Both trees are stamped to
 * one fixed mtime first: tar records per-entry mtimes, and the copy's are
 * otherwise the moment it was made.
 */
describe("takeSnapshot and withDestructiveSnapshot share one archive path", () => {
  /** Stamp every entry under `root` to one instant, deepest-last. */
  function stampTree(root: string, when: Date): void {
    const stack = [root];
    const seen: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      seen.push(dir);
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) stack.push(abs);
        else utimesSync(abs, when, when);
      }
    }
    // Directories last: touching a child rewrites its parent's mtime.
    for (const dir of seen.toReversed()) utimesSync(dir, when, when);
  }

  test("both entry points produce byte-identical archives for the same input", () => {
    const twin = mkdtempSync(join(tmpdir(), "o2b-snap-gate-twin-"));
    try {
      // Copy BEFORE either vault has a `.snapshots/` directory, so the two
      // trees under `Brain/` are identical in content and in structure.
      cpSync(join(vault, "Brain"), join(twin, "Brain"), { recursive: true });
      const fixed = new Date("2026-06-01T00:00:00Z");
      stampTree(join(vault, "Brain"), fixed);
      stampTree(join(twin, "Brain"), fixed);

      const viaEntryPoint = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual, { now: fixed });
      const viaWrapper = withDestructiveSnapshot(
        twin,
        BRAIN_SNAPSHOT_REASON.manual,
        () => undefined,
        { now: fixed },
      );

      // Same minting rule, so the same id from the same reason and clock.
      expect(viaWrapper.snapshot.runId).toBe(viaEntryPoint.runId);
      expect(readFileSync(viaWrapper.snapshot.path)).toEqual(readFileSync(viaEntryPoint.path));
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
  });

  test("the standalone entry point requires a reason and records it", () => {
    const snap = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual);
    expect(snap.runId).toMatch(/^manual-/);
    expect(existsSync(snap.path)).toBe(true);
    expect(listSnapshots(vault).snapshots.find((s) => s.run_id === snap.runId)?.reason).toBe(
      BRAIN_SNAPSHOT_REASON.manual,
    );
  });

  test("the standalone entry point refuses when the snapshot cannot be created", () => {
    // Same refusal as the wrapper's: an entry point that returned a
    // plausible-looking result on a host without tar would hand back a
    // recovery point that does not exist.
    const emptyDir = mkdtempSync(join(tmpdir(), "o2b-empty-path-take-"));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    try {
      expect(() => takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual)).toThrow();
      expect(listSnapshots(vault).snapshots).toHaveLength(0);
    } finally {
      process.env["PATH"] = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("createUniqueSnapshot - the retry discriminator", () => {
  /**
   * The injected-creator tests below replay a collision with a synthetic
   * typed error, which proves the LOOP but not the WIRE: they would keep
   * passing if the real creator stopped producing a recognisable collision,
   * and a snapshot gate that cannot recognise one aborts the destructive
   * operation it exists to protect instead of laddering past a taken name.
   * So this one drives the real `createSnapshot` against an archive a peer
   * already wrote.
   */
  test("the real creator's collision is recognisable to the discriminator", () => {
    // The injected tests below prove the LOOP. This proves the WIRE: they
    // would keep passing if `createSnapshot` stopped producing an error the
    // discriminator recognises, and a gate that cannot recognise one aborts
    // the destructive operation it exists to protect rather than laddering
    // past a taken name.
    const taken = "dream-2026-06-01-120000";
    atomicWriteFileSync(snapshotPath(vault, taken), "a peer got here first");
    let thrown: unknown;
    try {
      createSnapshot(vault, taken, { reason: "dream" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(isFileAlreadyExists(thrown)).toBe(true);
  });

  test("ladders past a name a peer takes after the availability probe", () => {
    // The gate's own probe skips a name already on disk, so the only way to
    // reach the creator's collision is to let the peer win in the window the
    // probe cannot see: the callback writes the winner's archive and then
    // runs the REAL creator against it.
    const base = "dream-2026-06-01-130000";
    const calls: string[] = [];
    const snapshot = createUniqueSnapshot(vault, base, (runId) => {
      calls.push(runId);
      if (calls.length === 1) {
        atomicWriteFileSync(snapshotPath(vault, runId), "a peer got here first");
      }
      return createSnapshot(vault, runId, { reason: "dream" }).path;
    });

    expect(calls).toEqual([base, `${base}-2`]);
    expect(snapshot.runId).toBe(`${base}-2`);
    expect(readFileSync(snapshotPath(vault, base), "utf8")).toBe("a peer got here first");
    expect(existsSync(snapshot.path)).toBe(true);
  });

  test("retries the next run id on a typed collision", () => {
    const calls: string[] = [];
    const snapshot = createUniqueSnapshot(vault, "dream-2026-06-01-000000", (runId) => {
      calls.push(runId);
      const path = snapshotPath(vault, runId);
      if (calls.length === 1) {
        atomicWriteFileSync(path, "winner");
        throw new FileAlreadyExistsError(path);
      }
      atomicWriteFileSync(path, "loser");
      return path;
    });

    expect(calls).toEqual(["dream-2026-06-01-000000", "dream-2026-06-01-000000-2"]);
    expect(snapshot.runId).toBe("dream-2026-06-01-000000-2");
    expect(snapshot.path).toBe(snapshotPath(vault, "dream-2026-06-01-000000-2"));
  });

  test("an unrelated failure propagates even when the archive path exists", () => {
    // The defect this replaces: the retry used to be discriminated by
    // re-running `existsSync` AFTER the throw, so a real failure that
    // left bytes behind (a compressor that died part-way through its
    // output) was read as a collision, retried, and finally reported as
    // an id-exhaustion that named neither the failure nor its cause.
    const real = new Error("zstd exited with status 1: No space left on device");
    const calls: string[] = [];
    expect(() =>
      createUniqueSnapshot(vault, "dream-2026-06-01-000000", (runId) => {
        calls.push(runId);
        atomicWriteFileSync(snapshotPath(vault, runId), "partial");
        throw real;
      }),
    ).toThrow(real);
    expect(calls).toHaveLength(1);
  });

  test("exhausts a bounded number of ids and says so", () => {
    let calls = 0;
    let thrown: unknown;
    try {
      createUniqueSnapshot(
        vault,
        "dream-2026-06-01-000000",
        (runId) => {
          calls += 1;
          throw new FileAlreadyExistsError(snapshotPath(vault, runId));
        },
        3,
      );
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(3);
    expect((thrown as Error).message).toMatch(/could not reserve a unique snapshot run id/);
    expect((thrown as Error).message).toMatch(/after 3 attempts/);
    expect((thrown as Error).cause).toBeInstanceOf(FileAlreadyExistsError);
  });

  test("an EEXIST naming some other path propagates on the first attempt", () => {
    // GitHub #167. The discriminator used to be the errno alone, so ANY
    // EEXIST anywhere in the cause chain read as "a peer took this run id" -
    // including the one `createSnapshot` raises before it has touched a
    // single archive, when `mkdir Brain/.snapshots` fails. The ladder then
    // burned all 64 candidates and reported an id exhaustion that had never
    // happened, with the real errno buried on `cause`. A collision that does
    // not name THIS candidate's archive is not this loop's business.
    const calls: string[] = [];
    const unrelated = new Error(
      "EEXIST: file already exists, mkdir '/somewhere/entirely/else'",
    ) as NodeJS.ErrnoException;
    unrelated.code = "EEXIST";
    unrelated.path = "/somewhere/entirely/else";

    expect(() =>
      createUniqueSnapshot(vault, "dream-2026-06-01-000000", (runId) => {
        calls.push(runId);
        throw unrelated;
      }),
    ).toThrow(unrelated);
    expect(calls).toEqual(["dream-2026-06-01-000000"]);
  });
});

describe("an unusable Brain/.snapshots is diagnosed, not laddered past", () => {
  /**
   * The reproduction from GitHub #167, driven end to end on the two layers
   * that both got it wrong: `createSnapshot`, which raised a bare errno from
   * its very first `mkdir` and named nothing an operator could act on, and
   * the gate above it, which read that errno as a lost race.
   */
  const replaceSnapshotsDirWithFile = (): string => {
    const path = brainDirs(vault).snapshots;
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, "not a directory\n");
    return path;
  };

  test("createSnapshot names the archive directory and what is really there", () => {
    const path = replaceSnapshotsDirWithFile();
    let thrown: unknown;
    try {
      createSnapshot(vault, "dream-2026-06-01-000000", { reason: "dream" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BrainSnapshotError);
    expect((thrown as Error).message).toContain(path);
    expect((thrown as Error).message).toContain("regular file");
    // The errno is kept, not replaced: the diagnosis explains it, and a
    // reader who wants the syscall still has it.
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("dream reports the archive directory, not a fictional id exhaustion", () => {
    const path = replaceSnapshotsDirWithFile();
    let thrown: unknown;
    try {
      dream(vault, { now: new Date("2026-05-27T12:00:00Z") });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain(path);
    expect((thrown as Error).message).not.toMatch(/could not reserve a unique snapshot run id/);
  });
});
