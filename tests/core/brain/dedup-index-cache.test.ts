/**
 * The signal dedup index and its machine-local cache (issue #195).
 *
 * The index maps a signal's `dedup_hash` to the first signal carrying it,
 * across `inbox/`, `inbox/processed/` and `inbox/archived/`. It includes the
 * archive on purpose: a re-imported old session must not re-create a signal
 * the dream pass archived. Building it reads every signal file, which on a
 * slow mount outlasted the session-capture hook, so the result is cached
 * outside the vault and revalidated per directory (listing, count, mtime)
 * and per file (size, mtime). These tests pin that the cached index always
 * equals a fresh walk, including after a sync tool replaces a file under
 * the same name, and that the walk honours a deadline.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDedupIndex,
  loadDedupIndex,
  type DedupIndexEntry,
} from "../../../src/core/brain/dedup-hash.ts";
import { dedupIndexCachePath } from "../../../src/core/brain/dedup-index-cache.ts";
import { createSafeguard, SafeguardTimeoutError } from "../../../src/core/brain/safeguard.ts";

const HOUR_S = 3600;

let root: string;
let vault: string;
let cacheDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-dedup-cache-"));
  vault = join(root, "vault");
  cacheDir = join(root, "cache");
  for (const sub of ["", "processed", "archived"]) {
    mkdirSync(join(vault, "Brain", "inbox", sub), { recursive: true });
  }
  setEnv("OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR", cacheDir);
  setEnv("OPEN_SECOND_BRAIN_DEDUP_CACHE", undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function dir(sub: "" | "processed" | "archived"): string {
  return join(vault, "Brain", "inbox", sub);
}

function signalText(id: string, hash: string | null): string {
  return [
    "---",
    "kind: brain-signal",
    `id: ${id}`,
    'created_at: "2026-05-01T00:00:00Z"',
    "topic: t",
    "signal: positive",
    "agent: a",
    "principle: p",
    ...(hash === null ? [] : [`dedup_hash: ${hash}`]),
    "---",
    "",
  ].join("\n");
}

function put(sub: "" | "processed" | "archived", id: string, hash: string | null): string {
  const path = join(dir(sub), `${id}.md`);
  writeFileSync(path, signalText(id, hash));
  return path;
}

/** Push every file and directory mtime an hour back: past the racy window. */
function settle(): void {
  const past = Date.now() / 1000 - HOUR_S;
  for (const sub of ["", "processed", "archived"] as const) {
    for (const name of readdirSync(dir(sub))) {
      const p = join(dir(sub), name);
      if (statSync(p).isFile()) utimesSync(p, past, past);
    }
    utimesSync(dir(sub), past, past);
  }
}

function plain(index: Map<string, DedupIndexEntry>): Array<[string, string, string]> {
  return [...index].map(([hash, e]) => [hash, e.id, e.path]);
}

function uncached(): Map<string, DedupIndexEntry> {
  setEnv("OPEN_SECOND_BRAIN_DEDUP_CACHE", "0");
  try {
    return buildDedupIndex(vault);
  } finally {
    setEnv("OPEN_SECOND_BRAIN_DEDUP_CACHE", undefined);
  }
}

/**
 * Rewrite a signal's `dedup_hash` in place with a value of the same length,
 * then put back the file's and its directory's modification times (or give
 * the file `mtimeS` instead). No sync tool or writer in this repository does
 * this; the tests use it because an index built from the cache still
 * reports the OLD hash, which proves the file was not re-read.
 */
function rewriteInPlace(path: string, id: string, hash: string, mtimeS?: number): void {
  const parent = join(path, "..");
  const before = statSync(path);
  const parentBefore = statSync(parent);
  writeFileSync(path, signalText(id, hash));
  expect(statSync(path).size).toBe(before.size);
  const fileTime = mtimeS ?? before.mtimeMs / 1000;
  utimesSync(path, fileTime, fileTime);
  utimesSync(parent, parentBefore.atimeMs / 1000, parentBefore.mtimeMs / 1000);
}

function seed(): void {
  put("", "sig-2026-05-01-a", "h-a");
  put("", "sig-2026-05-01-nohash", null);
  put("processed", "sig-2026-05-01-b", "h-b");
  put("archived", "sig-2026-05-01-c", "h-c");
  // Same hash in two directories: the inbox copy is seen first and wins.
  put("archived", "sig-2026-05-01-dup", "h-a");
}

