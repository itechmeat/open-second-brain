/**
 * The detached post-upgrade reindex, and the two silences it used to keep.
 *
 * N agent sessions starting after a schema bump each called
 * `ensureVaultCurrent(vault, { background: true })`, each spawned a detached
 * `o2b search reindex`, and N-1 of them spun on the writer lock for about
 * three seconds and died with their stderr pointed at nothing. Neither the
 * losing child nor the operator had any way to know it had happened.
 *
 * These tests hold both halves of the fix: the parent does not spawn a child
 * it can already see will lose, and a child that runs writes its terminal
 * outcome where it can be read back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import {
  readSelfHealReindexRows,
  SELF_HEAL_REINDEX_OUTCOME,
  SELF_HEAL_SPAWN,
} from "../../../src/core/maintenance/self-heal-reindex.ts";
import { cmdSearchReindex } from "../../../src/cli/search/verbs/indexing.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { acquireWriterLock } from "../../../src/core/search/store/writer-lock.ts";

let vault: string;
let configHome: string;
let configPath: string;
let prevConfigEnv: string | undefined;

/**
 * Budget for the end-to-end spawn test. A detached child pays a cold Bun
 * start plus a full rebuild of a freshly bootstrapped vault; the poll below
 * returns as soon as the row lands, so this is a ceiling, not a wait.
 */
const CHILD_BUDGET_MS = 60_000;

/** Contention budget: three retries of one second, then INDEX_LOCKED. */
const CONTENTION_BUDGET_MS = 20_000;

/** How often the poll below re-reads the sink. */
const POLL_INTERVAL_MS = 50;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-self-heal-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-self-heal-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  prevConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  if (prevConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = prevConfigEnv;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function dbPath(): string {
  return resolveSearchConfig({ vault, configPath }).dbPath;
}

/** The lock is taken on the live index path, whose directory must exist. */
async function holdWriterLock(): Promise<() => Promise<void>> {
  mkdirSync(dirname(dbPath()), { recursive: true });
  return await acquireWriterLock(dbPath());
}

async function pollUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // The rule suggests Promise.all. There is nothing to run in parallel:
    // this waits on a detached process nothing in-process holds a handle
    // to, so the only way to learn it finished is to look again.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return predicate();
}

describe("self-heal reindex: the spawn decision", () => {
  test("does not spawn a child while another writer holds the index lock", async () => {
    const release = await holdWriterLock();
    try {
      const r = await ensureVaultCurrent(vault, { background: true, configPath });

      expect(r.reindexSpawn).toBe(SELF_HEAL_SPAWN.skippedWriterLock);
      expect(r.reindexTriggered).toBe(false);
      expect(r.errors).toEqual([]);

      const rows = readSelfHealReindexRows(vault);
      expect(rows.map((row) => row.decision)).toEqual([SELF_HEAL_SPAWN.skippedWriterLock]);
      // The parent records its own spawn, so the absence of that row is
      // what proves no child was started.
      expect(rows.some((row) => row.decision === SELF_HEAL_SPAWN.spawned)).toBe(false);
    } finally {
      await release();
    }
  });

  test(
    "spawns a child when the lock is free, and returns before the child finishes",
    async () => {
      expect(existsSync(dbPath())).toBe(false);

      const r = await ensureVaultCurrent(vault, { background: true, configPath });

      expect(r.reindexSpawn).toBe(SELF_HEAL_SPAWN.spawned);
      expect(r.reindexTriggered).toBe(true);

      // Read the sink at the instant the parent handed control back: the
      // spawn is recorded, the child's terminal row is not there yet. That
      // is the assertion that session start does not wait for the rebuild.
      const atReturn = readSelfHealReindexRows(vault);
      const spawned = atReturn.find((row) => row.decision === SELF_HEAL_SPAWN.spawned);
      expect(spawned).toBeDefined();
      expect(spawned?.pid).toBeGreaterThan(0);
      expect(atReturn.some((row) => row.outcome !== null)).toBe(false);

      const done = await pollUntil(
        () =>
          readSelfHealReindexRows(vault).some(
            (row) => row.outcome === SELF_HEAL_REINDEX_OUTCOME.completed,
          ),
        CHILD_BUDGET_MS,
      );
      expect(done).toBe(true);
      expect(existsSync(dbPath())).toBe(true);

      // Parent and child rows pair on the child's pid.
      const rows = readSelfHealReindexRows(vault);
      const completed = rows.find((row) => row.outcome === SELF_HEAL_REINDEX_OUTCOME.completed);
      expect(completed?.pid).toBe(spawned?.pid ?? -1);
    },
    CHILD_BUDGET_MS + 10_000,
  );
});

describe("self-heal reindex: the child's terminal outcome", () => {
  test(
    "a child that loses the lock records the failure by name",
    async () => {
      const release = await holdWriterLock();
      try {
        await expect(
          cmdSearchReindex(["--self-heal", "--vault", vault, "--config", configPath, "--json"]),
        ).rejects.toThrow();
      } finally {
        await release();
      }

      const failures = readSelfHealReindexRows(vault).filter(
        (row) => row.outcome === SELF_HEAL_REINDEX_OUTCOME.failed,
      );
      expect(failures.length).toBe(1);
      // Not a bare zero and not a bare boolean: the row names what failed.
      expect(failures[0]?.error ?? "").toContain("INDEX_LOCKED");
      expect(failures[0]?.pid).toBe(process.pid);
    },
    CONTENTION_BUDGET_MS,
  );

  test("a run without --self-heal records nothing", async () => {
    const code = await cmdSearchReindex(["--vault", vault, "--config", configPath, "--json"]);
    expect(code).toBe(0);
    expect(readSelfHealReindexRows(vault)).toEqual([]);
  });
});
