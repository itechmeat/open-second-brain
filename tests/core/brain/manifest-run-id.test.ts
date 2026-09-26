/**
 * The sidecar manifest path validates its run id (audit L6).
 *
 * `rollback <run-id>` reads `<snapshots>/<run-id>.manifest.json` before
 * any other validation of the id runs, so a traversal-shaped id used to
 * read a manifest from outside the snapshots directory. The reader now
 * refuses the id instead of resolving it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildManifest,
  manifestSidecarPath,
  readManifestSidecar,
  writeManifestSidecar,
} from "../../../src/core/brain/manifest.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-manifest-run-id-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(brainDirs(vault).snapshots, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("a traversal-shaped run id is refused, not resolved outside the snapshots directory", () => {
  // A well-formed manifest planted one level above the snapshots dir.
  writeManifestSidecar(vault, "legit-run", buildManifest(join(vault, "Brain")));
  copyFileSync(
    manifestSidecarPath(vault, "legit-run"),
    join(vault, "Brain", "planted.manifest.json"),
  );
  expect(readManifestSidecar(vault, "legit-run")).not.toBeNull();

  for (const runId of ["../planted", "..\\planted", "sub/../../planted"]) {
    expect(() => readManifestSidecar(vault, runId)).toThrow(/run_id/);
  }
});
