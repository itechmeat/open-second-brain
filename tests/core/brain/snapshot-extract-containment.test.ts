/**
 * Extraction containment (t_sec_snapshot_members).
 *
 * A snapshot archive is vault content - agent-writable, and in a
 * peer-replicated vault writable by every peer - so extraction treats it
 * as untrusted input. These tests pin the one policy the extractor
 * enforces at its own layer: a symlink inside the archive that escapes
 * the extracted tree refuses the extract, while the in-tree links a
 * legitimate vault produces keep restoring.
 *
 * POSIX-only: creating the symlinks these fixtures need requires
 * privileges native Windows test accounts do not have. The sweep itself
 * is platform-neutral; the Windows-only behaviour is that the fixtures
 * cannot be built.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { snapshotPath } from "../../../src/core/brain/paths.ts";
import {
  extractSnapshotToTemp,
  BrainSnapshotError,
  restoreSnapshot,
} from "../../../src/core/brain/snapshot.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-extract-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-extract-cfg-"));
  const configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Tar a hand-built staging tree into the archive path `runId` names,
 * gzip-compressed: the extractor's magic-byte probe routes the bytes to
 * the in-process gunzip branch, so the test does not depend on which
 * compressor the host happens to have.
 */
function writeArchive(runId: string, staging: string): string {
  const tar = spawnSync("tar", ["-cf", "-", "-C", staging, "Brain"], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (tar.status !== 0 || tar.stdout === null) {
    throw new Error(`tar -cf failed: ${tar.error?.message ?? tar.stderr?.toString()}`);
  }
  const archive = snapshotPath(vault, runId);
  // Raw bytes, not the atomic string writer: the payload is gzip output.
  writeFileSync(archive, gzipSync(tar.stdout));
  return archive;
}

describe.skipIf(IS_WINDOWS)("extractSnapshotToTemp containment", () => {
  test("a symlink that escapes the extracted tree refuses the extract", () => {
    const outside = mkdtempSync(join(tmpdir(), "o2b-snap-outside-"));
    const staging = mkdtempSync(join(tmpdir(), "o2b-snap-stage-"));
    try {
      mkdirSync(join(staging, "Brain"));
      writeFileSync(join(staging, "Brain", "keep.md"), "kept");
      symlinkSync(outside, join(staging, "Brain", "esc"));
      writeArchive("sec-esc-1", staging);

      try {
        extractSnapshotToTemp(vault, "sec-esc-1");
        throw new Error("expected the extract to refuse an escaping symlink");
      } catch (err) {
        expect(err).toBeInstanceOf(BrainSnapshotError);
        expect((err as BrainSnapshotError).message).toContain("escapes the extracted tree");
        expect((err as BrainSnapshotError).message).toContain("esc");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("an in-tree symlink survives extraction and the restore input stays complete", () => {
    const staging = mkdtempSync(join(tmpdir(), "o2b-snap-stage-"));
    try {
      mkdirSync(join(staging, "Brain"));
      writeFileSync(join(staging, "Brain", "keep.md"), "kept");
      // The relative in-tree link a vault legitimately produces: the
      // member walk lists it without following it, so the archive
      // carries it, and the sweep must keep it. (An ABSOLUTE link to the
      // staging tree would refuse by design - after extraction it points
      // outside the extracted copy, which is exactly the shape of a
      // planted escape.)
      symlinkSync("keep.md", join(staging, "Brain", "link"));
      writeArchive("sec-intree-1", staging);

      const res = extractSnapshotToTemp(vault, "sec-intree-1");
      try {
        expect(readFileSync(join(res.brainRoot, "keep.md"), "utf8")).toBe("kept");
        expect(readFileSync(join(res.brainRoot, "link"), "utf8")).toBe("kept");
      } finally {
        res.cleanup();
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("a dangling symlink to a not-yet-existing file outside the tree refuses the extract", () => {
    // realpath cannot follow a dangling link, so only its recorded target
    // can be judged - and a link to a file that does not exist YET is
    // exactly the planted escape: restored into Brain/, it becomes a
    // write-through the moment anything creates the target.
    const outside = mkdtempSync(join(tmpdir(), "o2b-snap-outside-"));
    const staging = mkdtempSync(join(tmpdir(), "o2b-snap-stage-"));
    try {
      mkdirSync(join(staging, "Brain", "sub"), { recursive: true });
      writeFileSync(join(staging, "Brain", "keep.md"), "kept");
      symlinkSync(join(outside, "later.md"), join(staging, "Brain", "sub", "abs-dangle"));
      writeArchive("sec-dangle-abs", staging);
      expect(() => extractSnapshotToTemp(vault, "sec-dangle-abs")).toThrow(
        /escapes the extracted tree.*abs-dangle/,
      );

      rmSync(join(staging, "Brain", "sub", "abs-dangle"));
      symlinkSync("../../../nowhere/later.md", join(staging, "Brain", "sub", "rel-dangle"));
      writeArchive("sec-dangle-rel", staging);
      expect(() => extractSnapshotToTemp(vault, "sec-dangle-rel")).toThrow(
        /escapes the extracted tree.*rel-dangle/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe.skipIf(IS_WINDOWS)("restoreSnapshot symlink handling", () => {
  test("an in-tree relative link restores as the same relative link, alive after cleanup", () => {
    const staging = mkdtempSync(join(tmpdir(), "o2b-snap-stage-"));
    try {
      mkdirSync(join(staging, "Brain", "notes"), { recursive: true });
      writeFileSync(join(staging, "Brain", "notes", "keep.md"), "kept");
      symlinkSync("keep.md", join(staging, "Brain", "notes", "link"));
      symlinkSync("notes", join(staging, "Brain", "notes-alias"));
      writeArchive("sec-restore-intree", staging);

      restoreSnapshot(vault, "sec-restore-intree");

      // The link text is what the archive recorded, not an absolute path
      // into the temp extraction the restore has already deleted.
      expect(readlinkSync(join(vault, "Brain", "notes", "link"))).toBe("keep.md");
      expect(readlinkSync(join(vault, "Brain", "notes-alias"))).toBe("notes");
      expect(readFileSync(join(vault, "Brain", "notes", "link"), "utf8")).toBe("kept");
      expect(readFileSync(join(vault, "Brain", "notes-alias", "keep.md"), "utf8")).toBe("kept");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test("a dangling escaping link refuses the restore before the live tree is touched", () => {
    const outside = mkdtempSync(join(tmpdir(), "o2b-snap-outside-"));
    const staging = mkdtempSync(join(tmpdir(), "o2b-snap-stage-"));
    try {
      writeFileSync(join(vault, "Brain", "live.md"), "live");
      mkdirSync(join(staging, "Brain"));
      symlinkSync(join(outside, "later.md"), join(staging, "Brain", "planted.md"));
      writeArchive("sec-restore-dangle", staging);

      expect(() => restoreSnapshot(vault, "sec-restore-dangle")).toThrow(BrainSnapshotError);
      expect(readFileSync(join(vault, "Brain", "live.md"), "utf8")).toBe("live");
      expect(existsSync(join(vault, "Brain", "planted.md"))).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
