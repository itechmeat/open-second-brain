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
import { computeExtractionContractFingerprint } from "../../../../src/core/brain/ingest/contract.ts";
import {
  classifyPaths,
  hashFile,
  hashTree,
  manifestPath,
  readManifest,
  updateManifest,
  writeManifestAtomic,
} from "../../../../src/core/brain/ingest/content-manifest.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { deleteBySource } from "../../../../src/core/brain/source-cleanup.ts";

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

  test("an unknown schema_version is still refused by name", () => {
    writeManifestBytes(JSON.stringify({ schema_version: 999, entries: {} }));
    expect(() => readManifest(vault)).toThrow(/ingest manifest schema_version 999 not supported/);
  });
});

/** Write raw bytes as the content manifest, for the versioned-fixture cases. */
function writeManifestBytes(bytes: string): void {
  const path = manifestPath(vault);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, "utf8");
}

describe("extraction contract (t_586d5d8b)", () => {
  test("the manifest records the contract fingerprint and reads it back", () => {
    writeSource("a.md", "a");
    updateManifest(vault, ["a.md"]);

    const manifest = readManifest(vault);
    expect(manifest.contract).toEqual({
      fingerprint: computeExtractionContractFingerprint(vault),
    });

    // The field is on disk, manifest-wide, under the bumped schema version.
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract: { fingerprint: string } | null;
    };
    expect(onDisk.schema_version).toBe(2);
    expect(onDisk.contract?.fingerprint).toBe(computeExtractionContractFingerprint(vault));
  });

  test("the fingerprint is stable across calls and sensitive to its inputs", () => {
    // Stable across calls: the recording is deterministic, not clocked.
    expect(computeExtractionContractFingerprint(vault)).toBe(
      computeExtractionContractFingerprint(vault),
    );
    // Sensitive to the allowlist: changing `extractable` changes the contract.
    const before = computeExtractionContractFingerprint(vault);
    writeSource("Brain/_brain.yaml", "schema_version: 1\nschema:\n  extractable:\n    - paper\n");
    expect(computeExtractionContractFingerprint(vault)).not.toBe(before);
  });

  test("a v1 manifest (no contract field) is accepted and degrades to changed-contract", () => {
    writeManifestBytes(JSON.stringify({ schema_version: 1, entries: { "a.md": "z".repeat(64) } }));
    const manifest = readManifest(vault);
    expect(manifest.entries["a.md"]).toBe("z".repeat(64));
    expect(manifest.contract).toBeNull();
  });

  test("readManifest reports the schema version the FILE carries, not the write version", () => {
    // No file yet: the current shape is the honest answer (nothing older exists).
    expect(readManifest(vault).schema_version).toBe(2);

    // An accepted v1 manifest must report itself as v1 - a diagnostic asking
    // "which version is on disk" gets the truth, not the write constant.
    writeManifestBytes(JSON.stringify({ schema_version: 1, entries: {} }));
    expect(readManifest(vault).schema_version).toBe(1);

    writeManifestBytes(
      JSON.stringify({ schema_version: 2, entries: {}, contract: { fingerprint: "f".repeat(64) } }),
    );
    expect(readManifest(vault).schema_version).toBe(2);
  });

  test("an explicitly-null contract writes the v1 shape; the omitted form stays the live upgrade", () => {
    // Explicit null is a v1 read being round-tripped: it serializes back as
    // v1, contract-less, keeping the changed-contract marker alive.
    writeManifestAtomic(vault, { "a.md": "z".repeat(64) }, null);
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract?: unknown;
    };
    expect(onDisk.schema_version).toBe(1);
    expect("contract" in onDisk).toBe(false);
    expect(readManifest(vault).contract).toBeNull();

    // Omitted is the post-extraction write: it records the LIVE contract
    // and lands as v2 - the one-time upgrade a real reprocessing pass makes true.
    writeManifestAtomic(vault, { "a.md": "z".repeat(64) });
    const upgraded = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract: { fingerprint: string } | null;
    };
    expect(upgraded.schema_version).toBe(2);
    expect(upgraded.contract?.fingerprint).toBe(computeExtractionContractFingerprint(vault));
  });

  test("a v1 manifest's next write lands as v2 with the fingerprint", () => {
    writeSource("a.md", "a");
    writeManifestBytes(
      JSON.stringify({ schema_version: 1, entries: { "a.md": hashFile(join(vault, "a.md")) } }),
    );
    expect(readManifest(vault).contract).toBeNull();

    updateManifest(vault, ["a.md"]);
    const manifest = readManifest(vault);
    expect(manifest.schema_version).toBe(2);
    expect(manifest.contract).toEqual({
      fingerprint: computeExtractionContractFingerprint(vault),
    });
  });

  test("cleanup preserves the recorded contract (the direct write round-trips the field)", () => {
    writeSource("doc.md", "the source bytes");
    updateManifest(vault, ["doc.md"]);
    const recorded = readManifest(vault).contract;

    const plan = deleteBySource(vault, "doc.md", { confirm: true });
    expect(plan.manifestEntryRemoved).toBe(true);

    const after = readManifest(vault);
    expect(after.entries["doc.md"]).toBeUndefined();
    expect(after.contract).toEqual(recorded);
  });

  test("cleanup on a not-yet-reprocessed v1 manifest keeps the owed contract-changed reprocess", () => {
    // The v1 manifest's remaining entry was extracted under the
    // pre-fingerprint contract and never reprocessed. A cleanup that
    // upgraded the file to v2 under the live contract would classify it
    // `unchanged` forever - the owed one-time reprocess forfeited, silently.
    writeSource("Inbox/a.md", "doomed source");
    writeSource("Inbox/b.md", "surviving source");
    writeManifestBytes(
      JSON.stringify({
        schema_version: 1,
        entries: {
          "Inbox/a.md": hashFile(join(vault, "Inbox", "a.md")),
          "Inbox/b.md": hashFile(join(vault, "Inbox", "b.md")),
        },
      }),
    );

    const plan = deleteBySource(vault, "Inbox/a.md", { confirm: true });
    expect(plan.manifestEntryRemoved).toBe(true);

    // The round-trip is lossless: still the v1 shape, contract-less, so the
    // changed-contract marker survives until a real reprocessing write.
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract?: unknown;
    };
    expect(onDisk.schema_version).toBe(1);
    expect("contract" in onDisk).toBe(false);
    const after = readManifest(vault);
    expect(after.contract).toBeNull();
    expect(after.entries["Inbox/b.md"]).toBeDefined();

    // The owed reprocess is still owed: the surviving byte-identical source
    // reprocesses as contract-changed, never as an `unchanged` skip. (The
    // deleted source itself is still on disk - originals go only with
    // includeOriginals - and classifies `new` again, which is correct.)
    const batches = planBatches(vault, "Inbox", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(batches.contractChanged).toBe(true);
    expect(batches.skipped).toEqual([]);
    const survivor = batches.batches.flatMap((b) => b.files).find((f) => f.path === "Inbox/b.md");
    expect(survivor?.status).toBe("contract-changed");
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
