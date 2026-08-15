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
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import {
  mintSelfHealRunId,
  readSelfHealReindexRows,
  recordSelfHealOutcome,
  recordSelfHealSpawn,
  SELF_HEAL_REINDEX_OUTCOME,
  SELF_HEAL_REINDEX_SURFACE,
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
      expect(spawned?.runId ?? "").not.toBe("");
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

      // Parent and child rows pair on the run id the parent minted and
      // handed to the child - not on a pid, which is machine-local and
      // therefore false on every peer this vault syncs to.
      const rows = readSelfHealReindexRows(vault);
      const completed = rows.find((row) => row.outcome === SELF_HEAL_REINDEX_OUTCOME.completed);
      expect(completed?.runId).toBe(spawned?.runId ?? "");
    },
    CHILD_BUDGET_MS + 10_000,
  );

  test(
    "two parents probing in the same window both spawn: the probe thins nothing here",
    async () => {
      // The measured shape of the advisory probe, pinned so the docblock
      // cannot drift away from it: the window between the probe and the
      // child's own `acquireWriterLock` is a cold Bun start - measured at
      // 710-753 ms over five samples on a 400-note vault - so every parent
      // that probes inside it finds the lock free and spawns.
      const [a, b] = await Promise.all([
        ensureVaultCurrent(vault, { background: true, configPath }),
        ensureVaultCurrent(vault, { background: true, configPath }),
      ]);
      expect(a.reindexSpawn).toBe(SELF_HEAL_SPAWN.spawned);
      expect(b.reindexSpawn).toBe(SELF_HEAL_SPAWN.spawned);

      // Both children run; the writer lock - not the probe - is what makes
      // one of them the only rebuild. Waiting for both terminal rows also
      // keeps the teardown from racing a live child.
      const settled = await pollUntil(
        () => readSelfHealReindexRows(vault).filter((row) => row.outcome !== null).length >= 2,
        CHILD_BUDGET_MS,
      );
      expect(settled).toBe(true);
      const outcomes = readSelfHealReindexRows(vault).filter((row) => row.outcome !== null);
      expect(outcomes.some((row) => row.outcome === SELF_HEAL_REINDEX_OUTCOME.completed)).toBe(
        true,
      );
    },
    CHILD_BUDGET_MS + 10_000,
  );
});

describe("self-heal reindex: the child's terminal outcome", () => {
  test(
    "a child that loses the lock records the failure by name",
    async () => {
      const runId = mintSelfHealRunId();
      const release = await holdWriterLock();
      try {
        await expect(
          cmdSearchReindex([
            "--self-heal",
            runId,
            "--vault",
            vault,
            "--config",
            configPath,
            "--json",
          ]),
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
      expect(failures[0]?.runId).toBe(runId);
    },
    CONTENTION_BUDGET_MS,
  );

  test(
    "a child that cannot resolve its own configuration still records a terminal row",
    async () => {
      // C9 case 2: `resolveConfig` used to run outside the recording, so a
      // child that died here left its parent's spawn row unpaired - which
      // the docblock read as a child that vanished.
      const badConfig = join(configHome, "bad-config.yaml");
      atomicWriteFileSync(badConfig, `vault: ${vault}\nsearch_chunk_size: -5\n`);
      const runId = mintSelfHealRunId();

      await expect(
        cmdSearchReindex(["--self-heal", runId, "--vault", vault, "--config", badConfig]),
      ).rejects.toThrow(/search_chunk_size/);

      const rows = readSelfHealReindexRows(vault);
      const failed = rows.find((row) => row.runId === runId);
      expect(failed?.outcome).toBe(SELF_HEAL_REINDEX_OUTCOME.failed);
      expect(failed?.error ?? "").toContain("search_chunk_size");
    },
    CONTENTION_BUDGET_MS,
  );

  test("a run without --self-heal records nothing", async () => {
    const code = await cmdSearchReindex(["--vault", vault, "--config", configPath, "--json"]);
    expect(code).toBe(0);
    expect(readSelfHealReindexRows(vault)).toEqual([]);
  });
});

describe("self-heal reindex: what a pair is, and what it is not", () => {
  test("two runs in one process do not pair, because the pair is a run id", () => {
    const spawnedRun = mintSelfHealRunId();
    const otherRun = mintSelfHealRunId();
    recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.spawned, spawnedRun);
    // A second, unrelated self-heal recorded by the SAME process - which is
    // exactly what a pid pairing cannot tell apart, on one host through pid
    // reuse and across a synced vault through two devices' pid spaces.
    recordSelfHealOutcome(vault, SELF_HEAL_REINDEX_OUTCOME.completed, otherRun, 12);

    const rows = readSelfHealReindexRows(vault);
    const spawned = rows.find((row) => row.decision === SELF_HEAL_SPAWN.spawned);
    expect(spawned?.runId).toBe(spawnedRun);
    expect(rows.some((row) => row.outcome !== null && row.runId === spawned?.runId)).toBe(false);
  });

  test("no machine-local value is written into a row", () => {
    recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.spawned, mintSelfHealRunId());
    recordSelfHealOutcome(vault, SELF_HEAL_REINDEX_OUTCOME.completed, mintSelfHealRunId(), 3);
    // The module's own claim, asserted against the bytes: a pid is
    // machine-local, and these rows sync to peers where it is false.
    for (const record of listMetrics(vault, { surface: SELF_HEAL_REINDEX_SURFACE })) {
      expect(Object.keys(record.payload)).not.toContain("pid");
    }
  });
});
