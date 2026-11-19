/**
 * Sync leftovers in the legacy tree (change migration-sync-conflict-copies):
 * a sync tool's conflict copy or temp file never stops a migration, and no
 * user data in one is silently lost. The fixture holds every kind a real
 * two-machine vault synced by Syncthing held (`fixtures/sync-leftovers.ts`).
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { STORE_DUAL_WRITE_ENV } from "../../../src/core/store/constants.ts";
import { join } from "node:path";

import { resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import {
  migrationCheck,
  SYNC_COPIES_KEPT_CODE,
} from "../../../src/core/brain/doctor/migration-check.ts";
import type { DoctorCheckContext, DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import { planMigrationDryRun } from "../../../src/core/store-migration/dry-run.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { MigrationRefusedError, runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { removeLegacyTree } from "../../../src/core/store-migration/removal.ts";
import { importLateLegacyWrites } from "../../../src/core/store-migration/transition.ts";
import { archiveSyncCopies, syncCopiesListPath } from "../../../src/core/store-migration/backup.ts";
import { retainedSyncCopies } from "../../../src/core/store-migration/sync-leftovers.ts";
import { rmSync } from "node:fs";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import {
  plantSyncLeftovers,
  ROW_ONLY_IN_COPY,
  ROW_SHARED,
  SYNC_LEFTOVERS as L,
  TEMP_SIGNAL,
} from "./fixtures/sync-leftovers.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const KILL_CHILD = join(import.meta.dir, "fixtures", "kill-child.ts");

let bench: MigrationBench | null = null;
let fleet: Fleet | null = null;

afterEach(() => {
  bench?.cleanup();
  bench = null;
  fleet?.cleanup();
  fleet = null;
});

function plantedBench(): MigrationBench {
  const b = makeMigrationBench("osb-sync-copies-");
  plantSyncLeftovers(b.fx.write);
  return b;
}

/** Records of the `log-event` kind whose payload text is `text`. */
function logRecords(records: ReadonlyArray<{ body: Record<string, unknown> }>, text: string) {
  return records.filter((r) => {
    const body = r.body["body"] as { text?: unknown } | undefined;
    return body?.text === text;
  });
}

/** A log row that only one copy holds, at two of its lines. */
const ROW_TWICE = {
  ts: "2026-10-28T22:00:00Z",
  kind: "note",
  payload: { text: "twice in one copy" },
  prev: null,
  h: "0".repeat(64),
};
const jsonlOf = (...rows: ReadonlyArray<unknown>): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** The signals surface's counts of a conflict-copy report. */
function signalCounts(report: {
  surfaces: ReadonlyArray<{ surface: string; imported: number; identical: number; kept: number }>;
}) {
  const s = report.surfaces.find((x) => x.surface === "signals")!;
  return { imported: s.imported, identical: s.identical, kept: s.kept };
}

/** A kept signal copy of the list the backup is handed. */
const keptCopy = (path: string) => ({ path, original: path, surface: "signals", reason: "v" });

const textOf = (row: unknown): string => (row as { payload: { text: string } }).payload.text;

/** The audit rows of a target, from any device's records. */
function auditRecords(records: ReadonlyArray<{ body: Record<string, unknown> }>, target: string) {
  return records.filter((r) => JSON.stringify(r.body).includes(`"target":"${target}"`));
}