describe("buildDedupIndex", () => {
  test("indexes inbox, processed and archived; first seen wins", () => {
    seed();
    const index = buildDedupIndex(vault);
    expect(index.get("h-a")?.id).toBe("sig-2026-05-01-a");
    expect(index.get("h-b")?.id).toBe("sig-2026-05-01-b");
    expect(index.get("h-c")?.id).toBe("sig-2026-05-01-c");
    expect(index.size).toBe(3);
  });

  test("a quiet directory is served from the cache without a per-file stat", () => {
    seed();
    settle();
    buildDedupIndex(vault);
    expect(existsSync(dedupIndexCachePath(vault)!)).toBe(true);
    // A new file mtime is what the per-file tier would notice; the directory
    // tier never stats the file, so it still serves the cached hash.
    const a = join(dir(""), "sig-2026-05-01-a.md");
    rewriteInPlace(a, "sig-2026-05-01-a", "h-X", Date.now() / 1000 - HOUR_S / 2);

    const warm = buildDedupIndex(vault);
    expect(warm.get("h-a")?.path).toBe(a);
    expect(warm.has("h-X")).toBe(false);
    expect(uncached().get("h-X")?.path).toBe(a);
  });

  test("files written inside the racy window are never trusted from the cache", () => {
    seed();
    buildDedupIndex(vault);
    const a = join(dir(""), "sig-2026-05-01-a.md");
    rewriteInPlace(a, "sig-2026-05-01-a", "h-X");
    const index = buildDedupIndex(vault);
    expect(index.get("h-X")?.path).toBe(a);
    expect(plain(index)).toEqual(plain(uncached()));
  });

  test("a file replaced under the same name by rename is re-read", () => {
    seed();
    settle();
    buildDedupIndex(vault);
    // What a sync tool does: write a temp file, rename it over the
    // original, and stamp the remote side's (older) modification time.
    const target = join(dir(""), "sig-2026-05-01-a.md");
    const temp = join(dir(""), ".syncthing.sig-2026-05-01-a.md.tmp");
    writeFileSync(temp, signalText("sig-2026-05-01-a", "h-remote"));
    const remoteTime = Date.now() / 1000 - 2 * HOUR_S;
    utimesSync(temp, remoteTime, remoteTime);
    renameSync(temp, target);

    const index = buildDedupIndex(vault);
    expect(index.get("h-remote")?.id).toBe("sig-2026-05-01-a");
    expect(plain(index)).toEqual(plain(uncached()));
  });

  test("added and removed files are picked up", () => {
    seed();
    settle();
    buildDedupIndex(vault);
    rmSync(join(dir("processed"), "sig-2026-05-01-b.md"));
    put("", "sig-2026-05-02-new", "h-new");
    const index = buildDedupIndex(vault);
    expect(index.has("h-b")).toBe(false);
    expect(index.get("h-new")?.id).toBe("sig-2026-05-02-new");
    expect(plain(index)).toEqual(plain(uncached()));
  });

  test("a file moved into the archive is reused, not re-read", () => {
    seed();
    settle();
    buildDedupIndex(vault);
    rewriteInPlace(join(dir(""), "sig-2026-05-01-a.md"), "sig-2026-05-01-a", "h-X");
    renameSync(join(dir(""), "sig-2026-05-01-a.md"), join(dir("archived"), "sig-2026-05-01-a.md"));
    const index = buildDedupIndex(vault);
    expect(index.get("h-a")?.path).toBe(join(dir("archived"), "sig-2026-05-01-a.md"));
    expect(index.has("h-X")).toBe(false);
    expect(uncached().has("h-X")).toBe(true);
  });

  test("a corrupt cache file is ignored and replaced", () => {
    seed();
    settle();
    const cachePath = dedupIndexCachePath(vault)!;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, "{not json");
    expect(plain(buildDedupIndex(vault))).toEqual(plain(uncached()));
    // The rebuilt cache is in use: an in-place rewrite is not re-read.
    rewriteInPlace(join(dir(""), "sig-2026-05-01-a.md"), "sig-2026-05-01-a", "h-X");
    expect(buildDedupIndex(vault).has("h-X")).toBe(false);
  });

  test("OPEN_SECOND_BRAIN_DEDUP_CACHE=0 writes no cache", () => {
    seed();
    settle();
    setEnv("OPEN_SECOND_BRAIN_DEDUP_CACHE", "0");
    expect(dedupIndexCachePath(vault)).toBeNull();
    buildDedupIndex(vault);
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("the async loader returns the same index", async () => {
    seed();
    const cold = await loadDedupIndex(vault);
    expect(plain(cold)).toEqual(plain(uncached()));
    settle();
    const settled = await loadDedupIndex(vault);
    expect(plain(settled)).toEqual(plain(uncached()));
    rewriteInPlace(join(dir(""), "sig-2026-05-01-a.md"), "sig-2026-05-01-a", "h-X");
    const warm = await loadDedupIndex(vault);
    expect(warm.get("h-a")?.id).toBe("sig-2026-05-01-a");
    expect(warm.has("h-X")).toBe(false);
  });
});

/** A clock that advances one second per reading: a synthetic slow walk. */
function slowClock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

function manySignals(n: number): void {
  for (let i = 0; i < n; i++) put("", `sig-2026-05-01-s${i}`, `h-${i}`);
}

describe("the walk honours a deadline", () => {
  test("a walk past its budget stops at a checkpoint", () => {
    manySignals(50);
    const safeguard = createSafeguard({ operation: "hook", timeoutMs: 5_000, now: slowClock() });
    expect(() => buildDedupIndex(vault, { safeguard })).toThrow(SafeguardTimeoutError);
  });

  test("the async walk stops too", async () => {
    manySignals(50);
    const safeguard = createSafeguard({ operation: "hook", timeoutMs: 5_000, now: slowClock() });
    await expect(loadDedupIndex(vault, { safeguard })).rejects.toThrow(SafeguardTimeoutError);
  });

  test("under budget the guarded walk returns the full index", () => {
    manySignals(50);
    const safeguard = createSafeguard({ operation: "hook", timeoutMs: 60_000 });
    expect(buildDedupIndex(vault, { safeguard }).size).toBe(50);
  });
});
