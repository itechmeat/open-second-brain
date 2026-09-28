/**
 * A snapshot never holds the whole tar stream in memory.
 *
 * `createSnapshot` used to capture tar's stdout through `spawnSync` with a
 * 256 MB `maxBuffer`, so a `Brain/` tree whose archive crossed that size
 * failed with `ENOBUFS` after tar had already done all of its work - and a
 * self-heal upgrade that needed that snapshot failed the same way on every
 * start. The producer now writes to a file descriptor and the compressor
 * reads the file, so no buffer cap applies to the archive path.
 *
 * The producer here is a stand-in `tar` that writes 300 MB of zero bytes,
 * which is a valid (empty) tar stream: it is larger than the old cap and
 * costs no disk in the fixture tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { createSnapshot, extractSnapshotToTemp } from "../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

/** Above the 256 MB buffer the archive path used to be capped at. */
const PRODUCED_BYTES = 300 * 1024 * 1024;

let root: string;
let vault: string;
let originalPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-snap-stream-"));
  vault = join(root, "vault");
  mkdirSync(vault);
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  originalPath = process.env["PATH"];
});

afterEach(() => {
  process.env["PATH"] = originalPath;
  rmSync(root, { recursive: true, force: true });
});

/** A PATH directory whose `tar` writes `bytes` zero bytes to stdout and exits 0. */
function oversizedTarPath(bytes: number): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tar = join(bin, "tar");
  writeFileSync(tar, `#!/bin/sh\nexec head -c ${bytes} /dev/zero\n`);
  chmodSync(tar, 0o755);
  // `head` itself, for a PATH that holds nothing else.
  const head = Bun.which("head");
  if (head === null) throw new Error("test prerequisite missing from this machine: head");
  symlinkSync(head, join(bin, "head"));
  return bin;
}

/** Decompressed length of a gzip archive, streamed so the test stays small too. */
async function gunzippedLength(archive: string): Promise<number> {
  let total = 0;
  const stream = createReadStream(archive).pipe(createGunzip());
  for await (const chunk of stream) total += (chunk as Buffer).length;
  return total;
}

function magic(archive: string): [number, number] {
  const buf = Buffer.alloc(2);
  const fd = openSync(archive, "r");
  try {
    readSync(fd, buf, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  return [buf[0]!, buf[1]!];
}

describe("a tar stream larger than the old 256 MB capture buffer", () => {
  // The stand-in producer is a POSIX shell script.
  test.skipIf(process.platform === "win32")(
    "is archived instead of failing with ENOBUFS, and decompresses to every byte",
    async () => {
      // No zstd on this PATH, so the in-process gzip fallback runs: the
      // path that used to hold the whole stream AND a compressed copy.
      process.env["PATH"] = oversizedTarPath(PRODUCED_BYTES);

      const snap = createSnapshot(vault, "upgrade-stream-oversized", {
        reason: BRAIN_SNAPSHOT_REASON.upgrade,
      });

      expect(magic(snap.path)).toEqual([0x1f, 0x8b]);
      expect(statSync(snap.path).size).toBeLessThan(PRODUCED_BYTES / 100);
      expect(await gunzippedLength(snap.path)).toBe(PRODUCED_BYTES);
    },
    60_000,
  );
});

describe("the gzip fallback on a real tree", () => {
  test("writes a multi-member archive the restore path extracts byte for byte", () => {
    const tarOnly = join(root, "tar-only");
    mkdirSync(tarOnly);
    const tar = Bun.which("tar");
    if (tar === null) throw new Error("test prerequisite missing from this machine: tar");
    if (process.platform === "win32") {
      // `System32\tar.exe` needs only system libraries; see the note in
      // snapshot-derived-store.test.ts about Git for Windows' tar.
      process.env["PATH"] = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    } else {
      symlinkSync(tar, join(tarOnly, "tar"));
      process.env["PATH"] = tarOnly;
    }
    // More than one gzip member's worth of incompressible bytes, so the
    // archive is several members long and a reader must accept that.
    const big = randomBytes(20 * 1024 * 1024);
    writeFileSync(join(vault, "Brain", "log", "big.md"), big);

    createSnapshot(vault, "upgrade-stream-members", { reason: BRAIN_SNAPSHOT_REASON.upgrade });

    const extracted = extractSnapshotToTemp(vault, "upgrade-stream-members");
    try {
      expect(readFileSync(join(extracted.brainRoot, "log", "big.md")).equals(big)).toBe(true);
      expect(existsSync(join(extracted.brainRoot, "_brain.yaml"))).toBe(true);
    } finally {
      extracted.cleanup();
    }
  });
});