describe("the dry run", () => {
  test("reports a copy row it cannot parse as the migration does", () => {
    bench = plantedBench();
    const bad = "Brain/log/2026-10-28.dev-b.sync-conflict-20261028-211618-QFQZVF3.jsonl";
    bench.fx.write(bad, `${JSON.stringify(ROW_SHARED)}\n{not json\n`);
    const plan = planMigrationDryRun(bench.vault);
    expect(plan.unparseable).toContainEqual(expect.objectContaining({ path: bad, line: 2 }));
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(plan.totals.unparseable).toBe(result.unparseable);
  });

  test("passes with every kind of sync leftover and reports what each becomes", () => {
    bench = plantedBench();
    const plan = planMigrationDryRun(bench.vault);
    expect(plan.unmapped).toEqual([]);
    expect(plan.ok).toBe(true);
    const by = new Map(plan.sync_copies.surfaces.map((s) => [s.surface, s]));
    expect(by.get("brain_log")).toEqual({
      surface: "brain_log",
      copies: 1,
      imported: 1,
      identical: 1,
      kept: 0,
      dropped: 0,
    });
    // W40: one copy equal to the shard, one with a row of its own; W44 a
    // device's copy with a row of its own.
    expect(by.get("log_audit_trails")).toEqual({
      surface: "log_audit_trails",
      copies: 3,
      imported: 2,
      identical: 3,
      kept: 0,
      dropped: 0,
    });
    expect(by.get("signals")).toEqual({
      surface: "signals",
      copies: 3,
      imported: 0,
      identical: 1,
      kept: 2,
      dropped: 0,
    });
    expect(by.get("pinned_context")?.kept).toBe(1);
    expect(by.get("freshen_state")?.dropped).toBe(2);
    expect(by.get("self_heal_upgrade_lock")?.dropped).toBe(1);
    expect(by.get("log_day_pages")?.dropped).toBe(1);
    expect(plan.sync_copies.kept.map((k) => k.path)).toEqual([...L.signalTwoCopies, L.pinnedCopy]);
    expect(plan.sync_copies.kept[2]).toMatchObject({
      original: "Brain/pinned.md",
      surface: "pinned_context",
    });
    expect(plan.sync_copies.temps_ignored).toBe(1);
    expect(plan.sync_copies.temps).toEqual([L.temp]);
  });

  test("a genuinely unknown file still stops the run, a copy of one too", () => {
    bench = plantedBench();
    bench.fx.write("Brain/log/notes.txt", "by hand\n");
    bench.fx.write("Brain/log/notes.sync-conflict-20261028-211616-QFQZVF3.txt", "by hand\n");
    const plan = planMigrationDryRun(bench.vault);
    expect(plan.ok).toBe(false);
    expect(plan.unmapped.map((u) => u.path)).toEqual([
      "Brain/log/notes.sync-conflict-20261028-211616-QFQZVF3.txt",
      "Brain/log/notes.txt",
    ]);
    expect(() => runMigration(bench!.vault, FAST)).toThrow(MigrationRefusedError);
  });
});

