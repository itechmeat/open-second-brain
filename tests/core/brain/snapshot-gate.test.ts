/**
 * D1 (t_7965b04b): snapshot-before-destructive-write gate.
 *
 * `withDestructiveSnapshot(vault, label, op)` is the thin wrapper that
 * guarantees no destructive brain mutation runs without a recovery
 * point on disk first. The contract:
 *
 *   - it mints a valid, unique run id of the shape `<label>-<stamp>`;
 *   - it calls `createSnapshot` BEFORE `op`, so a snapshot failure
 *     aborts the operation (the destructive work never runs);
 *   - if `op` throws, the error propagates but the snapshot stays put
 *     (that IS the recovery point);
 *   - after a successful `op` it prunes to the configured retention.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withDestructiveSnapshot } from "../../../src/core/brain/snapshot-gate.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { brainDirs, validateRunId } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
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
      "delete-by-source",
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
    withDestructiveSnapshot(vault, "prune-entities", () => {
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
        withDestructiveSnapshot(vault, "delete-by-source", () => {
          opRan = true;
        }),
      ).toThrow();
      expect(opRan).toBe(false);
    } finally {
      process.env["PATH"] = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("op error propagates but the snapshot is retained as recovery point", () => {
    const before = listSnapshots(vault).length;
    expect(() =>
      withDestructiveSnapshot(vault, "delete-by-source", () => {
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
      withDestructiveSnapshot(vault, "delete-by-source", () => undefined, {
        now: new Date(`2026-06-0${i + 1}T00:00:00Z`),
      });
    }
    expect(listSnapshots(vault).length).toBe(2);
  });

  test("mints unique run ids when the base id already exists", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const a = withDestructiveSnapshot(vault, "delete-by-source", () => undefined, { now });
    const b = withDestructiveSnapshot(vault, "delete-by-source", () => undefined, { now });
    expect(a.snapshot.runId).not.toBe(b.snapshot.runId);
    expect(b.snapshot.runId).toBe(`${a.snapshot.runId}-2`);
  });

  test("the minted snapshot archive contains the seeded Brain content", () => {
    const out = withDestructiveSnapshot(vault, "delete-by-source", () => undefined);
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
});
