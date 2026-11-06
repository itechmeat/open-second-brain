/**
 * Snapshot retention for every reason, ordered by manifest time.
 *
 * Two defects found on a live install (911 upgrade archives, 1.7 GB):
 *
 *   - `applyUpgrade` took its pre-apply snapshot straight through
 *     `createSnapshot` and never pruned, so upgrade archives escaped
 *     `snapshots.retention_count` entirely.
 *   - Retention ordered archives by file mtime, which `rsync -t`,
 *     `cp -p` or a stepped clock can make lie. The creation time the
 *     manifest sidecar records is the order that matters.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { manifestSidecarPath } from "../../../src/core/brain/manifest.ts";
import { brainConfigPath, brainManualPath, snapshotPath } from "../../../src/core/brain/paths.ts";
import { createSnapshot, listSnapshots, pruneSnapshots } from "../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
import { promoteHostMemory } from "../../../src/core/brain/continuity/promote-host-memory.ts";
import { recordHostMemoryWrite } from "../../../src/core/brain/host-memory-write.ts";
import { applyUpgrade } from "../../../src/core/brain/upgrade.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-snap-retention-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setRetention(count: number): void {
  const path = brainConfigPath(vault);
  const body = readFileSync(path, "utf8").replace(
    /retention_count: \d+/,
    `retention_count: ${count}`,
  );
  atomicWriteFileSync(path, body);
}

/**
 * Plant an archive whose manifest records `createdAt` while its file
 * mtime claims `mtime`: the shape a copied or clock-skewed archive has.
 */
function plantArchive(runId: string, createdAt: string, mtime: string): void {
  createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.upgrade });
  const sidecar = manifestSidecarPath(vault, runId);
  const manifest = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
  manifest["generated_at"] = createdAt;
  writeFileSync(sidecar, JSON.stringify(manifest));
  const when = new Date(mtime);
  utimesSync(snapshotPath(vault, runId), when, when);
}

function runIds(): string[] {
  return listSnapshots(vault).snapshots.map((s) => s.run_id);
}

