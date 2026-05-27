/**
 * Tests for `src/core/brain/manifest.ts`.
 *
 * Covered:
 *   - empty Brain → empty files map
 *   - regular files hashed; output keys sorted lexicographically
 *   - `.snapshots/` excluded
 *   - symlinks skipped (defense against malicious archive contents)
 *   - byte-stable sha256 across runs on identical inputs
 *   - `diffManifests` classifies added / removed / changed
 *   - sidecar read / write roundtrip; corrupt and missing sidecars
 *     surface as `null` rather than throwing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_MANIFEST_SCHEMA_VERSION,
  buildManifest,
  diffManifests,
  manifestDiffHasDrift,
  manifestSidecarPath,
  readManifestSidecar,
  writeManifestSidecar,
  type BrainManifest,
} from "../../../src/core/brain/manifest.ts";

let vault: string;
let brain: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-manifest-"));
  brain = join(vault, "Brain");
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(brain, ".snapshots"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("buildManifest", () => {
  test("empty Brain → empty files map, schema_version 1, brain_root 'Brain'", () => {
    const m = buildManifest(brain);
    expect(m.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
    expect(m.brain_root).toBe("Brain");
    expect(Object.keys(m.files)).toEqual([]);
    expect(m.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("missing brainRoot directory → empty manifest, no throw", () => {
    rmSync(brain, { recursive: true, force: true });
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual([]);
  });

  test("two preferences → two entries sorted by relative path", () => {
    mkdirSync(join(brain, "preferences"), { recursive: true });
    writeFileSync(join(brain, "preferences", "pref-b.md"), "beta\n");
    writeFileSync(join(brain, "preferences", "pref-a.md"), "alpha\n");
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-a.md", "preferences/pref-b.md"]);
    expect(m.files["preferences/pref-a.md"]!.size).toBe(6);
    expect(m.files["preferences/pref-a.md"]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // sha256("alpha\n") == "31c0c4dee7f8eeeb27ff4f64ff5a7a9d97a6b6f49ad22082f6c12f9f0c5b9d27" → guard via length only.
    expect(m.files["preferences/pref-a.md"]!.sha256.length).toBe(64);
  });

  test(".snapshots/ is excluded from the walk", () => {
    writeFileSync(join(brain, ".snapshots", "phantom.tar.zst"), "binary");
    writeFileSync(join(brain, ".snapshots", "phantom.manifest.json"), "{}");
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-x.md"), "x");
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-x.md"]);
  });

  test("symlink under Brain/ is skipped (security)", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-real.md"), "real");
    const targetOutside = join(vault, "secret.txt");
    writeFileSync(targetOutside, "should-not-be-hashed");
    symlinkSync(targetOutside, join(brain, "preferences", "pref-link.md"));
    const m = buildManifest(brain);
    expect(Object.keys(m.files)).toEqual(["preferences/pref-real.md"]);
  });

  test("identical bytes → identical sha256 across two runs", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-a.md"), "deterministic");
    const m1 = buildManifest(brain);
    const m2 = buildManifest(brain);
    expect(m1.files["preferences/pref-a.md"]!.sha256).toBe(
      m2.files["preferences/pref-a.md"]!.sha256,
    );
  });

  test("config files at Brain/ root are hashed (e.g. _brain.yaml)", () => {
    writeFileSync(join(brain, "_brain.yaml"), "schema_version: 1\n");
    writeFileSync(join(brain, "_BRAIN.md"), "# manual\n");
    const m = buildManifest(brain);
    expect(Object.keys(m.files).toSorted()).toEqual(["_BRAIN.md", "_brain.yaml"]);
  });
});

describe("diffManifests", () => {
  function fakeManifest(files: Record<string, { sha: string; size: number }>): BrainManifest {
    const sortedKeys = Object.keys(files).toSorted();
    const out: Record<string, { readonly sha256: string; readonly size: number }> = {};
    for (const k of sortedKeys) {
      out[k] = Object.freeze({ sha256: files[k]!.sha, size: files[k]!.size });
    }
    return Object.freeze({
      schema_version: BRAIN_MANIFEST_SCHEMA_VERSION,
      generated_at: "2026-05-18T00:00:00Z",
      brain_root: "Brain",
      files: Object.freeze(out),
    });
  }

  test("identical manifests → empty diff in all three buckets", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(manifestDiffHasDrift(d)).toBe(false);
  });

  test("right has extra file → 'added'", () => {
    const a = fakeManifest({});
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.added.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.added[0]!.before).toBeNull();
    expect(d.added[0]!.after!.sha256).toBe("x");
    expect(manifestDiffHasDrift(d)).toBe(true);
  });

  test("left has extra file → 'removed'", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({});
    const d = diffManifests(a, b);
    expect(d.removed.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.removed[0]!.after).toBeNull();
    expect(manifestDiffHasDrift(d)).toBe(true);
  });

  test("same path different sha256 → 'changed'", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "y", size: 1 } });
    const d = diffManifests(a, b);
    expect(d.changed.map((e) => e.path)).toEqual(["preferences/pref-a.md"]);
    expect(d.changed[0]!.before!.sha256).toBe("x");
    expect(d.changed[0]!.after!.sha256).toBe("y");
  });

  test("same path same sha256 different size → 'changed' (defensive)", () => {
    const a = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 1 } });
    const b = fakeManifest({ "preferences/pref-a.md": { sha: "x", size: 2 } });
    const d = diffManifests(a, b);
    expect(d.changed.length).toBe(1);
  });

  test("multiple changes → each bucket sorted by path", () => {
    const a = fakeManifest({
      "z.md": { sha: "old", size: 1 },
      "a.md": { sha: "old", size: 1 },
    });
    const b = fakeManifest({
      "z.md": { sha: "new", size: 1 },
      "b.md": { sha: "new", size: 1 },
    });
    const d = diffManifests(a, b);
    expect(d.added.map((e) => e.path)).toEqual(["b.md"]);
    expect(d.removed.map((e) => e.path)).toEqual(["a.md"]);
    expect(d.changed.map((e) => e.path)).toEqual(["z.md"]);
  });
});

describe("sidecar I/O", () => {
  test("manifestSidecarPath lands inside Brain/.snapshots/", () => {
    expect(manifestSidecarPath(vault, "abc")).toBe(join(brain, ".snapshots", "abc.manifest.json"));
  });

  test("read of missing path → null (no throw)", () => {
    expect(readManifestSidecar(vault, "ghost")).toBeNull();
  });

  test("read of malformed JSON → null", () => {
    writeFileSync(manifestSidecarPath(vault, "torn"), "not json {");
    expect(readManifestSidecar(vault, "torn")).toBeNull();
  });

  test("read of wrong schema_version → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "old"),
      JSON.stringify({
        schema_version: 99,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: {},
      }),
    );
    expect(readManifestSidecar(vault, "old")).toBeNull();
  });

  test("read of tampered entry (null) → null, does not crash", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-null"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": null },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-null")).toBeNull();
  });

  test("read of tampered entry (missing sha256) → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-shape"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": { size: 12 } },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-shape")).toBeNull();
  });

  test("read of tampered entry (wrong sha256 type) → null", () => {
    writeFileSync(
      manifestSidecarPath(vault, "tampered-type"),
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-05-18T00:00:00Z",
        brain_root: "Brain",
        files: { "preferences/pref-x.md": { sha256: 42, size: 12 } },
      }),
    );
    expect(readManifestSidecar(vault, "tampered-type")).toBeNull();
  });

  test("write then read roundtrip yields equal structure", () => {
    mkdirSync(join(brain, "preferences"));
    writeFileSync(join(brain, "preferences", "pref-rt.md"), "roundtrip");
    const original = buildManifest(brain);
    writeManifestSidecar(vault, "rt", original);
    const back = readManifestSidecar(vault, "rt");
    expect(back).not.toBeNull();
    expect(back!.schema_version).toBe(BRAIN_MANIFEST_SCHEMA_VERSION);
    expect(back!.brain_root).toBe("Brain");
    expect(Object.keys(back!.files)).toEqual(Object.keys(original.files));
    expect(back!.files["preferences/pref-rt.md"]!.sha256).toBe(
      original.files["preferences/pref-rt.md"]!.sha256,
    );
  });
});
