/**
 * U7: `o2b brain snapshot log`.
 *
 * The snapshot family already had a diff and a revert (`snapshot diff`,
 * `rollback`); what it had no surface for was the LIST - so an operator
 * could not ask which recovery point covers a given boundary without
 * reading filenames out of `.snapshots/`. This file pins that surface:
 * newest-first ordering, the reason column, the reason filter, the usage
 * exit on an unregistered filter value, the limit, and the honest
 * zero-exit on a vault that has taken no snapshots at all.
 *
 * The snapshots are built through the core engine rather than by running
 * `brain dream` three times: the ordering assertions need controlled
 * mtimes and distinct reasons, and a dream run can only ever produce one
 * of the nine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { createSnapshot } from "../../src/core/brain/snapshot.ts";
import { manifestSidecarPath } from "../../src/core/brain/manifest.ts";
import { brainDirs, snapshotPath } from "../../src/core/brain/paths.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-snaplog-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  atomicWriteFileSync(config, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: config });
  writeFileSync(
    join(brainDirs(vault).preferences, "pref-seed.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nseed\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the verb with this test's sandboxed config. */
async function snapshotLog(...args: string[]): ReturnType<typeof runCli> {
  return await runCli(["brain", "snapshot", "log", "--vault", vault, ...args], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
}

/**
 * Three recovery points with distinct reasons and deliberately-ordered
 * mtimes, so "newest first" is a real assertion rather than an artefact of
 * creation order. The listing sorts by mtime because a hand-named run id
 * carries no timestamp to sort on.
 */
const SEEDED = Object.freeze([
  { runId: "dream-oldest", reason: BRAIN_SNAPSHOT_REASON.dream, minutes: 30 },
  { runId: "entity-prune-middle", reason: BRAIN_SNAPSHOT_REASON.entityPrune, minutes: 20 },
  { runId: "dream-newest", reason: BRAIN_SNAPSHOT_REASON.dream, minutes: 10 },
]);

function seedSnapshots(): void {
  const now = Date.now();
  for (const s of SEEDED) {
    createSnapshot(vault, s.runId, { reason: s.reason });
    const when = new Date(now - s.minutes * 60_000);
    utimesSync(snapshotPath(vault, s.runId), when, when);
  }
}

describe("brain snapshot log", () => {
  test("lists newest first with the reason of each recovery point", async () => {
    seedSnapshots();
    const r = await snapshotLog();
    expect(r.returncode).toBe(0);
    const rows = r.stdout.trimEnd().split("\n");
    // A header line, then one row per snapshot in mtime-descending order.
    expect(rows[0]).toContain("run_id");
    expect(rows[0]).toContain("reason");
    expect(rows.slice(1).map((line) => line.split("\t")[0])).toEqual([
      "dream-newest",
      "entity-prune-middle",
      "dream-oldest",
    ]);
    expect(rows[1]).toContain(BRAIN_SNAPSHOT_REASON.dream);
    expect(rows[2]).toContain(BRAIN_SNAPSHOT_REASON.entityPrune);
  });

  test("--json carries the reason, the manifest and the derived-store record", async () => {
    seedSnapshots();
    const r = await snapshotLog("--json");
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      total: number;
      snapshots: ReadonlyArray<{
        run_id: string;
        reason: string | null;
        manifest: boolean;
        derived_store: unknown;
        size_bytes: number;
        created_at: string;
      }>;
    };
    expect(payload.total).toBe(3);
    expect(payload.snapshots.map((s) => s.run_id)).toEqual([
      "dream-newest",
      "entity-prune-middle",
      "dream-oldest",
    ]);
    expect(payload.snapshots[0]!.reason).toBe(BRAIN_SNAPSHOT_REASON.dream);
    expect(payload.snapshots[0]!.manifest).toBe(true);
    expect(payload.snapshots[0]!.size_bytes).toBeGreaterThan(0);
    expect(payload.snapshots[0]!.derived_store).not.toBeNull();
  });

  test("--reason filters the revertible history by why it happened", async () => {
    seedSnapshots();
    const r = await snapshotLog("--reason", BRAIN_SNAPSHOT_REASON.dream, "--json");
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      total: number;
      snapshots: ReadonlyArray<{ run_id: string }>;
    };
    expect(payload.snapshots.map((s) => s.run_id)).toEqual(["dream-newest", "dream-oldest"]);
    expect(payload.total).toBe(2);
  });

  test("a reason that matches nothing exits zero with an empty listing", async () => {
    seedSnapshots();
    const r = await snapshotLog("--reason", BRAIN_SNAPSHOT_REASON.manual);
    // Nothing found is not a failure: the question was answerable and the
    // answer is none.
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no snapshots");
  });

  test("an unregistered reason is a usage error, not an empty result", async () => {
    seedSnapshots();
    const r = await snapshotLog("--reason", "spring-cleaning");
    // Exit 2 and a named cause, matching how `brain event-trace` rejects a
    // bad --kind. Returning an empty listing would tell the operator their
    // vault has no such snapshots when in fact their filter was invalid.
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("spring-cleaning");
  });

  test("--limit honours a positive integer and rejects anything else", async () => {
    seedSnapshots();
    const limited = await snapshotLog("--limit", "2", "--json");
    expect(limited.returncode).toBe(0);
    const payload = JSON.parse(limited.stdout) as { snapshots: ReadonlyArray<{ run_id: string }> };
    expect(payload.snapshots.map((s) => s.run_id)).toEqual(["dream-newest", "entity-prune-middle"]);

    const zero = await snapshotLog("--limit", "0");
    expect(zero.returncode).toBe(2);
    const words = await snapshotLog("--limit", "many");
    expect(words.returncode).toBe(2);
  });

  test("an empty snapshots directory exits zero", async () => {
    const r = await snapshotLog();
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no snapshots");
  });

  test("an empty snapshots directory exits zero under --json too", async () => {
    const r = await snapshotLog("--json");
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ total: 0, snapshots: [] });
  });

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "a snapshots directory it cannot read is a failure, not an empty history",
    async () => {
      seedSnapshots();
      const snapshots = brainDirs(vault).snapshots;
      chmodSync(snapshots, 0o000);
      try {
        const r = await snapshotLog();
        // "no snapshots available" over a directory nobody could read is
        // the exact confusion this release exists to remove.
        expect(r.returncode).not.toBe(0);
        expect(r.stdout).not.toContain("no snapshots");
        expect(r.stderr).toContain(snapshots);
      } finally {
        chmodSync(snapshots, 0o755);
      }
    },
  );

  test("a snapshot with no sidecar reports an unknown reason, not its run-id prefix", async () => {
    createSnapshot(vault, "dream-unstamped", { reason: BRAIN_SNAPSHOT_REASON.dream });
    rmSync(manifestSidecarPath(vault, "dream-unstamped"), { force: true });
    const r = await snapshotLog("--json");
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      snapshots: ReadonlyArray<{ reason: string | null; manifest: boolean }>;
    };
    expect(payload.snapshots[0]!.reason).toBeNull();
    expect(payload.snapshots[0]!.manifest).toBe(false);
    const text = await snapshotLog();
    expect(text.stdout).toContain("unknown");
  });

  test("the subcommand is offered by the snapshot help", async () => {
    const r = await runCli(["brain", "snapshot", "--help", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("log");
    expect(r.stdout).toContain("diff");
  });
});

