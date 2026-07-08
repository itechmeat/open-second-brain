/**
 * Content-hash skip-unchanged manifest (A1). A re-ingest is driven by whether a
 * source's BYTES changed, not by its mtime: a `git checkout` or an NFS touch
 * that leaves bytes identical must classify `unchanged` and rewrite nothing.
 * The manifest is a machine artifact at `<vault>/.open-second-brain/`, NOT under
 * `Brain/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import {
  classifyPaths,
  hashFile,
  hashTree,
  manifestPath,
  readManifest,
  updateManifest,
  writeManifestAtomic,
} from "../../../../src/core/brain/ingest/content-manifest.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-manifest-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-manifest-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeSource(rel: string, contents: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

describe("hashFile / hashTree", () => {
  test("hashFile is a 64-char lowercase hex SHA-256 over file bytes", () => {
    writeSource("a.md", "hello");
    const h = hashFile(join(vault, "a.md"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Same bytes → same hash; different bytes → different hash.
    writeSource("b.md", "hello");
    expect(hashFile(join(vault, "b.md"))).toBe(h);
    writeSource("c.md", "hello!");
    expect(hashFile(join(vault, "c.md"))).not.toBe(h);
  });

  test("hashFile is timestamp-independent (mtime change, same bytes)", () => {
    writeSource("a.md", "hello");
    const h1 = hashFile(join(vault, "a.md"));
    utimesSync(join(vault, "a.md"), new Date("2000-01-01"), new Date("2000-01-01"));
    expect(hashFile(join(vault, "a.md"))).toBe(h1);
  });

  test("hashTree is deterministic over a directory and content-sensitive", () => {
    writeSource("dir/x.md", "one");
    writeSource("dir/y.md", "two");
    const h1 = hashTree(join(vault, "dir"));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Recomputing over the same bytes is stable.
    expect(hashTree(join(vault, "dir"))).toBe(h1);
    // Changing a nested file changes the tree hash.
    writeSource("dir/y.md", "three");
    expect(hashTree(join(vault, "dir"))).not.toBe(h1);
  });
});

describe("classifyPaths", () => {
  test("classifies new / modified / unchanged / missing against the manifest", () => {
    writeSource("keep.md", "kept");
    writeSource("edit.md", "before");
    writeSource("gone.md", "temp");
    // Seed the manifest with post-ingest hashes for the three known paths.
    updateManifest(vault, ["keep.md", "edit.md", "gone.md"]);

    // Now: keep unchanged, edit modified, gone deleted, fresh is new.
    writeSource("edit.md", "after");
    rmSync(join(vault, "gone.md"));
    writeSource("fresh.md", "brand new");

    const manifest = readManifest(vault);
    const res = classifyPaths(vault, ["keep.md", "edit.md", "gone.md", "fresh.md"], manifest);

    expect(res.unchanged).toEqual(["keep.md"]);
    expect(res.modified).toEqual(["edit.md"]);
    expect(res.missing).toEqual(["gone.md"]);
    expect(res.new).toEqual(["fresh.md"]);
  });

  test("a byte-identical file with a bumped mtime is still `unchanged`", () => {
    writeSource("touched.md", "stable bytes");
    updateManifest(vault, ["touched.md"]);
    // Simulate a `git checkout` / NFS touch: mtime moves, bytes do not.
    utimesSync(join(vault, "touched.md"), new Date("2030-01-01"), new Date("2030-01-01"));

    const res = classifyPaths(vault, ["touched.md"], readManifest(vault));
    expect(res.unchanged).toEqual(["touched.md"]);
    expect(res.modified).toEqual([]);
  });
});

describe("manifest persistence", () => {
  test("manifest lives under .open-second-brain, not under Brain/", () => {
    expect(manifestPath(vault)).toBe(join(vault, ".open-second-brain", "ingest-manifest.json"));
  });

  test("writeManifestAtomic sorts keys and a no-op rerun is byte-identical", () => {
    writeSource("z.md", "z");
    writeSource("a.md", "a");
    updateManifest(vault, ["z.md", "a.md"]);

    const bytes1 = readFileSync(manifestPath(vault), "utf8");
    // Keys are serialized in sorted order for deterministic bytes.
    expect(bytes1.indexOf('"a.md"')).toBeLessThan(bytes1.indexOf('"z.md"'));

    // A no-op rerun (nothing changed) rewrites nothing → byte-identical.
    updateManifest(vault, ["z.md", "a.md"]);
    const bytes2 = readFileSync(manifestPath(vault), "utf8");
    expect(bytes2).toBe(bytes1);
  });

  test("updateManifest drops entries whose file was deleted", () => {
    writeSource("temp.md", "temp");
    updateManifest(vault, ["temp.md"]);
    expect(readManifest(vault).entries["temp.md"]).toMatch(/^[0-9a-f]{64}$/);

    rmSync(join(vault, "temp.md"));
    updateManifest(vault, ["temp.md"]);
    expect(readManifest(vault).entries["temp.md"]).toBeUndefined();
  });

  test("writeManifestAtomic reports whether it wrote", () => {
    expect(writeManifestAtomic(vault, { "a.md": "x".repeat(64) })).toBe(true);
    // Same entries → no write.
    expect(writeManifestAtomic(vault, { "a.md": "x".repeat(64) })).toBe(false);
    // Different entries → write.
    expect(writeManifestAtomic(vault, { "a.md": "y".repeat(64) })).toBe(true);
  });
});

describe("ingestSource integration", () => {
  const extraction = {
    entities: [{ category: "concept", name: "Restaking" }],
    relations: [],
  };

  test("re-ingesting a byte-identical source is a no-op: classified unchanged, summary not rewritten", () => {
    writeSource("Articles/primer.md", "the source bytes");
    const input = {
      sourcePath: "Articles/primer.md",
      summary: "An overview.",
      extraction,
    };

    const first = ingestSource(vault, input, { agent: "claude", now: NOW });
    const summaryAbs = join(vault, first.summaryPath);

    // The manifest now records the source's content hash.
    const res = classifyPaths(vault, ["Articles/primer.md"], readManifest(vault));
    expect(res.unchanged).toEqual(["Articles/primer.md"]);

    // Second ingest reaches steady state: the entity created by the first pass
    // now already exists, so it moves into the connections list — a legitimate
    // body change. Capture the steady-state bytes AFTER this pass.
    ingestSource(vault, input, { agent: "claude", now: NOW });
    const steadyBytes = readFileSync(summaryAbs, "utf8");

    // A further re-ingest of the byte-identical source is a true no-op: the
    // summary page is not rewritten (bytes only change when they would differ).
    ingestSource(vault, input, { agent: "claude", now: NOW });
    expect(readFileSync(summaryAbs, "utf8")).toBe(steadyBytes);
  });

  test("a source with no on-disk file (e.g. a URL) does not touch the manifest", () => {
    // Backward-compat: identity-only sources must not error or write a manifest.
    ingestSource(
      vault,
      { sourcePath: "https://example.com/post", summary: "s", extraction },
      { agent: "claude", now: NOW },
    );
    expect(readManifest(vault).entries).toEqual({});
  });
});
