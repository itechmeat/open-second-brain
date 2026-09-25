/**
 * Unpack a snapshot archive in a test, whichever compressor wrote it.
 *
 * The product writes zstd when the host has it and gzip (in-process)
 * otherwise, so a test that shells out to `zstd` fails on every host
 * without it - including native Windows and minimal CI images. This
 * mirrors the product's magic-byte probe: zstd through the binary (only
 * reachable on a host that wrote zstd), gzip through `node:zlib`, then
 * `tar -x -f -` into `dest`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tarPathArg } from "../../src/core/brain/snapshot.ts";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decompressSnapshotArchive(archive: string): Buffer {
  const bytes = readFileSync(archive);
  if (bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    const zstd = spawnSync("zstd", ["-d", "-c", archive], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (zstd.status !== 0) {
      throw new Error(`zstd -d failed: ${zstd.error?.message ?? zstd.stderr?.toString()}`);
    }
    return zstd.stdout;
  }
  return gunzipSync(bytes);
}

/** Extract `archive` into `dest`; throws with tar's stderr on failure. */
export function extractSnapshotArchive(archive: string, dest: string): void {
  const tar = spawnSync("tar", ["-x", "-f", "-", "-C", tarPathArg(dest)], {
    input: decompressSnapshotArchive(archive),
    stdio: ["pipe", "inherit", "pipe"],
  });
  if (tar.status !== 0) {
    throw new Error(`tar -x failed: ${tar.error?.message ?? tar.stderr?.toString()}`);
  }
}

/**
 * The member names of `archive`, one per line, as `tar -t` prints them.
 *
 * The tarball travels through stdin rather than `-f <path>`: Git for
 * Windows' GNU tar, first on PATH on GitHub's Windows runners, reads the
 * drive colon of `-f C:\...` as a remote host.
 */
export function listSnapshotArchive(archive: string): string {
  const tar = spawnSync("tar", ["-t", "-f", "-"], {
    input: decompressSnapshotArchive(archive),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (tar.status !== 0) {
    throw new Error(`tar -t failed: ${tar.error?.message ?? tar.stderr?.toString()}`);
  }
  return tar.stdout.toString("utf8");
}
