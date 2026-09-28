/**
 * A snapshot archive appears under its final name only once it is complete.
 *
 * The zstd path used to hand `zstd -o` the final `<run_id>.tar.zst`, so a
 * process killed during compression left a truncated archive under the
 * name a listing, the retention pass and a rollback treat as a recovery
 * point, with no manifest beside it. The compressor now writes a partial
 * name in `.snapshots/` and the archive is published by an exclusive
 * link (or a checked rename) once the compressor has exited cleanly, and
 * the manifest follows the published archive.
 *
 * The compressor here is a stand-in `zstd` shell script, so the tests run
 * on POSIX hosts only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { manifestSidecarPath } from "../../../src/core/brain/manifest.ts";
import { snapshotPath, snapshotsDir } from "../../../src/core/brain/paths.ts";
import { createSnapshot, listSnapshots, pruneSnapshots } from "../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const RUN_ID = "upgrade-atomic-publish";

let root: string;
let vault: string;
let bin: string;
let originalPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-snap-atomic-"));
  vault = join(root, "vault");
  mkdirSync(vault);
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  bin = join(root, "bin");
  mkdirSync(bin);
  const tar = Bun.which("tar");
  if (tar === null) throw new Error("test prerequisite missing from this machine: tar");
  symlinkSync(tar, join(bin, "tar"));
  originalPath = process.env["PATH"];
});

afterEach(() => {
  process.env["PATH"] = originalPath;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Install a stand-in `zstd` whose body runs with `$out` set to the path it
 * was told to write (`-o <path>`). It records that path in `zstd-target`.
 */
function fakeZstd(body: string): void {
  const script = [
    "#!/bin/sh",
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift; fi',
    "  shift",
    "done",
    `printf '%s' "$out" > '${join(root, "zstd-target")}'`,
    body,
    "",
  ].join("\n");
  const path = join(bin, "zstd");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function snapshotEntries(): string[] {
  return readdirSync(snapshotsDir(vault)).toSorted();
}

describe.skipIf(process.platform === "win32")("publishing a zstd snapshot", () => {
  test("the compressor never writes the final archive name", () => {
    const final = snapshotPath(vault, RUN_ID);
    // The stand-in fails loudly if the final name already exists while it
    // runs, which is the window a kill used to leave a torn archive in.
    fakeZstd(`[ -e '${final}' ] && exit 9\nprintf 'archive-bytes' > "$out"`);
    process.env["PATH"] = bin;

    const snap = createSnapshot(vault, RUN_ID, { reason: BRAIN_SNAPSHOT_REASON.upgrade });

    const target = readFileSync(join(root, "zstd-target"), "utf8");
    expect(target).not.toBe(final);
    expect(target.startsWith(snapshotsDir(vault))).toBe(true);
    expect(snap.path).toBe(final);
    expect(readFileSync(final, "utf8")).toBe("archive-bytes");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(manifestSidecarPath(vault, RUN_ID))).toBe(true);
    expect(snapshotEntries()).toEqual([`${RUN_ID}.manifest.json`, `${RUN_ID}.tar.zst`]);
  });

  test("a failed compressor leaves neither the archive nor its partial file", () => {
    fakeZstd(`printf 'torn' > "$out"\nexit 3`);
    process.env["PATH"] = bin;

    expect(() => createSnapshot(vault, RUN_ID, { reason: BRAIN_SNAPSHOT_REASON.upgrade })).toThrow(
      /zstd exited with status 3/,
    );

    expect(snapshotEntries()).toEqual([]);
  });

  test("a process killed during compression leaves no recovery point behind", () => {
    // The stand-in writes half an archive and then kills the process that
    // is taking the snapshot, the way an operator's kill or a host timeout
    // would, before the compressor could finish.
    fakeZstd(`printf 'torn' > "$out"\nkill -9 "$PPID"\nsleep 5`);
    const runner = join(root, "run-snapshot.ts");
    writeFileSync(
      runner,
      [
        `import { createSnapshot } from ${JSON.stringify(join(import.meta.dir, "../../../src/core/brain/snapshot.ts"))};`,
        `createSnapshot(${JSON.stringify(vault)}, ${JSON.stringify(RUN_ID)}, { reason: "upgrade" });`,
        "",
      ].join("\n"),
    );

    // The killed child cannot clean its own temp directories, so they go
    // under this test's root rather than the shared temp directory.
    const childTmp = join(root, "tmp");
    mkdirSync(childTmp);
    const child = Bun.spawnSync([process.execPath, runner], {
      env: { ...process.env, PATH: bin, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp },
      stdout: "ignore",
      stderr: "pipe",
    });

    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(snapshotPath(vault, RUN_ID))).toBe(false);
    expect(listSnapshots(vault).snapshots).toEqual([]);
  });

  test("an archive already under the final name is refused and kept", () => {
    const final = snapshotPath(vault, RUN_ID);
    mkdirSync(snapshotsDir(vault), { recursive: true });
    writeFileSync(final, "someone-else");
    fakeZstd(`printf 'mine' > "$out"`);
    process.env["PATH"] = bin;

    expect(() => createSnapshot(vault, RUN_ID, { reason: BRAIN_SNAPSHOT_REASON.upgrade })).toThrow(
      /refusing to overwrite an existing archive/,
    );

    expect(readFileSync(final, "utf8")).toBe("someone-else");
    expect(snapshotEntries()).toEqual([`${RUN_ID}.tar.zst`]);
  });

  test("retention removes a partial a killed snapshot left behind, once it is stale", () => {
    mkdirSync(snapshotsDir(vault), { recursive: true });
    const stale = join(snapshotsDir(vault), `${RUN_ID}.tar.zst.partial-4242-0a0b0c0d`);
    const fresh = join(snapshotsDir(vault), "upgrade-live.tar.zst.partial-4343-01020304");
    writeFileSync(stale, "torn");
    writeFileSync(fresh, "still being written");
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 3600;
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    pruneSnapshots(vault, 10);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
