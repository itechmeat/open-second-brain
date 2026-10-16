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
  extractedBytesOf,
  hashFile,
  hashTree,
  manifestPath,
  markManifestRetired,
  readManifest,
  updateManifest,
  writeManifestAtomic,
} from "../../../../src/core/brain/ingest/content-manifest.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { deleteBySource } from "../../../../src/core/brain/source-cleanup.ts";
import { acquireLockSync, LOCK_WAIT_BUDGET_ENV } from "../../../../src/core/brain/sync-lockfile.ts";

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

  test("an entry marked retired_into classifies `retired` while its bytes are unchanged", () => {
    // The resurrect guard (H3): a near-duplicate retirement marks the entry
    // instead of dropping it, so the unchanged source never reads as `new`.
    writeSource("dup.md", "duplicate bytes");
    updateManifest(vault, ["dup.md"]);
    const recorded = readManifest(vault).entries["dup.md"]!;
    writeManifestAtomic(vault, {
      "dup.md": { ...recorded, retired_into: "Brain/sources/src-canonical.md" },
    });

    const res = classifyPaths(vault, ["dup.md"], readManifest(vault));
    expect(res.retired).toEqual(["dup.md"]);
    expect(res.new).toEqual([]);
    expect(res.unchanged).toEqual([]);
    expect(res.modified).toEqual([]);
  });

  test("a retired entry whose bytes changed re-admits as `modified`", () => {
    writeSource("dup.md", "duplicate bytes");
    updateManifest(vault, ["dup.md"]);
    const recorded = readManifest(vault).entries["dup.md"]!;
    writeManifestAtomic(vault, {
      "dup.md": { ...recorded, retired_into: "Brain/sources/src-canonical.md" },
    });

    writeSource("dup.md", "the duplicate grew");
    const res = classifyPaths(vault, ["dup.md"], readManifest(vault));
    expect(res.modified).toEqual(["dup.md"]);
    expect(res.retired).toEqual([]);
  });

  test("a retired entry round-trips: it never serializes down to the v1 digest shape", () => {
    writeSource("dup.md", "duplicate bytes");
    updateManifest(vault, ["dup.md"]);
    const recorded = readManifest(vault).entries["dup.md"]!;
    writeManifestAtomic(vault, {
      "dup.md": { ...recorded, retired_into: "Brain/sources/src-canonical.md" },
    });

    // Data a write could read back is data the write must keep: the marker
    // survives a re-read and a re-write under the read-back contract.
    const reread = readManifest(vault).entries["dup.md"]!;
    expect(reread.retired_into).toBe("Brain/sources/src-canonical.md");
    writeManifestAtomic(vault, { "dup.md": reread });
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      entries: Record<string, { retired_into?: string }>;
    };
    expect(onDisk.entries["dup.md"]?.retired_into).toBe("Brain/sources/src-canonical.md");
  });

  test("a malformed retired_into on disk drops the field, never the entry", () => {
    writeManifestBytes(
      JSON.stringify({
        schema_version: 3,
        contract: { fingerprint: computeExtractionContractFingerprint(vault) },
        entries: { "dup.md": { sha256: "a".repeat(64), retired_into: 42 } },
      }),
    );
    const entry = readManifest(vault).entries["dup.md"];
    expect(entry?.sha256).toBe("a".repeat(64));
    expect(entry?.retired_into).toBeUndefined();
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
    expect(readManifest(vault).entries["temp.md"]?.sha256).toMatch(/^[0-9a-f]{64}$/);

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
  test("the manifest records the contract fingerprint per entry and reads it back", () => {
    writeSource("a.md", "a");
    updateManifest(vault, ["a.md"]);

    const manifest = readManifest(vault);
    expect(manifest.contract).toEqual({
      fingerprint: computeExtractionContractFingerprint(vault),
    });

    // The entry carries the fingerprint of the pass that recorded it, on
    // disk, under the bumped schema version.
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract: { fingerprint: string } | null;
      entries: Record<string, { sha256: string; fingerprint?: string }>;
    };
    const live = computeExtractionContractFingerprint(vault);
    expect(onDisk.schema_version).toBe(3);
    expect(onDisk.contract?.fingerprint).toBe(live);
    expect(onDisk.entries["a.md"]).toEqual({
      sha256: hashFile(join(vault, "a.md")),
      fingerprint: live,
    });
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
    expect(manifest.entries["a.md"]).toEqual({ sha256: "z".repeat(64) });
    expect(manifest.contract).toBeNull();
  });

  test("a v2 manifest (manifest-wide fingerprint only) degrades to every-entry-changed", () => {
    // v1.78.0 wrote the fingerprint manifest-wide and bare-digest entries, so
    // no entry carries a fingerprint of its own. The manifest-wide value
    // cannot vouch for them: the read degrades to the changed marker - the
    // fail-toward-reprocessing migration, never toward skipping.
    writeSource("Inbox/a.md", "source a");
    const digest = hashFile(join(vault, "Inbox", "a.md"));
    writeManifestBytes(
      JSON.stringify({
        schema_version: 2,
        contract: { fingerprint: computeExtractionContractFingerprint(vault) },
        entries: { "Inbox/a.md": digest },
      }),
    );

    const manifest = readManifest(vault);
    expect(manifest.schema_version).toBe(2);
    expect(manifest.entries["Inbox/a.md"]).toEqual({ sha256: digest });
    expect(manifest.contract).toBeNull();

    const plan = planBatches(vault, "Inbox", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(plan.contractChanged).toBe(true);
    expect(plan.skipped).toEqual([]);
  });

  test("readManifest reports the schema version the FILE carries, not the write version", () => {
    // No file yet: the current shape is the honest answer (nothing older exists).
    expect(readManifest(vault).schema_version).toBe(3);

    // An accepted v1 manifest must report itself as v1 - a diagnostic asking
    // "which version is on disk" gets the truth, not the write constant.
    writeManifestBytes(JSON.stringify({ schema_version: 1, entries: {} }));
    expect(readManifest(vault).schema_version).toBe(1);

    writeManifestBytes(
      JSON.stringify({ schema_version: 2, entries: {}, contract: { fingerprint: "f".repeat(64) } }),
    );
    expect(readManifest(vault).schema_version).toBe(2);

    writeManifestBytes(
      JSON.stringify({
        schema_version: 3,
        entries: {},
        contract: { fingerprint: "f".repeat(64) },
      }),
    );
    expect(readManifest(vault).schema_version).toBe(3);
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

    // Omitted is the post-extraction write: it stamps the live fingerprint on
    // the entry and lands as v3 - the one-time upgrade a real reprocessing
    // pass makes true.
    writeManifestAtomic(vault, { "a.md": "z".repeat(64) });
    const upgraded = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract: { fingerprint: string } | null;
    };
    expect(upgraded.schema_version).toBe(3);
    expect(upgraded.contract?.fingerprint).toBe(computeExtractionContractFingerprint(vault));
  });

  test("a v1 manifest's next write lands as v3 with the fingerprint", () => {
    writeSource("a.md", "a");
    writeManifestBytes(
      JSON.stringify({ schema_version: 1, entries: { "a.md": hashFile(join(vault, "a.md")) } }),
    );
    expect(readManifest(vault).contract).toBeNull();

    updateManifest(vault, ["a.md"]);
    const manifest = readManifest(vault);
    expect(manifest.schema_version).toBe(3);
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

  test("ingesting one source after a contract change keeps the others contract-changed", () => {
    // Regression (write-side trust review): the manifest-wide fingerprint
    // stamp made the FIRST post-change ingest cancel the reprocess owed to
    // every source it did not touch - the next plan reported them
    // contract-current and skipped them. Per-entry fingerprints pin each
    // entry to the contract it was recorded under.
    writeSource("Inbox/a.md", "source a");
    writeSource("Inbox/b.md", "source b");
    updateManifest(vault, ["Inbox/a.md", "Inbox/b.md"]);

    // The extraction contract changes (allowlist edit); only `a` is re-ingested.
    writeSource("Brain/_brain.yaml", "schema_version: 1\nschema:\n  extractable:\n    - paper\n");
    updateManifest(vault, ["Inbox/a.md"]);

    // `a` carries the live fingerprint; `b` still predates the contract.
    const live = computeExtractionContractFingerprint(vault);
    const manifest = readManifest(vault);
    expect(manifest.entries["Inbox/a.md"]?.fingerprint).toBe(live);
    expect(manifest.entries["Inbox/b.md"]?.fingerprint).not.toBe(live);
    expect(manifest.contract).toBeNull();

    // Re-plan: `b` must still be contract-changed - never skipped, never
    // silent. (`a` is byte-unchanged and current, but while ANY entry is
    // stale the plan-level marker stays changed, so it reprocesses too -
    // the fail-toward-reprocessing direction, until the last stale entry
    // is rewritten.)
    const plan = planBatches(vault, "Inbox", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(plan.contractChanged).toBe(true);
    expect(plan.contractChangedFiles).toBe(2);
    expect(plan.skipped).toEqual([]);
    const b = plan.batches.flatMap((batch) => batch.files).find((f) => f.path === "Inbox/b.md");
    expect(b?.status).toBe("contract-changed");
  });
});

describe("extraction watermark (t_a9cd4221)", () => {
  const WATERMARK = { extracted_bytes: 11, extracted_at: "2026-06-13T12:00:00Z" };

  test("additive watermark fields round-trip through reads and writes; schema stays 3", () => {
    writeSource("Inbox/log.md", "first line\n");
    updateManifest(vault, ["Inbox/log.md"]);
    const recorded = readManifest(vault).entries["Inbox/log.md"]!;

    // Hand-stamp the watermark the incremental extractor writes, through the
    // explicit-contract write form.
    writeManifestAtomic(
      vault,
      { "Inbox/log.md": { ...recorded, ...WATERMARK } },
      readManifest(vault).contract,
    );

    const reread = readManifest(vault).entries["Inbox/log.md"]!;
    expect(reread).toEqual({
      sha256: hashFile(join(vault, "Inbox", "log.md")),
      fingerprint: computeExtractionContractFingerprint(vault),
      ...WATERMARK,
    });

    // The additive fields never bump the schema version on disk.
    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
    };
    expect(onDisk.schema_version).toBe(3);
  });

  test("an untouched watermarked entry survives an updateManifest of another path", () => {
    writeSource("Inbox/log.md", "first line\n");
    updateManifest(vault, ["Inbox/log.md"]);
    const recorded = readManifest(vault).entries["Inbox/log.md"]!;
    writeManifestAtomic(
      vault,
      { "Inbox/log.md": { ...recorded, ...WATERMARK } },
      readManifest(vault).contract,
    );

    writeSource("Inbox/other.md", "a different source");
    updateManifest(vault, ["Inbox/other.md"]);

    const survivor = readManifest(vault).entries["Inbox/log.md"]!;
    expect(survivor.extracted_bytes).toBe(WATERMARK.extracted_bytes);
    expect(survivor.extracted_at).toBe(WATERMARK.extracted_at);
  });

  test("an entry without watermark fields degrades to byte 0", () => {
    writeSource("Inbox/a.md", "legacy source");
    updateManifest(vault, ["Inbox/a.md"]);
    const entry = readManifest(vault).entries["Inbox/a.md"]!;
    expect(entry.extracted_bytes).toBeUndefined();
    expect(extractedBytesOf(entry)).toBe(0);
  });

  test("a malformed watermark shape drops the fields, never the entry", () => {
    // Lazy degradation: the malformed watermark is absent, which answers
    // byte 0, which reprocesses fully - without forfeiting the entry's
    // fingerprint (no contract-changed cascade for one bad field).
    writeSource("Inbox/a.md", "source bytes");
    const digest = hashFile(join(vault, "Inbox", "a.md"));
    writeManifestBytes(
      JSON.stringify({
        schema_version: 3,
        contract: { fingerprint: computeExtractionContractFingerprint(vault) },
        entries: {
          "Inbox/a.md": {
            sha256: digest,
            fingerprint: computeExtractionContractFingerprint(vault),
            extracted_bytes: "many",
            extracted_at: 42,
            extracted_bytes_offset: -1,
          },
        },
      }),
    );
    const manifest = readManifest(vault);
    expect(manifest.entries["Inbox/a.md"]).toEqual({
      sha256: digest,
      fingerprint: computeExtractionContractFingerprint(vault),
    });
    expect(manifest.contract).not.toBeNull();
  });

  test("unknown entry shapes still drop toward reprocessing exactly as today", () => {
    writeSource("Inbox/b.md", "source b");
    writeManifestBytes(
      JSON.stringify({
        schema_version: 3,
        contract: { fingerprint: computeExtractionContractFingerprint(vault) },
        entries: { "Inbox/b.md": { other: true } },
      }),
    );
    const res = classifyPaths(vault, ["Inbox/b.md"], readManifest(vault));
    expect(res.new).toEqual(["Inbox/b.md"]);
  });

  test("updateManifest records a caller-supplied full entry verbatim", () => {
    writeSource("Inbox/log.md", "first line\n");
    const live = computeExtractionContractFingerprint(vault);
    const digest = hashFile(join(vault, "Inbox", "log.md"));
    updateManifest(vault, ["Inbox/log.md"], {
      "Inbox/log.md": { sha256: digest, fingerprint: live, ...WATERMARK },
    });
    expect(readManifest(vault).entries["Inbox/log.md"]).toEqual({
      sha256: digest,
      fingerprint: live,
      ...WATERMARK,
    });
  });

  test("a requested watermark is stat'ed and hashed inside the manifest lock", () => {
    // The L1 shape: the pinned form carries a digest computed OUTSIDE the
    // lock, so two concurrent runs over an appended source can land the
    // older digest-and-watermark pair last. The request form computes
    // neither value until the lock is held: updateManifest reads the file
    // itself, so the recorded pair always describes the bytes the write
    // saw, not the bytes the caller once saw.
    writeSource("Inbox/grow.md", "append-only log, revision one\n");
    updateManifest(
      vault,
      ["Inbox/grow.md"],
      {},
      {
        watermarks: { "Inbox/grow.md": { at: "2026-06-13T12:00:00Z" } },
      },
    );
    const entry = readManifest(vault).entries["Inbox/grow.md"]!;
    expect(entry.sha256).toBe(hashFile(join(vault, "Inbox", "grow.md")));
    expect(entry.extracted_bytes).toBe(Buffer.byteLength("append-only log, revision one\n"));
    expect(entry.extracted_at).toBe("2026-06-13T12:00:00Z");
    expect(entry.fingerprint).toBe(computeExtractionContractFingerprint(vault));
  });

  test("a watermark request supersedes a stale caller-precomputed pair", () => {
    // The race, in one test: the caller hashes the OLD bytes (as ingest.ts
    // did before the lock), the source appends, and only then does the
    // manifest write take the lock. The recorded entry must describe the
    // CURRENT bytes, never the stale pair.
    writeSource("Inbox/grow.md", "revision one\n");
    const staleDigest = hashFile(join(vault, "Inbox", "grow.md"));
    const staleSize = Buffer.byteLength("revision one\n");
    writeSource("Inbox/grow.md", "revision one\nrevision two appended\n");

    updateManifest(
      vault,
      ["Inbox/grow.md"],
      {
        "Inbox/grow.md": {
          sha256: staleDigest,
          fingerprint: computeExtractionContractFingerprint(vault),
          extracted_bytes: staleSize,
          extracted_at: "2026-06-13T11:00:00Z",
        },
      },
      { watermarks: { "Inbox/grow.md": { at: "2026-06-13T12:00:00Z" } } },
    );

    const entry = readManifest(vault).entries["Inbox/grow.md"]!;
    expect(entry.sha256).toBe(hashFile(join(vault, "Inbox", "grow.md")));
    expect(entry.sha256).not.toBe(staleDigest);
    expect(entry.extracted_bytes).toBe(Buffer.byteLength("revision one\nrevision two appended\n"));
    expect(entry.extracted_at).toBe("2026-06-13T12:00:00Z");
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

describe("markManifestRetired", () => {
  test("marks the entry inside the manifest lock and keeps every other field", () => {
    writeSource("imports/a.md", "alpha\n");
    updateManifest(vault, ["imports/a.md"]);
    const before = readManifest(vault).entries["imports/a.md"]!;

    // While another writer holds the manifest lock, the mark waits for it
    // (here with no budget, so it refuses) instead of writing past it.
    const saved = process.env[LOCK_WAIT_BUDGET_ENV];
    process.env[LOCK_WAIT_BUDGET_ENV] = "0";
    const held = acquireLockSync(manifestPath(vault));
    try {
      expect(() => markManifestRetired(vault, "imports/a.md", "Brain/sources/canon.md")).toThrow();
      expect(readManifest(vault).entries["imports/a.md"]!.retired_into).toBeUndefined();
    } finally {
      held.release();
      if (saved === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
      else process.env[LOCK_WAIT_BUDGET_ENV] = saved;
    }

    expect(markManifestRetired(vault, "imports/a.md", "Brain/sources/canon.md")).toBe("marked");
    const after = readManifest(vault).entries["imports/a.md"]!;
    expect(after).toEqual({ ...before, retired_into: "Brain/sources/canon.md" });
    expect(markManifestRetired(vault, "imports/a.md", "Brain/sources/canon.md")).toBe(
      "already-marked",
    );
    expect(markManifestRetired(vault, "imports/missing.md", "x.md")).toBe("no-entry");
  });
});
