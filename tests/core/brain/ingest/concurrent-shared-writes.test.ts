/**
 * The ingest path's read-modify-writes, driven by genuinely concurrent
 * processes (U7 of "nothing runs unwatched").
 *
 * `updateManifest`, `recordCompleted` and `appendGitRecords` each read a
 * shared file, merge one source's result into it, and write the whole thing
 * back. The batch planner exists so a caller dispatches each batch as a
 * PARALLEL SUBAGENT (`src/core/brain/ingest/batch-plan.ts:9-11`), so those
 * read-modify-writes overlap across processes by design.
 *
 * Atomicity is not exclusivity: `atomicWriteFileSync` renames a temp file into
 * place, which guarantees no reader sees a torn file and guarantees nothing
 * about a second writer that read the same "before" state
 * (`src/core/fs-atomic.ts:49-50`). Only a lock prevents the lost update.
 *
 * These tests spawn real `bun` children rather than simulating contention -
 * the same discipline as `tests/core/brain/lineage-ledger-integrity.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkpointPath,
  readCheckpoint,
  recordCompleted,
} from "../../../../src/core/brain/ingest/checkpoint.ts";
import {
  manifestPath,
  readManifest,
  writeManifestAtomic,
} from "../../../../src/core/brain/ingest/content-manifest.ts";
import { appendGitRecords, listGitCommits } from "../../../../src/core/brain/git/store.ts";
import {
  acquireLockSync,
  acquireLockSyncWithRetry,
} from "../../../../src/core/brain/sync-lockfile.ts";

const WRITERS = 4;
const PER_WRITER = 25;
const SEED_ENTRIES = 400;
const SPAWN_TIMEOUT_MS = 60_000;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-race-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Absolute path of a module under `src/`, for a spawned child's import. */
function srcModule(rel: string): string {
  return join(import.meta.dir, "../../../../src", rel);
}

/**
 * Milliseconds the children wait before starting work. `bun` startup alone
 * staggers four processes by more than a read-modify-write takes, which would
 * serialize them by accident; the barrier makes the overlap real.
 */
const BARRIER_LEAD_MS = 1_500;

/**
 * Preamble every child script starts with: parse argv and spin until the
 * shared start instant so all four enter the critical section together.
 */
const BARRIER_PREAMBLE: ReadonlyArray<string> = Object.freeze([
  "const [vault, tag, count, startAt] = process.argv.slice(2);",
  "while (Date.now() < Number(startAt)) Bun.sleepSync(1);",
]);