describe("brain rollback --list carries the reason", () => {
  test("the text listing gains a reason column", async () => {
    seedSnapshots();
    const r = await runCli(["brain", "rollback", "--list", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const rows = r.stdout.trimEnd().split("\n");
    expect(rows[0]!.split("\t")).toEqual([
      "run_id",
      "created_at",
      "reason",
      "size_bytes",
      "derived_store",
    ]);
    // Column 2 (zero-based) is the reason, read off the sidecar.
    expect(rows[1]!.split("\t")[2]).toBe(BRAIN_SNAPSHOT_REASON.dream);
    expect(rows[2]!.split("\t")[2]).toBe(BRAIN_SNAPSHOT_REASON.entityPrune);
  });

  test("--list --json carries the reason on every entry", async () => {
    seedSnapshots();
    const r = await runCli(["brain", "rollback", "--list", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const snaps = JSON.parse(r.stdout) as ReadonlyArray<{ run_id: string; reason: string | null }>;
    expect(snaps.map((s) => s.reason)).toEqual([
      BRAIN_SNAPSHOT_REASON.dream,
      BRAIN_SNAPSHOT_REASON.entityPrune,
      BRAIN_SNAPSHOT_REASON.dream,
    ]);
  });

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "an unreadable snapshots directory is reported, not listed as empty",
    async () => {
      seedSnapshots();
      const snapshots = brainDirs(vault).snapshots;
      chmodSync(snapshots, 0o000);
      try {
        const r = await runCli(["brain", "rollback", "--list", "--vault", vault], {
          env: { OPEN_SECOND_BRAIN_CONFIG: config },
        });
        expect(r.returncode).not.toBe(0);
        expect(r.stdout).not.toContain("no snapshots available");
        expect(r.stderr).toContain(snapshots);
      } finally {
        chmodSync(snapshots, 0o755);
      }
    },
  );

  test("an unstamped snapshot lists as unknown rather than as its prefix", async () => {
    createSnapshot(vault, "dream-unstamped", { reason: BRAIN_SNAPSHOT_REASON.dream });
    rmSync(manifestSidecarPath(vault, "dream-unstamped"), { force: true });
    const r = await runCli(["brain", "rollback", "--list", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")[1]!.split("\t")[2]).toBe("unknown");
  });
});
