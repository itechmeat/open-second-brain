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

import { takeSnapshot, withDestructiveSnapshot } from "../../../src/core/brain/snapshot-gate.ts";
import { BrainSnapshotStoreError, listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { brainDirs, validateRunId } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

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
        archiveCountWhenOpRan = listSnapshots(vault).length;
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
    const before = listSnapshots(vault).length;
    withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.entityPrune, () => {
      order.push(`snapshots=${listSnapshots(vault).length}`);
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
    expect(listSnapshots(vault)).toHaveLength(0);
  });

  test("op error propagates but the snapshot is retained as recovery point", () => {
    const before = listSnapshots(vault).length;
    expect(() =>
      withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => {
        throw new Error("op blew up");
      }),
    ).toThrow("op blew up");
    // The snapshot survives - it is the recovery point.
    expect(listSnapshots(vault).length).toBe(before + 1);
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
    expect(listSnapshots(vault).length).toBe(2);
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
    const listed = listSnapshots(vault).find((s) => s.run_id === out.snapshot.runId);
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
    expect(listSnapshots(vault).find((s) => s.run_id === snap.runId)?.reason).toBe(
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
      expect(listSnapshots(vault)).toHaveLength(0);
    } finally {
      process.env["PATH"] = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