describe("snapshot retention order", () => {
  test("archives are listed newest-first by manifest creation time, not mtime", () => {
    // Manifest order a < b < c; mtimes claim the reverse.
    plantArchive("upgrade-a", "2026-01-01T00:00:00Z", "2026-12-03T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-12-02T00:00:00Z");
    plantArchive("upgrade-c", "2026-01-03T00:00:00Z", "2026-12-01T00:00:00Z");

    expect(runIds()).toEqual(["upgrade-c", "upgrade-b", "upgrade-a"]);
  });

  test("prune removes the oldest by manifest time even when mtimes say otherwise", () => {
    plantArchive("upgrade-a", "2026-01-01T00:00:00Z", "2026-12-03T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-12-02T00:00:00Z");
    plantArchive("upgrade-c", "2026-01-03T00:00:00Z", "2026-12-01T00:00:00Z");

    const res = pruneSnapshots(vault, 1);

    expect(res.refusal).toBeNull();
    expect(runIds()).toEqual(["upgrade-c"]);
  });

  test("an archive without a readable sidecar is ordered by its mtime", () => {
    plantArchive("upgrade-a", "2026-01-03T00:00:00Z", "2026-01-01T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    // Without its sidecar, a's manifest time (newest) is gone: its mtime (oldest) counts.
    unlinkSync(manifestSidecarPath(vault, "upgrade-a"));

    expect(runIds()).toEqual(["upgrade-b", "upgrade-a"]);
  });

  test("an unparseable generated_at falls back to the mtime instead of sorting as NaN", () => {
    plantArchive("upgrade-a", "garbage", "2026-01-01T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    plantArchive("upgrade-c", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z");

    expect(runIds()).toEqual(["upgrade-c", "upgrade-b", "upgrade-a"]);
  });

  test("archives taken in the same second are ordered by mtime, then by run id", () => {
    plantArchive("upgrade-a", "2026-01-02T00:00:00Z", "2026-01-02T00:00:05Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-01-02T00:00:01Z");
    plantArchive("upgrade-c", "2026-01-02T00:00:00Z", "2026-01-02T00:00:01Z");

    expect(runIds()).toEqual(["upgrade-a", "upgrade-c", "upgrade-b"]);
  });

  test("a protected run id survives even when it is the oldest", () => {
    plantArchive("upgrade-a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    plantArchive("upgrade-c", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z");

    pruneSnapshots(vault, 1, { protectRunIds: ["upgrade-a"] });

    expect(runIds()).toEqual(["upgrade-a"]);
  });
});

describe("a sidecar stamp that cannot be right", () => {
  test("a far-future generated_at does not pin its archive as the newest", () => {
    plantArchive("upgrade-a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    plantArchive("upgrade-b", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    // A broken clock or an edit: ordered by its mtime, the oldest here.
    plantArchive("upgrade-broken", "2099-01-01T00:00:00Z", "2025-12-01T00:00:00Z");

    const listed = listSnapshots(vault).snapshots;
    expect(listed.map((s) => s.run_id)).toEqual(["upgrade-b", "upgrade-a", "upgrade-broken"]);
    const broken = listed.find((s) => s.run_id === "upgrade-broken")!;
    expect(broken.created_at).toBe("2025-12-01T00:00:00.000Z");
    expect(broken.created_at_untrusted).toContain("later than now");
    expect(listed.find((s) => s.run_id === "upgrade-b")!.created_at_untrusted).toBeUndefined();

    pruneSnapshots(vault, 1);
    expect(runIds()).toEqual(["upgrade-b"]);
  });

  test("a stamp carrying control characters is reported without them", () => {
    plantArchive(
      "upgrade-odd",
      "Fri Jan 01 2099 00:00:00 GMT+0000 (x\n\u001b[2J\u007f\u009b2J\u0085)",
      "2026-01-01T00:00:00Z",
    );
    const reason = listSnapshots(vault).snapshots[0]!.created_at_untrusted!;
    expect(reason).toContain("later than now");
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(reason).toContain("\\u009b2J");
  });

  test("a generated_at earlier than the run id's own time falls back to the mtime", () => {
    plantArchive("upgrade-2026-03-01-120000", "2020-01-01T00:00:00Z", "2026-03-01T12:00:05Z");
    plantArchive("upgrade-2026-02-01-120000", "2026-02-01T12:00:01Z", "2026-02-01T12:00:01Z");

    const listed = listSnapshots(vault).snapshots;
    expect(listed.map((s) => s.run_id)).toEqual([
      "upgrade-2026-03-01-120000",
      "upgrade-2026-02-01-120000",
    ]);
    expect(listed[0]!.created_at).toBe("2026-03-01T12:00:05.000Z");
    expect(listed[0]!.created_at_untrusted).toContain("earlier than the run id's own time");
    expect(listed[1]!.created_at_untrusted).toBeUndefined();
  });
});

describe("upgrade snapshots obey retention", () => {
  test("applyUpgrade prunes older archives oldest-first and keeps its own", () => {
    setRetention(2);
    // Older recovery points, with mtimes reversed against manifest time
    // and all of them claiming to be newer than the upgrade about to run.
    plantArchive("upgrade-old-1", "2026-01-01T00:00:00Z", "2030-01-03T00:00:00Z");
    plantArchive("upgrade-old-2", "2026-01-02T00:00:00Z", "2030-01-02T00:00:00Z");
    plantArchive("upgrade-old-3", "2026-01-03T00:00:00Z", "2030-01-01T00:00:00Z");
    atomicWriteFileSync(brainManualPath(vault), "stale operator copy\n");

    const res = applyUpgrade(vault, { agent: "test-agent" });

    expect(res.run_id.startsWith("upgrade-")).toBe(true);
    const left = runIds();
    expect(left).toHaveLength(2);
    expect(left).toContain(res.run_id);
    expect(left).toContain("upgrade-old-3");
  });

  test("repeated upgrades never grow past the retention count", () => {
    setRetention(2);
    for (let i = 0; i < 4; i++) {
      atomicWriteFileSync(brainManualPath(vault), `stale operator copy ${i}\n`);
      const res = applyUpgrade(vault, {
        agent: "test-agent",
        now: new Date(Date.UTC(2026, 10, 6, 12, 0, i)),
      });
      expect(runIds()).toContain(res.run_id);
    }
    expect(runIds()).toHaveLength(2);
  });
});

describe("import snapshots obey retention", () => {
  test("a Claude memory import prunes older archives and keeps its own", () => {
    setRetention(1);
    plantArchive("upgrade-old-1", "2026-01-01T00:00:00Z", "2030-01-02T00:00:00Z");
    plantArchive("upgrade-old-2", "2026-01-02T00:00:00Z", "2030-01-01T00:00:00Z");
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir);
    writeFileSync(
      join(memoryDir, "feedback_a.md"),
      "---\nname: rule-a\ndescription: Rule A.\nmetadata:\n  type: feedback\n---\n\nBody A.\n",
    );

    const res = importClaudeMemory({
      vault,
      memoryDir,
      mode: "apply",
      allowArbitraryMemoryPath: true,
      now: new Date("2026-11-06T10:00:00Z"),
    });

    expect(res.snapshotRunId).not.toBeNull();
    expect(runIds()).toEqual([res.snapshotRunId!]);
  });
});

describe("promote snapshots obey retention", () => {
  test("a host-memory promotion prunes older archives and keeps its own", () => {
    setRetention(1);
    plantArchive("upgrade-old-1", "2026-01-01T00:00:00Z", "2030-01-02T00:00:00Z");
    plantArchive("upgrade-old-2", "2026-01-02T00:00:00Z", "2030-01-01T00:00:00Z");
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "user",
      content: "User prefers dark mode",
      createdAt: "2026-06-20T10:00:00Z",
    });

    const res = promoteHostMemory({ vault, mode: "apply", now: new Date("2026-07-01T12:00:00Z") });

    expect(res.snapshotRunId).toStartWith("promote-host-memory-");
    expect(runIds()).toEqual([res.snapshotRunId!]);
  });
});
