/**
 * What a Brain snapshot leaves out, and a file that vanishes while it runs.
 *
 * A snapshot is the backup before a destructive step, and `Brain/` is a
 * tree a person and a file sync write into: a file it leaves out is gone
 * after a rollback. So only what is provably the product's own transient
 * is left out (`snapshot-transient.ts`): the dotted atomic temp, a lock
 * file carrying `sync-lockfile.ts`'s stamp, an empty append-shard lock (a
 * surface's first metrics row creates its `.jsonl` under it: the CI race,
 * `Brain/metrics/self_heal_reindex.<device>.jsonl.lock`) and an empty
 * `proper-lockfile` lock directory. A person's `notes.md.lock` or
 * `draft.tmp` is archived and comes back. The sidecar manifest applies the
 * same rule. A listed member that vanishes before tar reads it lets the
 * snapshot list the tree again only when it was an empty lock file; a
 * content file, an unknown lock with content included, still fails it.
 *
 * The race is made deterministic from outside the product: the snapshot
 * runs in a child process whose PATH starts with a `tar` shim that, the
 * first time it runs, does what another writer would (removes or renames a
 * file), then runs the real tar. POSIX only (the shim is a shell script).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import lockfile from "proper-lockfile";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { buildManifest } from "../../../src/core/brain/manifest.ts";
import { productTransientKind } from "../../../src/core/brain/snapshot-transient.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { createSnapshot } from "../../../src/core/brain/snapshot.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { extractSnapshotArchive, listSnapshotArchive } from "../../helpers/snapshot-archive.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const CHILD = join(import.meta.dir, "fixtures", "snapshot-child.ts");
const DREAM = { reason: BRAIN_SNAPSHOT_REASON.dream };

let root: string;
let vault: string;
let brain: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-snap-vanish-"));
  vault = join(root, "vault");
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  brain = brainDirs(vault).brain;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function members(archive: string): string[] {
  return listSnapshotArchive(archive)
    .split(/\r?\n/)
    .map((l) => l.replace(/\/$/, ""))
    .filter((l) => l !== "");
}

/** A PATH whose `tar` runs `script` (shell) the first time, then runs the real tar. */
function shimPath(script: string): string {
  const real = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  const bin = join(root, "shim");
  mkdirSync(bin, { recursive: true });
  const once = join(root, "shim-ran");
  writeFileSync(
    join(bin, "tar"),
    `#!/bin/sh\nif [ ! -e '${once}' ]; then : > '${once}'; ${script}; fi\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "tar"), 0o755);
  return `${bin}${delimiter}${process.env["PATH"] ?? ""}`;
}

function snapshotInChild(path: string): { ok: boolean; path?: string; error?: string } {
  const r = spawnSync(process.execPath, ["run", CHILD, vault], {
    env: { ...process.env, PATH: path },
    encoding: "utf8",
  });
  return JSON.parse(r.stdout) as { ok: boolean; path?: string; error?: string };
}

describe("what a snapshot leaves out", () => {
  test("a person's lock- and tmp-named files are archived and come back byte for byte", () => {
    writeFileSync(join(brain, "notes.md"), "notes\n");
    writeFileSync(join(brain, "notes.md.lock"), "my own lock notes\n");
    writeFileSync(join(brain, "draft.tmp"), "a draft\n");
    writeFileSync(join(brain, "empty.md.lock"), "");

    const archive = createSnapshot(vault, "dream-user", DREAM).path;
    const out = join(root, "restored");
    mkdirSync(out);
    extractSnapshotArchive(archive, out);

    expect(readFileSync(join(out, "Brain", "notes.md.lock"), "utf8")).toBe("my own lock notes\n");
    expect(readFileSync(join(out, "Brain", "draft.tmp"), "utf8")).toBe("a draft\n");
    expect(existsSync(join(out, "Brain", "empty.md.lock"))).toBe(true);
  });

  test("the product's own locks and atomic temps are left out, the first append's lock too", () => {
    const metrics = join(brain, "metrics");
    mkdirSync(metrics, { recursive: true });
    writeFileSync(join(metrics, "self_heal_reindex.dev.jsonl"), "{}\n");
    // Locks the product's own helper makes, beside an existing shard and
    // before a surface's first row (the target does not exist yet).
    const held = acquireLockSync(join(metrics, "self_heal_reindex.dev.jsonl"));
    const first = acquireLockSync(join(metrics, "first_surface.dev.jsonl"));
    // A shard lock between its create and its stamp.
    writeFileSync(join(metrics, "other.dev.jsonl.lock"), "");
    writeFileSync(
      join(metrics, ".self_heal_reindex.dev.jsonl.4242.1700000000000.ab12.tmp"),
      "half",
    );
    // proper-lockfile's lock directory of a directory.
    mkdirSync(join(brain, "triggers"), { recursive: true });
    const release = lockfile.lockSync(join(brain, "triggers"), { realpath: false });
    try {
      const listed = members(createSnapshot(vault, "dream-locks", DREAM).path);

      expect(listed).toContain("Brain/metrics/self_heal_reindex.dev.jsonl");
      expect(listed.filter((m) => m.endsWith(".lock") || m.endsWith(".tmp"))).toEqual([]);
      expect(listed).toContain("Brain/triggers");
    } finally {
      release();
      held.release();
      first.release();
    }
  });

  test("the sidecar manifest leaves out exactly what the archive does", () => {
    writeFileSync(join(brain, "notes.md"), "notes\n");
    writeFileSync(join(brain, "notes.md.lock"), "my own lock notes\n");
    const held = acquireLockSync(join(brain, "pinned.md"));
    try {
      const listed = Object.keys(buildManifest(brain).files);

      expect(listed).toContain("notes.md.lock");
      expect(listed).not.toContain("pinned.md.lock");
    } finally {
      held.release();
    }
  });
});

/** A lock's target answer for the classifier tests: always there. */
function beside(): boolean {
  return true;
}

describe("the classifier", () => {
  test("a lock gone between its lstat and the read is vanished, never content", () => {
    const path = join(brain, "pinned.md.lock");
    const held = acquireLockSync(join(brain, "pinned.md"));
    const stat = lstatSync(path);
    held.release();

    expect(existsSync(path)).toBe(false);
    expect(productTransientKind(path, "pinned.md.lock", stat, beside)).toBe("vanished");
  });

  test("a lock directory gone before it is read is vanished", () => {
    const path = join(brain, "triggers.lock");
    mkdirSync(path);
    const stat = lstatSync(path);
    rmSync(path, { recursive: true });

    expect(productTransientKind(path, "triggers.lock", stat, beside)).toBe("vanished");
  });

  test("an empty shard lock that got content since its lstat is content", () => {
    const path = join(brain, "metrics", "late.dev.jsonl.lock");
    mkdirSync(join(brain, "metrics"), { recursive: true });
    writeFileSync(path, "");
    const stat = lstatSync(path);
    writeFileSync(path, "something a writer put here\n");

    expect(productTransientKind(path, "late.dev.jsonl.lock", stat, beside)).toBeNull();
    // Still empty when read: the shard lock it looked like.
    writeFileSync(path, "");
    expect(productTransientKind(path, "late.dev.jsonl.lock", lstatSync(path), beside)).toBe(
      "shard-lock",
    );
  });

  test("a .lock larger than a stamp is content, whatever it begins with", () => {
    const path = join(brain, "big.md.lock");
    const stamp = `1234\n${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}\n2026-11-20T00:00:00.000Z\n`;
    writeFileSync(path, stamp + "x".repeat(1_000_000));

    expect(productTransientKind(path, "big.md.lock", lstatSync(path), beside)).toBeNull();
  });

  test("a file that grew past the stamp since its lstat is content: the read is bounded", () => {
    const path = join(brain, "grow.md.lock");
    writeFileSync(path, "1234\n");
    const stat = lstatSync(path);
    writeFileSync(path, "y".repeat(1_000_000));

    expect(productTransientKind(path, "grow.md.lock", stat, beside)).toBeNull();
  });

  test.skipIf(IS_WINDOWS)("a symbolic link named *.lock is content, never followed", () => {
    const held = acquireLockSync(join(brain, "pinned.md"));
    try {
      const link = join(brain, "link.md.lock");
      symlinkSync(join(brain, "pinned.md.lock"), link);

      expect(productTransientKind(link, "link.md.lock", lstatSync(link), beside)).toBeNull();
      unlinkSync(link);
    } finally {
      held.release();
    }
  });
});

describe("a member that vanishes between listing and tar", () => {
  test.skipIf(IS_WINDOWS)("an empty lock file: the tree is listed again and archived", () => {
    const lock = join(brain, "inbox", "note.md.lock");
    writeFileSync(lock, "");

    const r = snapshotInChild(shimPath(`rm -f '${lock}'`));

    expect(r.error).toBeUndefined();
    expect(members(r.path!)).not.toContain("Brain/inbox/note.md.lock");
  });

  test.skipIf(IS_WINDOWS)("an unknown lock file with content fails the snapshot", () => {
    const lock = join(brain, "inbox", "note.md.lock");
    writeFileSync(lock, "mine\n");

    const r = snapshotInChild(shimPath(`rm -f '${lock}'`));

    expect(r.ok).toBe(false);
    expect(r.error).toContain("note.md.lock");
  });

  test.skipIf(IS_WINDOWS)("a content file fails the snapshot", () => {
    const note = join(brain, "inbox", "note.md");
    writeFileSync(note, "content\n");

    const r = snapshotInChild(shimPath(`rm -f '${note}'`));

    expect(r.ok).toBe(false);
    expect(r.error).toContain("note.md");
  });

  test.skipIf(IS_WINDOWS)("a temp renamed onto its final name before the retry is archived", () => {
    // An atomic write finishing at the top of Brain/ while the first tar
    // runs, beside an empty lock that vanishes and makes the retry happen.
    const temp = join(brain, ".new.md.4242.1700000000000.ab12.tmp");
    writeFileSync(temp, "completed\n");
    const lock = join(brain, "inbox", "note.md.lock");
    writeFileSync(lock, "");

    const r = snapshotInChild(shimPath(`mv '${temp}' '${join(brain, "new.md")}'; rm -f '${lock}'`));

    expect(r.error).toBeUndefined();
    expect(members(r.path!)).toContain("Brain/new.md");
  });
});