describe("the migration", () => {
  test("switches, imports a copy's own rows once, keeps differing versions and names them", () => {
    bench = plantedBench();
    const pinnedCopyBytes = readFileSync(join(bench.vault, L.pinnedCopy));
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(result.device_switched).not.toBeNull();
    const records = bench.records();
    // A row in both files is stored once; the copy's own row reaches the store.
    expect(logRecords(records, textOf(ROW_SHARED))).toHaveLength(1);
    expect(logRecords(records, textOf(ROW_ONLY_IN_COPY))).toHaveLength(1);
    expect(bench.byKey().get(`${L.logCopy}#2`)).toHaveLength(1);
    expect(bench.byKey().has(`${L.logCopy}#1`)).toBe(false);
    for (const target of ["s-1", "s-2", "s-3", "s-4"]) {
      expect([target, auditRecords(records, target).length]).toEqual([target, 1]);
    }
    // The identical signal copy adds nothing; the two versions are kept.
    for (const rel of [L.signalSameCopy, ...L.signalTwoCopies, L.pinnedCopy]) {
      expect(bench.byKey().has(rel)).toBe(false);
    }
    expect(result.sync_copies.kept.map((k) => k.path)).toEqual([
      ...L.signalTwoCopies,
      L.pinnedCopy,
    ]);
    expect(result.sync_copies_archive).not.toBeNull();
    const archived = join(result.sync_copies_archive!, ...L.pinnedCopy.split("/"));
    expect(readFileSync(archived)).toEqual(pinnedCopyBytes);
    // Dropped copies are never moved into device-local state.
    const local = join(migrationDir(bench.store()), "local");
    for (const rel of [...L.freshenCopies, L.lockCopy]) {
      expect(existsSync(join(local, ...rel.split("/")))).toBe(false);
    }
  });

  test("the doctor names the kept copies once, as advice, until the list is removed", () => {
    bench = plantedBench();
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const ctx: DoctorCheckContext = {
      vault: bench.vault,
      now: new Date(),
      config: undefined,
      dbPath: undefined,
      configPath: undefined,
      knownBasenames: new Set(),
      idIndex: new Map(),
      preferences: [],
      logs: [],
    };
    const run = (): DoctorFindings => {
      const out: DoctorFindings = { issues: [], uncertain: [] };
      migrationCheck.run(ctx, out);
      return out;
    };
    const out = run();
    const advice = out.uncertain.filter((u) => u.code === SYNC_COPIES_KEPT_CODE);
    expect(advice).toHaveLength(1);
    expect(advice[0]!.message).toContain(L.pinnedCopy);
    expect(out.issues.filter((i) => i.code === SYNC_COPIES_KEPT_CODE)).toEqual([]);
    rmSync(syncCopiesListPath(migrationDir(bench.store())));
    expect(run().uncertain.filter((u) => u.code === SYNC_COPIES_KEPT_CODE)).toEqual([]);
  });

  test("a row a copy holds at two lines is two items, as two lines of the original are", () => {
    bench = plantedBench();
    const twice = "Brain/log/2026-10-28.dev-b.sync-conflict-20261028-211619-QFQZVF3.jsonl";
    bench.fx.write(twice, jsonlOf(ROW_TWICE, ROW_TWICE));
    const plan = planMigrationDryRun(bench.vault);
    const surface = plan.sync_copies.surfaces.find((s) => s.surface === "brain_log")!;
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(logRecords(bench.records(), textOf(ROW_TWICE))).toHaveLength(2);
    expect(bench.byKey().get(`${twice}#1`)).toHaveLength(1);
    expect(bench.byKey().get(`${twice}#2`)).toHaveLength(1);
    // The dry run plans the same two imports.
    const after = result.sync_copies.surfaces.find((s) => s.surface === "brain_log")!;
    expect(surface.imported).toBe(after.imported);
  });

  test("a kept copy gone before the backup took it is not reported as kept, nor an empty archive", () => {
    bench = plantedBench();
    const dir = migrationDir(bench.store());
    const kept = [L.pinnedCopy, ...L.signalTwoCopies].map((path) => ({
      path,
      original: path,
      surface: path === L.pinnedCopy ? "pinned_context" : "signals",
      reason: "a second version",
    }));
    // Sync removed every copy after the last pass read it.
    for (const k of kept) rmSync(join(bench.vault, ...k.path.split("/")));
    expect(archiveSyncCopies(bench.vault, dir, kept)).toBeNull();
    expect(existsSync(syncCopiesListPath(dir))).toBe(false);
    // One of three is still there: the report names only that one as kept.
    bench.fx.write(L.pinnedCopy, "still here\n");
    const archive = archiveSyncCopies(bench.vault, dir, kept)!;
    expect(archive.copies.map((c) => c.path)).toEqual([L.pinnedCopy]);
    const report = retainedSyncCopies(
      {
        surfaces: [
          { surface: "pinned_context", copies: 1, imported: 0, identical: 0, kept: 1, dropped: 0 },
          { surface: "signals", copies: 2, imported: 0, identical: 0, kept: 2, dropped: 0 },
        ],
        kept,
        temps_ignored: 0,
        temps: [],
      },
      new Set(archive.copies.map((c) => c.path)),
    );
    expect(report.kept.map((k) => k.path)).toEqual([L.pinnedCopy]);
    expect(report.kept_gone).toEqual(L.signalTwoCopies);
    expect(report.surfaces.map((s) => [s.surface, s.kept])).toEqual([
      ["pinned_context", 1],
      ["signals", 0],
    ]);
  });

  test.each([
    ["a sole copy", ["Sole"], { imported: 1, identical: 0, kept: 0 }],
    ["identical copies", ["Same", "Same"], { imported: 1, identical: 1, kept: 0 }],
    ["differing copies", ["Here", "There"], { imported: 0, identical: 0, kept: 2 }],
  ] as const)("copies of a signal whose page is gone: %s", (_case, principles, expected) => {
    bench = plantedBench();
    const id = "sig-2026-10-01-fact-orphan-1";
    const copies = principles.map(
      (_, i) => `Brain/inbox/${id}.sync-conflict-2026100${i + 1}-120000-QFQZVF3.md`,
    );
    principles.forEach((principle, i) =>
      bench!.fx.write(
        copies[i]!,
        `---\nid: ${id}\ntopic: fact\nprinciple: ${principle}\nagent: "@a"\n---\nRaw.\n`,
      ),
    );
    const planned = planMigrationDryRun(bench.vault).sync_copies;
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    // The planted fixture's own signal copies: one identical, two kept.
    const base = { imported: 0, identical: 1, kept: 2 };
    const want = {
      imported: base.imported + expected.imported,
      identical: base.identical + expected.identical,
      kept: base.kept + expected.kept,
    };
    expect(signalCounts(result.sync_copies)).toEqual(want);
    expect(signalCounts(planned)).toEqual(want);
    const records = copies.filter((rel) => bench!.byKey().has(rel));
    expect(records.length).toBe(expected.imported);
  });

  test("a copy whose original cannot be looked at is kept, never imported as the original", () => {
    bench = plantedBench();
    const id = "sig-2026-10-02-fact-unseen-1";
    const original = join(bench.vault, "Brain", "inbox", `${id}.md`);
    const copy = `Brain/inbox/${id}.sync-conflict-20261002-120000-QFQZVF3.md`;
    bench.fx.write(
      copy,
      `---\nid: ${id}\ntopic: fact\nprinciple: Unseen\nagent: "@a"\n---\nRaw.\n`,
    );
    const real = fs.lstatSync;
    // The original's folder entry cannot be looked at (a permission, an I/O error).
    const spy = spyOn(fs, "lstatSync").mockImplementation(((
      path: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (path === original)
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync);
    try {
      const result = runMigration(bench.vault, FAST);
      expect(result.ok).toBe(true);
      expect(bench.byKey().has(copy)).toBe(false);
      const kept = result.sync_copies.kept.find((k) => k.path === copy);
      expect(kept?.reason).toContain("EACCES");
    } finally {
      spy.mockRestore();
    }
  });

  test("a copy sync removes between its copy and its check is dropped, a mismatch still fails", () => {
    bench = plantedBench();
    const dir = migrationDir(bench.store());
    const [gone, stays] = L.signalTwoCopies;
    const goneSource = join(bench.vault, ...gone!.split("/"));
    const real = fs.copyFileSync;
    // Sync removes the first copy right after the backup copied it.
    const spy = spyOn(fs, "copyFileSync").mockImplementation(((
      src: fs.PathLike,
      dst: fs.PathLike,
    ) => {
      real(src, dst);
      if (src === goneSource) rmSync(goneSource);
    }) as typeof fs.copyFileSync);
    try {
      const archive = archiveSyncCopies(bench.vault, dir, [keptCopy(gone!), keptCopy(stays!)])!;
      expect(archive.copies.map((c) => c.path)).toEqual([stays!]);
      expect(existsSync(join(archive.dir, ...gone!.split("/")))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // Both files there but different: still an error.
    const changing = join(bench.vault, ...stays!.split("/"));
    const again = spyOn(fs, "copyFileSync").mockImplementation(((
      src: fs.PathLike,
      dst: fs.PathLike,
    ) => {
      real(src, dst);
      if (src === changing) writeFileSync(changing, "changed under the backup\n");
    }) as typeof fs.copyFileSync);
    try {
      expect(() => archiveSyncCopies(bench!.vault, dir, [keptCopy(stays!)])).toThrow(
        /does not match/,
      );
    } finally {
      again.mockRestore();
    }
  });

  test("below local reach the advice names no copy, no count and no archive", () => {
    bench = plantedBench();
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    const ctx: DoctorCheckContext = {
      vault: bench.vault,
      now: new Date(),
      config: undefined,
      dbPath: undefined,
      configPath: undefined,
      knownBasenames: new Set(),
      idIndex: new Map(),
      preferences: [],
      logs: [],
      reach: TRANSPORT_REACH.remote,
    };
    const out: DoctorFindings = { issues: [], uncertain: [] };
    migrationCheck.run(ctx, out);
    const advice = out.uncertain.filter((u) => u.code === SYNC_COPIES_KEPT_CODE);
    expect(advice).toHaveLength(1);
    const text = JSON.stringify(advice[0]);
    for (const kept of result.sync_copies.kept) expect(text).not.toContain(kept.path);
    expect(text).not.toContain(result.sync_copies_archive!);
    expect(text).not.toContain(String(result.sync_copies.kept.length));
  });

  test("a temp file that becomes the real file between passes is imported by the delta pass", () => {
    bench = plantedBench();
    const real = join(bench.vault, L.tempBecomes);
    let renamed = false;
    const result = runMigration(bench.vault, {
      ...FAST,
      hooks: {
        afterItemAppended: () => {
          if (renamed) return;
          renamed = true;
          renameSync(join(bench!.vault, L.temp), real);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.passes).toBeGreaterThan(1);
    expect(readFileSync(real, "utf8")).toBe(TEMP_SIGNAL);
    expect(bench.byKey().get(L.tempBecomes)).toHaveLength(1);
    expect(result.sync_copies.temps).toEqual([]);
  });

  test("a run killed after a copy's row is appended resumes without importing it twice", () => {
    // How many items a clean run imports: the copies come last in a pass,
    // so the kill lands on the last item, a conflict copy's own row.
    const twin = plantedBench();
    const total = runMigration(twin.vault, FAST).imported;
    twin.cleanup();
    bench = plantedBench();
    const child = Bun.spawnSync(
      [process.execPath, "run", KILL_CHILD, "migrate", bench.vault, String(total)],
      { env: { ...process.env, ...bench.env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    expect(child.success).toBe(false);
    expect(child.exitCode).not.toBe(3);
    resetFreezeMarkerCache();
    const result = runMigration(bench.vault, { ...FAST, resume: true });
    expect(result.ok).toBe(true);
    for (const [key, records] of bench.byKey()) expect([key, records.length]).toEqual([key, 1]);
    expect(auditRecords(bench.records(), "s-4")).toHaveLength(1);
    expect(logRecords(bench.records(), textOf(ROW_ONLY_IN_COPY))).toHaveLength(1);
  });
});

describe("after the switch", () => {
  test("a later machine importing the same copies adds no second record", () => {
    fleet = makeFleet(["dev-a", "dev-c"]);
    const a = fleet.machine("dev-a");
    const c = fleet.machine("dev-c");
    plantSyncLeftovers(a.write);
    plantSyncLeftovers(c.write);
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    fleet.syncStore("dev-a", "dev-c");
    fleet.syncVaultFile("dev-a", "dev-c", "Brain/vault-id.json");
    c.use();
    const later = runMigration(c.vault, FAST);
    expect(later.ok).toBe(true);
    expect(later.role).toBe("later");
    expect(logRecords(c.records(), textOf(ROW_ONLY_IN_COPY))).toHaveLength(1);
    for (const target of ["s-2", "s-4"]) expect(auditRecords(c.records(), target)).toHaveLength(1);
  });

  test("a copy that appears after the switch is imported by the transition, once", () => {
    bench = makeMigrationBench("osb-sync-copies-");
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const store = bench.store();
    plantSyncLeftovers(bench.fx.write);
    const first = importLateLegacyWrites(bench.vault, store, "t", null);
    expect(first.converged).toBe(true);
    expect(logRecords(bench.records(), textOf(ROW_ONLY_IN_COPY))).toHaveLength(1);
    expect(auditRecords(bench.records(), "s-4")).toHaveLength(1);
    const again = importLateLegacyWrites(bench.vault, store, "t", null);
    expect(again.imported).toBe(0);
    expect(logRecords(bench.records(), textOf(ROW_ONLY_IN_COPY))).toHaveLength(1);
  });

  test("the rollback restores every copy byte for byte and writes no copy row into its original", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    plantSyncLeftovers(a.write);
    a.use();
    const before = new Map(
      [L.logShard, L.logCopy, L.auditShardB, L.auditCopyB, L.pinnedCopy, ...L.signalTwoCopies].map(
        (rel) => [rel, readFileSync(join(a.vault, ...rel.split("/")))],
      ),
    );
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    for (const [rel, bytes] of before) {
      expect([rel, readFileSync(join(a.vault, ...rel.split("/"))).equals(bytes)]).toEqual([
        rel,
        true,
      ]);
    }
  });

  test("the rollback writes back no row a restored copy holds that a dual write had stored", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    plantSyncLeftovers(a.write);
    a.use();
    const prior = process.env[STORE_DUAL_WRITE_ENV];
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    try {
      appendLogEvent(a.vault, {
        timestamp: "2026-11-03T10:00:00Z",
        eventType: "note",
        agent: "@dw",
        body: { text: "dual written, then only in the copy" },
      });
    } finally {
      if (prior === undefined) delete process.env[STORE_DUAL_WRITE_ENV];
      else process.env[STORE_DUAL_WRITE_ENV] = prior;
    }
    // Sync left the row only in a conflict copy of its shard.
    const logDir = join(a.vault, "Brain", "log");
    const shard = readdirSync(logDir).find(
      (name) =>
        name.endsWith(".jsonl") &&
        readFileSync(join(logDir, name), "utf8").includes("then only in the copy"),
    )!;
    const lines = readFileSync(join(logDir, shard), "utf8").split("\n");
    const row = lines.find((l) => l.includes("then only in the copy"))!;
    writeFileSync(join(logDir, shard), lines.filter((l) => l !== row).join("\n"));
    const copy = shard.replace(/\.jsonl$/, ".sync-conflict-20261103-100000-ABCDEFG.jsonl");
    writeFileSync(join(logDir, copy), `${row}\n`);

    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    const holding = readdirSync(logDir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(logDir, name), "utf8")
          .split("\n")
          .filter((l) => l.includes("then only in the copy"))
          .map(() => name),
      );
    expect(holding).toEqual([copy]);
  });

  test("the rollback writes no page back for a signal only a conflict copy holds", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    plantSyncLeftovers(a.write);
    a.use();
    const prior = process.env[STORE_DUAL_WRITE_ENV];
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    let page: string;
    try {
      page = writeSignal(a.vault, {
        topic: "orphan",
        signal: "positive",
        agent: "@dw",
        principle: "Only a copy holds me",
        created_at: "2026-11-03T10:00:00Z",
        date: "2026-11-03",
        slug: "orphan-copy",
      }).path;
    } finally {
      if (prior === undefined) delete process.env[STORE_DUAL_WRITE_ENV];
      else process.env[STORE_DUAL_WRITE_ENV] = prior;
    }
    // Sync left the signal only under a conflict copy's name.
    const copy = page.replace(/\.md$/, ".sync-conflict-20261103-100000-ABCDEFG.md");
    renameSync(page, copy);
    const before = readFileSync(copy);

    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    expect(readFileSync(copy).equals(before)).toBe(true);
    // The copy is the tree's one occurrence of it: no page written back.
    expect(existsSync(page)).toBe(false);
  });

  test("the rollback over an identical copy keeps the page and the copy, one each", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    plantSyncLeftovers(a.write);
    a.use();
    const signal = join(a.vault, ...L.signalSame.split("/"));
    const copy = join(a.vault, ...L.signalSameCopy.split("/"));
    const [pageBytes, copyBytes] = [readFileSync(signal), readFileSync(copy)];
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    expect(readFileSync(signal).equals(pageBytes)).toBe(true);
    expect(readFileSync(copy).equals(copyBytes)).toBe(true);
    const inbox = readdirSync(join(a.vault, "Brain", "inbox")).filter((n) =>
      n.startsWith("sig-2026-08-05-fact-url-3"),
    );
    expect(inbox.toSorted()).toEqual(
      [L.signalSame, L.signalSameCopy].map((rel) => rel.split("/").at(-1)!).toSorted(),
    );
  });

  test("the removal moves the copies to the archive with the tree, temp files never block it", () => {
    bench = plantedBench();
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const removed = removeLegacyTree(bench.vault, bench.store(), { agent: "t", force: true });
    expect(removed.removed).toBe(true);
    if (!removed.removed) return;
    for (const rel of [L.logCopy, L.pinnedCopy, ...L.signalTwoCopies, L.temp]) {
      expect(existsSync(join(bench.vault, ...rel.split("/")))).toBe(false);
      expect([rel, existsSync(join(removed.archive, ...rel.split("/")))]).toEqual([rel, true]);
    }
    for (const [key, records] of bench.byKey()) expect([key, records.length]).toEqual([key, 1]);
  });
});
