import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrainSnapshotToolingMissingError,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
} from "../../src/core/brain/snapshot.ts";
import { brainDirs, snapshotPath } from "../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import {
  BRAIN_MANIFEST_SCHEMA_VERSION,
  manifestSidecarPath,
  readManifestSidecar,
} from "../../src/core/brain/manifest.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });

  // Seed a minimal but interesting Brain/ tree.
  const dirs = brainDirs(vault);
  writeFileSync(
    join(dirs.inbox, "sig-2026-05-14-foo.md"),
    "---\nkind: brain-signal\n---\n\n## Raw\n\nseed\n",
  );
  writeFileSync(
    join(dirs.preferences, "pref-foo.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nseed\n",
  );
  writeFileSync(
    join(dirs.log, "2026-05-14.md"),
    "---\nkind: brain-log\n---\n\n# Brain log — 2026-05-14\n",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("createSnapshot", () => {
  test("captures every top-level Brain/ entry except .snapshots/", () => {
    const dirs = brainDirs(vault);
    // Place a sentinel inside .snapshots/ to confirm it is NOT bundled
    // into the new archive.
    writeFileSync(join(dirs.snapshots, "sentinel.tar.zst"), "X");

    const res = createSnapshot(vault, "dream-2026-05-14-070000");
    expect(existsSync(res.path)).toBe(true);

    // Extract into a fresh tmp and inspect.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-snap-verify-"));
    try {
      // Use system tar+zstd for verification (mirror what restore does
      // but in-test).
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const zstd = spawnSync("zstd", ["-d", "-c", res.path], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(zstd.status).toBe(0);
      const tar = spawnSync("tar", ["-x", "-C", tmp], {
        input: zstd.stdout,
        stdio: ["pipe", "inherit", "pipe"],
      });
      expect(tar.status).toBe(0);

      const extracted = join(tmp, "Brain");
      expect(existsSync(extracted)).toBe(true);
      expect(existsSync(join(extracted, "_brain.yaml"))).toBe(true);
      expect(existsSync(join(extracted, "_BRAIN.md"))).toBe(true);
      expect(existsSync(join(extracted, "inbox", "sig-2026-05-14-foo.md"))).toBe(true);
      expect(existsSync(join(extracted, "preferences", "pref-foo.md"))).toBe(true);
      // The .snapshots/ directory MUST NOT be inside the archive.
      expect(existsSync(join(extracted, ".snapshots"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects invalid run_id", () => {
    expect(() => createSnapshot(vault, "../escape")).toThrow();
  });

  test("writes sidecar manifest alongside the archive (§22 + §5-tail)", () => {
    createSnapshot(vault, "dream-with-manifest");
    const sidecar = manifestSidecarPath(vault, "dream-with-manifest");
    expect(existsSync(sidecar)).toBe(true);
    const m = readManifestSidecar(vault, "dream-with-manifest");
    expect(m).not.toBeNull();
    expect(m!.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
    expect(m!.brain_root).toBe("Brain");
    // The seed tree carries _brain.yaml, _BRAIN.md, the seed signal,
    // pref, and log entry. All must appear in the manifest.
    expect(m!.files["_brain.yaml"]).toBeDefined();
    expect(m!.files["_BRAIN.md"]).toBeDefined();
    expect(m!.files["inbox/sig-2026-05-14-foo.md"]).toBeDefined();
    expect(m!.files["preferences/pref-foo.md"]).toBeDefined();
    expect(m!.files["log/2026-05-14.md"]).toBeDefined();
  });
});

describe("listSnapshots", () => {
  test("returns archives in newest-first order by mtime", () => {
    createSnapshot(vault, "dream-2026-05-14-070000");
    // Force an older mtime on the first archive so the ordering is
    // unambiguous regardless of how fast the test runs.
    const a = snapshotPath(vault, "dream-2026-05-14-070000");
    const oldT = new Date("2026-05-13T00:00:00Z");
    utimesSync(a, oldT, oldT);

    createSnapshot(vault, "dream-2026-05-14-080000");
    const b = snapshotPath(vault, "dream-2026-05-14-080000");
    const midT = new Date("2026-05-14T00:00:00Z");
    utimesSync(b, midT, midT);

    createSnapshot(vault, "dream-2026-05-14-090000");
    const c = snapshotPath(vault, "dream-2026-05-14-090000");
    const newT = new Date("2026-05-15T00:00:00Z");
    utimesSync(c, newT, newT);

    const list = listSnapshots(vault);
    expect(list).toHaveLength(3);
    expect(list[0]!.run_id).toBe("dream-2026-05-14-090000");
    expect(list[1]!.run_id).toBe("dream-2026-05-14-080000");
    expect(list[2]!.run_id).toBe("dream-2026-05-14-070000");
    for (const s of list) {
      expect(s.size_bytes).toBeGreaterThan(0);
      expect(s.path.endsWith(".tar.zst")).toBe(true);
    }
  });

  test("returns [] when .snapshots/ is empty", () => {
    expect(listSnapshots(vault)).toEqual([]);
  });

  test("manifest_path populated when sidecar present, null otherwise", () => {
    createSnapshot(vault, "dream-with-sidecar");
    // Simulate a legacy snapshot: drop the sidecar that
    // createSnapshot just wrote so only the archive remains.
    const sidecar = manifestSidecarPath(vault, "dream-with-sidecar");
    expect(existsSync(sidecar)).toBe(true);

    createSnapshot(vault, "dream-legacy");
    rmSync(manifestSidecarPath(vault, "dream-legacy"), { force: true });

    const list = listSnapshots(vault);
    const byId = new Map(list.map((s) => [s.run_id, s]));
    expect(byId.get("dream-with-sidecar")!.manifest_path).toBe(sidecar);
    expect(byId.get("dream-legacy")!.manifest_path).toBeNull();
  });
});

describe("pruneSnapshots", () => {
  test("removes oldest archives, keeps the retention_count newest", () => {
    const labels = ["a", "b", "c", "d", "e"];
    const ts = [
      "2026-05-10T00:00:00Z",
      "2026-05-11T00:00:00Z",
      "2026-05-12T00:00:00Z",
      "2026-05-13T00:00:00Z",
      "2026-05-14T00:00:00Z",
    ];
    for (let i = 0; i < labels.length; i++) {
      const runId = `dream-${labels[i]}-000000`;
      createSnapshot(vault, runId);
      const p = snapshotPath(vault, runId);
      const t = new Date(ts[i]!);
      utimesSync(p, t, t);
    }
    const before = listSnapshots(vault);
    expect(before).toHaveLength(5);

    const res = pruneSnapshots(vault, 3);
    expect(res.deleted).toHaveLength(2);

    const after = listSnapshots(vault);
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.run_id)).toEqual([
      "dream-e-000000",
      "dream-d-000000",
      "dream-c-000000",
    ]);
  });

  test("noop when fewer files than retention_count", () => {
    createSnapshot(vault, "dream-only");
    const res = pruneSnapshots(vault, 10);
    expect(res.deleted).toEqual([]);
    expect(listSnapshots(vault)).toHaveLength(1);
  });

  test("removes sidecar manifest alongside the archive", () => {
    const labels = ["a", "b", "c"];
    const ts = ["2026-05-10T00:00:00Z", "2026-05-11T00:00:00Z", "2026-05-12T00:00:00Z"];
    for (let i = 0; i < labels.length; i++) {
      const runId = `dream-prune-${labels[i]}`;
      createSnapshot(vault, runId);
      const p = snapshotPath(vault, runId);
      const t = new Date(ts[i]!);
      utimesSync(p, t, t);
    }
    // Sanity: all three sidecars present pre-prune.
    for (const l of labels) {
      expect(existsSync(manifestSidecarPath(vault, `dream-prune-${l}`))).toBe(true);
    }

    pruneSnapshots(vault, 1);
    // 'c' is the newest by mtime, so 'a' and 'b' are deleted along with
    // their sidecars; 'c' and its sidecar survive.
    expect(existsSync(manifestSidecarPath(vault, "dream-prune-a"))).toBe(false);
    expect(existsSync(manifestSidecarPath(vault, "dream-prune-b"))).toBe(false);
    expect(existsSync(manifestSidecarPath(vault, "dream-prune-c"))).toBe(true);
  });

  test("legacy archive without sidecar still prunes cleanly", () => {
    createSnapshot(vault, "dream-legacy-prune-old");
    rmSync(manifestSidecarPath(vault, "dream-legacy-prune-old"), { force: true });
    const old = snapshotPath(vault, "dream-legacy-prune-old");
    const t = new Date("2026-05-09T00:00:00Z");
    utimesSync(old, t, t);

    createSnapshot(vault, "dream-legacy-prune-new");
    const res = pruneSnapshots(vault, 1);
    expect(res.deleted).toContain(old);
    expect(existsSync(old)).toBe(false);
  });
});

describe("restoreSnapshot — round-trip integrity", () => {
  test("state A → snapshot → mutate to B → restore A → bytes match for key files (excluding .snapshots/)", () => {
    const dirs = brainDirs(vault);
    const prefPath = join(dirs.preferences, "pref-foo.md");
    const sigPath = join(dirs.inbox, "sig-2026-05-14-foo.md");
    // Capture state A.
    const stateAPref = readFileSync(prefPath, "utf8");
    const stateASig = readFileSync(sigPath, "utf8");

    const snap = createSnapshot(vault, "dream-stateA");
    expect(existsSync(snap.path)).toBe(true);

    // Mutate to state B: rewrite a pref, delete a signal, add a new
    // file. Also put a *new* snapshot under .snapshots/ that should
    // survive the restore (this is the load-bearing invariant).
    writeFileSync(prefPath, "MUTATED PREF CONTENT");
    rmSync(sigPath);
    writeFileSync(join(dirs.inbox, "sig-newer.md"), "newer-content");
    // Create another snapshot — restoring stateA must NOT erase it.
    const newer = createSnapshot(vault, "dream-stateB");
    expect(existsSync(newer.path)).toBe(true);

    const res = restoreSnapshot(vault, "dream-stateA");
    expect(res.restored_files).toBeGreaterThan(0);

    // Key files restored byte-equal.
    expect(readFileSync(prefPath, "utf8")).toBe(stateAPref);
    expect(readFileSync(sigPath, "utf8")).toBe(stateASig);
    // The post-stateA new file should be gone.
    expect(existsSync(join(dirs.inbox, "sig-newer.md"))).toBe(false);
    // BOTH snapshots must survive — including the one made AFTER the
    // restored state, so the operator still has a forward path.
    expect(existsSync(snap.path)).toBe(true);
    expect(existsSync(newer.path)).toBe(true);
  });
});

describe("snapshot tooling absent", () => {
  test("createSnapshot throws BrainSnapshotToolingMissingError when tar absent", () => {
    // Synthetic vault root that bootstraps fine; then we run with a
    // sanitized PATH so neither tar nor compressors are available.
    const dirs = brainDirs(vault);
    mkdirSync(dirs.snapshots, { recursive: true });
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-path-for-test";
    try {
      expect(() => createSnapshot(vault, "dream-no-tools")).toThrow(
        BrainSnapshotToolingMissingError,
      );
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});