/** Write a child script and run `WRITERS` copies of it concurrently. */
async function runWriters(scriptName: string, lines: readonly string[]): Promise<void> {
  const script = join(vault, scriptName);
  writeFileSync(script, [...BARRIER_PREAMBLE, ...lines].join("\n"), "utf8");
  const startAt = String(Date.now() + BARRIER_LEAD_MS);
  const procs = Array.from({ length: WRITERS }, (_, index) =>
    Bun.spawn(["bun", script, vault, `w${index}`, String(PER_WRITER), startAt], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const failures: string[] = [];
  await Promise.all(
    procs.map(async (proc) => {
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) failures.push(`exit ${code}: ${err.trim()}`);
    }),
  );
  expect(failures).toEqual([]);
}

describe("updateManifest — concurrent writers", () => {
  test(
    "every source's content hash survives a four-process race",
    async () => {
      // A manifest big enough that the read-merge-write window is wide.
      const seeded: Record<string, string> = {};
      for (let i = 0; i < SEED_ENTRIES; i++) {
        seeded[`sources/seed-${i}.md`] = "0".repeat(64);
      }
      writeManifestAtomic(vault, seeded);

      const expected: string[] = [];
      for (let w = 0; w < WRITERS; w++) {
        for (let i = 0; i < PER_WRITER; i++) {
          const rel = `sources/w${w}-${i}.md`;
          mkdirSync(join(vault, "sources"), { recursive: true });
          writeFileSync(join(vault, rel), `body ${w}-${i}`, "utf8");
          expected.push(rel);
        }
      }

      await runWriters("manifest-writer.ts", [
        `import { updateManifest } from ${JSON.stringify(srcModule("core/brain/ingest/content-manifest.ts"))};`,
        "for (let i = 0; i < Number(count); i++) {",
        "  updateManifest(vault, [`sources/${tag}-${i}.md`]);",
        "}",
      ]);

      const entries = readManifest(vault).entries;
      const missing = expected.filter((rel) => entries[rel] === undefined);
      expect(missing).toEqual([]);
      // The seeded entries are untouched by a merge that only names new paths.
      expect(Object.keys(entries).length).toBe(SEED_ENTRIES + WRITERS * PER_WRITER);
      // No lock file is left behind by a clean run.
      expect(existsSync(`${manifestPath(vault)}.lock`)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("recordCompleted — concurrent writers", () => {
  const PLAN_ID = "0123456789abcdef";

  test(
    "every completed item survives a four-process race",
    async () => {
      const seed: string[] = [];
      for (let i = 0; i < SEED_ENTRIES; i++) seed.push(`sources/seed-${i}.md`);
      recordCompleted(vault, PLAN_ID, "sources", seed, new Date("2026-08-15T00:00:00Z"));

      const expected: string[] = [];
      for (let w = 0; w < WRITERS; w++) {
        for (let i = 0; i < PER_WRITER; i++) expected.push(`sources/w${w}-${i}.md`);
      }

      await runWriters("checkpoint-writer.ts", [
        `import { recordCompleted } from ${JSON.stringify(srcModule("core/brain/ingest/checkpoint.ts"))};`,
        "for (let i = 0; i < Number(count); i++) {",
        `  recordCompleted(vault, ${JSON.stringify(PLAN_ID)}, "sources", [\`sources/\${tag}-\${i}.md\`], new Date());`,
        "}",
      ]);

      const checkpoint = readCheckpoint(vault, PLAN_ID);
      expect(checkpoint).not.toBeNull();
      const completed = new Set(checkpoint!.completed);
      const missing = expected.filter((rel) => !completed.has(rel));
      expect(missing).toEqual([]);
      expect(completed.size).toBe(SEED_ENTRIES + WRITERS * PER_WRITER);
      expect(existsSync(`${checkpointPath(vault, PLAN_ID)}.lock`)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});

/** A 40-hex sha derived from a writer tag and an index. */
function sha(tag: string, index: number): string {
  return `${tag}${index}`
    .padEnd(40, "0")
    .slice(0, 40)
    .replace(/[^0-9a-f]/g, "a");
}

describe("appendGitRecords — concurrent writers", () => {
  const REPO_KEY = "race-repo";
  /** Every writer tries to append this one; dedup must let exactly one land. */
  const SHARED_SHA = "f".repeat(40);

  test(
    "no record is lost and the shared sha is not duplicated",
    async () => {
      const seeded = Array.from({ length: SEED_ENTRIES }, (_, i) => ({
        kind: "commit" as const,
        sha: sha("seed", i),
        authorName: "seed",
        authorEmail: "seed@example.com",
        committedAt: "2026-01-01T00:00:00Z",
        subject: `seed ${i}`,
        body: "",
        files: [],
        release: null,
      }));
      appendGitRecords(vault, REPO_KEY, seeded);

      await runWriters("git-writer.ts", [
        `import { appendGitRecords } from ${JSON.stringify(srcModule("core/brain/git/store.ts"))};`,
        `const shaFor = (t, i) => \`\${t}\${i}\`.padEnd(40, "0").slice(0, 40).replace(/[^0-9a-f]/g, "a");`,
        "for (let i = 0; i < Number(count); i++) {",
        `  appendGitRecords(vault, ${JSON.stringify(REPO_KEY)}, [`,
        "    { kind: 'commit', sha: shaFor(tag, i), authorName: tag, authorEmail: 't@e.c',",
        "      committedAt: '2026-02-02T00:00:00Z', subject: `c ${i}`, body: '', files: [], release: null },",
        `    { kind: 'commit', sha: ${JSON.stringify(SHARED_SHA)}, authorName: 'shared', authorEmail: 't@e.c',`,
        "      committedAt: '2026-02-02T00:00:00Z', subject: 'shared', body: '', files: [], release: null },",
        "  ]);",
        "}",
      ]);

      const commits = listGitCommits(vault, REPO_KEY);
      const shas = commits.map((c) => c.sha);
      for (let w = 0; w < WRITERS; w++) {
        for (let i = 0; i < PER_WRITER; i++) {
          expect(shas).toContain(sha(`w${w}`, i));
        }
      }
      // Dedup is only sound if the read and the append are one critical section.
      expect(shas.filter((s) => s === SHARED_SHA).length).toBe(1);
      expect(new Set(shas).size).toBe(shas.length);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("acquireLockSyncWithRetry — an expired budget is loud", () => {
  test("rethrows ELOCKED naming the lock file rather than writing unlocked", () => {
    const target = join(vault, "contended.json");
    const held = acquireLockSync(target);
    try {
      let caught: NodeJS.ErrnoException | null = null;
      try {
        acquireLockSyncWithRetry(target, 50);
      } catch (err) {
        caught = err as NodeJS.ErrnoException;
      }
      expect(caught?.code).toBe("ELOCKED");
      expect(caught?.message).toContain(`${target}.lock`);
    } finally {
      held.release();
    }
  });
});

/*
 * REMOVED: "the shared files are not corrupted by the race" - a fifth test
 * that re-ran the manifest race and asserted only that the file still
 * parsed as JSON.
 *
 * It could not fail. `atomicWriteFileSync` renames a whole file into
 * place, so the manifest is parseable with the lock, without it, and with
 * every writer racing - which is the sibling docblock's own point at the
 * top of this file ("Atomicity is not exclusivity"). Neutralising the lock
 * turned the other four tests red and left that one green. It certified a
 * property the lock does not provide, under a heading claiming the
 * opposite, and it cost four more processes to do it. The property itself
 * is not lost: `tests/core/fs-atomic.test.ts` tests the atomic write
 * directly, and the `updateManifest` race above asserts every entry and an
 * exact count, neither of which survives an unparseable file.
 */
