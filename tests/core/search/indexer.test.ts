import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexVault,
  reindexVault,
  indexStatus,
  indexCheck,
} from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { LATEST_SCHEMA_VERSION } from "../../../src/core/search/schema.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("indexer");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("first index adds every file; second run reports unchanged", async () => {
  writeMd(vault, "a.md", "# A\n\nFirst note.");
  writeMd(vault, "sub/b.md", "# B\n\nSecond note.");
  const cfg = makeConfig({ vault, dbPath });

  const first = await indexVault(cfg);
  expect(first.added).toBe(2);
  expect(first.updated).toBe(0);
  expect(first.unchanged).toBe(0);
  expect(first.deleted).toBe(0);
  expect(first.chunksTotal).toBeGreaterThanOrEqual(2);

  const second = await indexVault(cfg);
  expect(second.added).toBe(0);
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(2);
  expect(second.embeddingsComputed).toBe(0);
});

test("modifying a file produces an `updated` event and replaces chunks", async () => {
  const abs = writeMd(vault, "x.md", "# Old\n\noriginal content.");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  // Mutate content and mtime.
  writeFileSync(abs, "# New\n\nnew content that should be found.");
  const t = Date.now() / 1000 + 60;
  utimesSync(abs, t, t);

  const events: Array<{ path: string; kind: string }> = [];
  const stats = await indexVault(cfg, {
    onFile: (e) => events.push({ path: e.path, kind: e.kind }),
  });
  expect(stats.updated).toBe(1);
  expect(events.find((e) => e.path === "x.md")?.kind).toBe("updated");

  // The stale text is gone from FTS.
  const store = await Store.open(cfg, { mode: "read", loadVec: false });
  expect(store.keywordTopK('"original"', { limit: 5 }).length).toBe(0);
  expect(store.keywordTopK('"new"', { limit: 5 }).length).toBe(1);
  await store.close();
});

test("removing a file from disk produces a `deleted` event next run", async () => {
  writeMd(vault, "stays.md", "# A");
  const removed = writeMd(vault, "removed.md", "# B");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  rmSync(removed);

  const events: string[] = [];
  const stats = await indexVault(cfg, { onFile: (e) => events.push(`${e.kind}:${e.path}`) });
  expect(stats.deleted).toBe(1);
  expect(events).toContain("deleted:removed.md");

  const store = await Store.open(cfg, { mode: "read", loadVec: false });
  expect(store.listDocuments().size).toBe(1);
  await store.close();
});

test("indexStatus reports not initialised when index file is absent", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const status = await indexStatus(cfg);
  expect(status.exists).toBe(false);
  expect(status.documents).toBe(0);
});

test("indexStatus reports accurate counts after an index run", async () => {
  writeMd(vault, "a.md", "# A\n\nbody");
  writeMd(vault, "b.md", "# B\n\nbody");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const status = await indexStatus(cfg);
  expect(status.exists).toBe(true);
  expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  expect(status.documents).toBe(2);
  expect(status.chunks).toBeGreaterThanOrEqual(2);
  expect(status.lastIndexedAt).toBeTruthy();
});

test("indexCheck reports vault readable, sqlite ok, fts ok", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const report = await indexCheck(cfg);
  expect(report.vaultReadable).toBe(true);
  expect(report.indexDirWritable).toBe(true);
  expect(report.sqliteOk).toBe(true);
  expect(report.fts5Ok).toBe(true);
  expect(report.fatal.length).toBe(0);
});

test("reindexVault rebuilds atomically and preserves .bak", async () => {
  writeMd(vault, "a.md", "# A");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(dbPath + ".bak")).toBe(false);

  writeMd(vault, "b.md", "# B");
  const stats = await reindexVault(cfg);
  expect(stats.added).toBeGreaterThanOrEqual(2);
  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(dbPath + ".bak")).toBe(true);
  expect(existsSync(dbPath + ".new")).toBe(false);

  // Stats reflect the rebuilt index (2 docs from scratch).
  const status = await indexStatus(cfg);
  expect(status.documents).toBe(2);
});

test("Store.open auto-restores from .bak when main file is missing", async () => {
  writeMd(vault, "a.md", "# A");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  await reindexVault(cfg);

  // Simulate crash mid-reindex by removing the main file (we still have .bak).
  rmSync(dbPath);
  expect(existsSync(dbPath + ".bak")).toBe(true);

  const status = await indexStatus(cfg);
  expect(status.exists).toBe(true);
});

test("UTF-8 only: invalid bytes record an error, do not crash the run", async () => {
  // Latin-1 high-byte content is not valid UTF-8 sequencing here.
  const bad = join(vault, "broken.md");
  writeFileSync(bad, Buffer.from([0xc3, 0x28])); // 0xc3 0x28 is invalid UTF-8 sequence
  writeMd(vault, "good.md", "valid content");
  const cfg = makeConfig({ vault, dbPath });

  const stats = await indexVault(cfg);
  expect(stats.added).toBe(1); // only good.md
  expect(stats.errors.some((e) => e.path === "broken.md")).toBe(true);
});

test("indexVault tolerates empty vault", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const stats = await indexVault(cfg);
  expect(stats.added).toBe(0);
  expect(stats.chunksTotal).toBe(0);
});

test("mtime+size fastpath skips read; hash fallback detects same-content touch", async () => {
  writeMd(vault, "a.md", "# Hello World\n\nSome content here.");
  const cfg = makeConfig({ vault, dbPath });

  const first = await indexVault(cfg);
  expect(first.added).toBe(1);
  expect(first.unchanged).toBe(0);

  // Touch the file: change mtime without changing content.
  // The fastpath should NOT fire (mtime differs) but the hash
  // fallback should detect unchanged content.
  const p = join(vault, "a.md");
  const future = new Date(Date.now() + 100_000);
  utimesSync(p, future, future);

  const second = await indexVault(cfg);
  // mtime changed → fastpath miss → read+hash runs → same hash → unchanged
  expect(second.unchanged).toBe(1);
  expect(second.updated).toBe(0);
  expect(second.added).toBe(0);
});
