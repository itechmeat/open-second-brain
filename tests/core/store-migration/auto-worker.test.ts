/**
 * The automatic store migration worker (change auto-store-migration,
 * design D3): what one attempt does on this machine, in the process the
 * detection step spawns (here: in-process, the same entry point).
 *
 * Covered: a clean run, the opt-out, a fresh install with no legacy data,
 * an unmapped legacy entry, unparseable items, a store root inside the
 * vault, the refusals before a store is created, failures before and after
 * the backup, during convert and verify, after a completion record and
 * after the switch record, an unwritable failure record, the busy gate,
 * the waiting outcome of a later machine and of a store another device
 * created, the privacy of the imported records and of what the records
 * carry, and a start on a machine that already switched leaving no trace.
 * Every step boundary under a throw and a real kill is the failure table's
 * (`auto-failure-table-*.test.ts`).
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  holdMigrationGate,
  migrationGatePath,
  readMigrationGate,
  releaseMigrationGate,
} from "../../../src/core/migration-gate.ts";
import {
  vaultBindingPath,
  vaultBindingStatus,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { readViewWriter } from "../../../src/core/view/writer.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { deviceSwitchedHere } from "../../../src/core/store/store-only.ts";
import { holdsLegacyData } from "../../../src/core/store/legacy-tree.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runStateOf } from "./fixtures/run-state.ts";
import {
  MIGRATION_DONE_KIND,
  MIGRATION_STREAM,
} from "../../../src/core/store-migration/migration-records.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  AUTO_MIGRATION_SURFACE,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import {
  autoMigrationBackoffActive,
  autoMigrationLockPath,
  autoMigrationStatePath,
  readAutoMigrationFailure,
  readAutoMigrationNotice,
  readAutoMigrationWaiting,
} from "../../../src/core/store-migration/auto-state.ts";
import { migrateStore, rollback } from "../../../src/core/store-migration/outcome.ts";
import * as autoState from "../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_STATE,
  autoMigrationReport,
} from "../../../src/core/store-migration/auto-report.ts";
import {
  AUTO_MIGRATION_SPAWN,
  AUTO_MIGRATION_START,
  planAutoMigrationStart,
} from "../../../src/core/maintenance/ensure-current.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { MIGRATION_AVAILABLE_CODE } from "../../../src/core/brain/doctor/migration-check.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import {
  collectRuntimeNotices,
  renderRuntimeNotices,
} from "../../../src/core/brain/runtime-notices.ts";
import {
  describeUpdateStoreMigration,
  UPDATE_STORE_MIGRATION,
  updateStoreMigration,
} from "../../../src/core/store-migration/update-step.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import {
  BENCH_DEVICE,
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

const KILL_CHILD = join(import.meta.dir, "fixtures", "kill-child.ts");

/** The command that finishes a rollback, as every surface names it. */
const ROLLBACK_COMMAND = "o2b brain migrate-store --rollback";

/** How a switched machine's surfaces name the plain command that stays on the store. */
const STAY_ON_STORE = "`o2b brain migrate-store` to end it and stay on the brain store";

/**
 * The worker with no settle wait: no writer is in flight in these tests,
 * and the wait is a fixed sleep per migration. A test's own options win.
 */
function autoRun(
  vault: string,
  opts: Parameters<typeof runAutoStoreMigration>[1] = {},
): ReturnType<typeof runAutoStoreMigration> {
  return runAutoStoreMigration(vault, { settleMs: 0, ...opts });
}

/** A legacy log line that is no migration mark. */
const NOTE_LINE = JSON.stringify({ ts: "2026-11-17T10:00:00Z", kind: "note", payload: { t: "x" } });

/** The pid of a process that ran and is gone. */
function deadPid(): number {
  return Bun.spawnSync([process.execPath, "-e", "0"], { stdin: "ignore" }).pid;
}

/** The migration snapshots in the vault's snapshot folder (run ids). */
function migrationSnapshots(): string[] {
  const dir = join(bench.vault, "Brain", ".snapshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith("store-migration-") && !n.endsWith(".json"))
    .map((n) => n.replace(/\.tar(\.\w+)?$/, ""))
    .toSorted();
}

/** A bench with no store yet: the automatic migration would create it. */
function benchWithoutStore(): void {
  bench.cleanup();
  bench = makeMigrationBench("osb-migrate-", { withStore: false });
  dropUnparseable(bench.vault);
}

/** Put the fixture's unparseable line back (the bench drops it). */
function makeMigrationBenchUnparseable(): void {
  writeFileSync(
    join(bench.vault, "Brain", "log", "2026-11-01.dev-b.jsonl"),
    '{"ts":"2026-11-01T10:00:00Z","kind":"note","payload":{"text":"ok"}}\n{torn line\n',
  );
}

// The killed-run test spawns a child; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(60_000);

/** The suite's preload turns the automatic migration off; these tests run it. */
const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
let savedAuto: string | undefined;

let bench: MigrationBench;
beforeEach(() => {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench();
  dropUnparseable(bench.vault);
});
afterEach(() => {
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

describe("a clean automatic run", () => {
  test("switches the machine and records the log line, the row and the notice", () => {
    const run = autoRun(bench.vault);

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(run.imported).toBeGreaterThan(0);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    // No failure and no waiting state left behind.
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readAutoMigrationWaiting(bench.vault)).toBeNull();
    // One metrics row for the attempt.
    const rows = listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload["outcome"]).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // One line in the brain log.
    expect(
      bench
        .records()
        .some((r) => r.kind === "log-event" && r.body["event_type"] === "store-migration-done"),
    ).toBe(true);
    // The one-time notice carries the snapshot and the rollback command.
    forgetMachineStateCache();
    const notice = readAutoMigrationNotice(bench.vault);
    expect(notice?.snapshot).toMatch(/^store-migration-/);
    expect(notice?.rollbackCommand).toBe("o2b brain migrate-store --rollback");
    // The legacy tree stays for machines still on an older release: its
    // removal is the explicit `--remove-legacy` with its cohort rule.
    expect(holdsLegacyData(join(bench.vault, "Brain"))).toBe(true);
  });

  test("keeps private records in the private partition", () => {
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // The fixture's private preference stayed private.
    const secret = bench.byKey().get("Brain/preferences/pref-secret.md")?.[0];
    expect(secret?.partition).toBe("private");
  });

  test("a machine that holds only shared never receives the private records", () => {
    // A machine that never held `private`: the partition never synced here.
    moveNeverHeld(bench.storeRoot, join(bench.fx.parent, "private-aside"));

    const run = autoRun(bench.vault);

    // The migrator cannot place the private items here, so verification
    // finds them missing and the attempt fails, the machine unswitched
    // (the manual command answers the same); it never places them in `shared`.
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(run.error).toContain("not in the store");
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    // No private item reached `shared`.
    const leaked = readPartition(join(bench.storeRoot, "shared")).flatMap((shard) =>
      shard.all.filter((r) => JSON.stringify(r.body).includes("pref-secret")),
    );
    expect(leaked).toEqual([]);
  });

  test("leaves no trace on a second start after the switch", () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    forgetMachineStateCache();
    const rows = listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE }).length;
    const records = bench.records().length;

    const again = autoRun(bench.vault);

    expect(again.outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    // One place on every layout: nothing left there, and nothing of the
    // automatic migration in the vault either.
    expect(existsSync(autoMigrationLockPath(bench.vault))).toBe(false);
    const derived = join(bench.vault, ".open-second-brain");
    const leftInVault = existsSync(derived)
      ? readdirSync(derived, { recursive: true }).filter((n) =>
          String(n).includes("auto-store-migration"),
        )
      : [];
    expect(leftInVault).toEqual([]);
    expect(existsSync(autoMigrationStatePath(bench.vault))).toBe(false);
    expect(listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE })).toHaveLength(rows);
    expect(bench.records()).toHaveLength(records);
  });
});

describe("the opt-out and the fresh install", () => {
  test("an opted-out machine never runs and writes nothing", () => {
    process.env[AUTO_ENV] = "false";

    const run = autoRun(bench.vault);

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.disabled);
    expect(bench.records()).toHaveLength(0);
    expect(existsSync(autoMigrationStatePath(bench.vault))).toBe(false);
  });

  test("a vault with no legacy data: the worker answers not needed and creates nothing", () => {
    // A fresh install: bootstrapped brain files only, no store on disk yet.
    const root = mkdtempSync(join(tmpdir(), "osb-auto-fresh-"));
    const vault = join(root, "vault");
    const storeRoot = join(root, "store");
    const configPath = join(root, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    const savedStoreRoot = process.env[STORE_ROOT_ENV];
    process.env[STORE_ROOT_ENV] = storeRoot;
    try {
      bootstrapBrain(vault, { configPath });
      const run = autoRun(vault, { configPath });
      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
      // The worker never created a store, a lock or a state record.
      expect(existsSync(storeRoot)).toBe(false);
      expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
      expect(existsSync(autoMigrationStatePath(vault))).toBe(false);
    } finally {
      if (savedStoreRoot === undefined) delete process.env[STORE_ROOT_ENV];
      else process.env[STORE_ROOT_ENV] = savedStoreRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the dry-run gate", () => {
  test("an unmapped legacy entry stops the attempt before anything is written", () => {
    writeFileSync(join(bench.vault, "Brain", "log", "stray.txt"), "no mapping covers this\n");

    const run = autoRun(bench.vault);

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.error).toContain("no destination");
    expect(run.manualCommand).toBe("o2b brain migrate-store --dry-run");
    // Nothing was written: no store records, no switch.
    expect(bench.records()).toHaveLength(0);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    const failure = readAutoMigrationFailure(bench.vault);
    expect(failure?.state).toBe("failed");
    expect(failure?.error).toContain("no destination");
  });

  test("a store root inside the vault refuses with the reason", () => {
    const prior = process.env[STORE_ROOT_ENV];
    process.env[STORE_ROOT_ENV] = join(bench.vault, "Brain", "store");
    try {
      const run = autoRun(bench.vault);
      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
      expect(run.error).toContain("inside the vault");
      expect(bench.records()).toHaveLength(0);
      expect(existsSync(join(bench.vault, "Brain", "store"))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env[STORE_ROOT_ENV];
      else process.env[STORE_ROOT_ENV] = prior;
    }
  });
});

describe("the failure points of an attempt", () => {
  test("a snapshot failure before the backup leaves the machine legacy with the gate open", () => {
    // The snapshot writes into Brain/.snapshots/; a file there refuses it.
    rmSync(join(bench.vault, "Brain", ".snapshots"), { force: true, recursive: true });
    writeFileSync(join(bench.vault, "Brain", ".snapshots"), "not a directory\n");

    const run = autoRun(bench.vault);

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(run.error).toContain(".snapshots");
    expect(readMigrationGate()).toBeNull();
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("failed");
    const failure = readAutoMigrationFailure(bench.vault);
    expect(failure?.manualCommand).toBe("o2b brain migrate-store");
  });

  test("a failure after the backup leaves the verified backup; the resume reuses it", () => {
    const run = autoRun(bench.vault, {
      hooks: {
        afterBackup: () => {
          throw new Error("fault injection: after backup");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(run.error).toContain("after backup");
    expect(readMigrationGate()).toBeNull();
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(runStateOf(migrationDir(bench.store()))?.backed_up).toBe(true);
    const snapshots = migrationSnapshots();
    expect(snapshots).toHaveLength(1);
    // The next attempt reuses the backup instead of taking another.
    const second = autoRun(bench.vault);
    expect(second.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(migrationSnapshots()).toEqual(snapshots);
    expect(readAutoMigrationNotice(bench.vault)?.snapshot).toBe(snapshots[0]!);
  });

  test("failed runs that each took a backup keep one backup copy, not one per attempt", () => {
    // Verification fails after the backups on a machine without `private`
    // (the run ends `failed`, not interrupted), so each retry takes a new
    // backup; the copies of the earlier ones are dropped.
    moveNeverHeld(bench.storeRoot, join(bench.fx.parent, "private-aside"));
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    }
    const copies = readdirSync(join(migrationDir(bench.store()), "backup", "snapshot"));
    expect(copies).toHaveLength(1);
  });

  test("a failure during convert leaves an interrupted run the next attempt resumes", () => {
    const run = autoRun(bench.vault, {
      hooks: {
        afterItemAppended: (imported: number) => {
          if (imported === 3) throw new Error("fault injection: during convert");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(readMigrationGate()).toBeNull();
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("in-progress");

    const second = autoRun(bench.vault);
    expect(second.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // Nothing was imported twice.
    for (const [key, records] of bench.byKey()) {
      const parts = new Set(records.map((r) => (r.body["migrated"] as { part: number }).part));
      expect([key, records.length]).toEqual([key, parts.size]);
    }
  });

  test("a failure during verify leaves the machine legacy; the resume re-verifies", () => {
    const run = autoRun(bench.vault, {
      hooks: {
        beforeVerify: () => {
          throw new Error("fault injection: during verify");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(readMigrationGate()).toBeNull();
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    const second = autoRun(bench.vault);
    expect(second.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
  });

  test("a migration killed mid-run by hand is resumed by the automatic attempt, and imports once", () => {
    const child = Bun.spawnSync(
      [process.execPath, "run", KILL_CHILD, "migrate", bench.vault, "5"],
      {
        env: { ...process.env, ...bench.env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    expect(child.success).toBe(false);
    if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");

    // The gate the kill left is held; the next attempt takes it over and
    // resumes the interrupted run.
    expect(readMigrationGate()).not.toBeNull();
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(readMigrationGate()).toBeNull();
    for (const [key, records] of bench.byKey()) {
      const parts = new Set(records.map((r) => (r.body["migrated"] as { part: number }).part));
      expect([key, records.length]).toEqual([key, parts.size]);
    }
  });

  test("a throw after a completion record and before the switch: the next attempt reuses the record", () => {
    // Plant the state a kill in that window leaves: every item imported,
    // the completion record written, the run still in-progress, and the
    // machine not switched. The hook fires after the last delta pass, so
    // the planted record sits where the run's own would have gone.
    const run = autoRun(bench.vault, {
      hooks: {
        beforeVerify: () => {
          appendRecord(bench.store(), {
            partition: "shared",
            stream: MIGRATION_STREAM,
            kind: MIGRATION_DONE_KIND,
            agent: "test",
            body: {
              authority: "human",
              vault_id: null,
              device: BENCH_DEVICE,
              cuts: {},
              imported: 0,
            },
          });
          throw new Error("fault injection: after migration-done");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(bench.records().filter((r) => r.kind === MIGRATION_DONE_KIND)).toHaveLength(1);

    const second = autoRun(bench.vault);
    expect(second.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // The planted completion record was reused, not duplicated.
    expect(bench.records().filter((r) => r.kind === MIGRATION_DONE_KIND)).toHaveLength(1);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
  });
});

describe("a manual migration after a failed automatic attempt", () => {
  test("leaves no stale failure on the switched machine", () => {
    writeFileSync(join(bench.vault, "Brain", "log", "stray.txt"), "no mapping covers this\n");
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(readAutoMigrationFailure(bench.vault)).not.toBeNull();

    // The operator fixes the stray entry and migrates by hand.
    rmSync(join(bench.vault, "Brain", "log", "stray.txt"));
    const manual = migrateStore(bench.vault, {});
    expect(manual.ok).toBe(true);
    forgetMachineStateCache();

    // The report already says done, and the next start drops the moot
    // record without announcing anything (the switch was not its own).
    expect(autoMigrationReport({ vault: bench.vault }).state).toBe("done");
    const next = autoRun(bench.vault);
    expect(next.outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readAutoMigrationNotice(bench.vault)).toBeNull();
  });
});

describe("a large install", () => {
  /** Notes of the operator's own, outside the brain: tens of thousands. */
  const NOTE_FOLDERS = 20;
  const NOTES_PER_FOLDER = 1000;

  test("tens of thousands of vault notes are neither walked as legacy data nor moved", () => {
    for (let f = 0; f < NOTE_FOLDERS; f++) {
      const folder = join(bench.vault, "Notes", `folder-${f}`);
      mkdirSync(folder, { recursive: true });
      for (let n = 0; n < NOTES_PER_FOLDER; n++) {
        writeFileSync(join(folder, `note-${n}.md`), `# Note ${n}\n`);
      }
    }

    const run = autoRun(bench.vault);

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // Only the brain moved: no record names a note, and every note stays.
    expect(bench.records().some((r) => JSON.stringify(r.body).includes("Notes/folder-"))).toBe(
      false,
    );
    expect(readdirSync(join(bench.vault, "Notes", `folder-${NOTE_FOLDERS - 1}`))).toHaveLength(
      NOTES_PER_FOLDER,
    );
  });
});

describe("a busy gate", () => {
  test("another live migration on this machine starts nothing and records no failure", () => {
    holdMigrationGate(bench.vault, "manual-run");
    try {
      const run = autoRun(bench.vault);
      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.running);
      expect(readAutoMigrationFailure(bench.vault)).toBeNull();
      expect(bench.records()).toHaveLength(0);
    } finally {
      releaseMigrationGate(bench.vault, "manual-run");
    }
  });
});

describe("a later machine", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.cleanup();
    fleet = null;
  });

  test("records waiting, no failure, and succeeds once the cut arrives", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    dropUnparseable(a.vault);
    dropUnparseable(b.vault);
    const first = autoRun(a.vault);
    expect(first.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // Only the vault marker and the settings shard (with migration-done)
    // have synced so far; the events and log shards have not.
    fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
    fleet.syncStore("dev-a", "dev-b", (rel) => !rel.includes("/events/") && !rel.includes("/log/"));

    b.use();
    const waiting = autoRun(b.vault);
    expect(waiting.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(waiting.wait?.firstMachines).toEqual(["dev-a"]);
    expect(waiting.wait?.missing.some((m: string) => m.startsWith("shared/events/dev-a/"))).toBe(
      true,
    );
    const record = readAutoMigrationWaiting(b.vault);
    expect(record?.state).toBe("waiting");
    expect(readAutoMigrationFailure(b.vault)).toBeNull();
    expect(deviceSwitchedHere(b.store(), "dev-b")).toBe(false);

    // The cut arrives; the next start runs the migration.
    fleet.syncStore("dev-a", "dev-b");
    const done = autoRun(b.vault);
    expect(done.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(deviceSwitchedHere(b.store(), "dev-b")).toBe(true);
    expect(readAutoMigrationWaiting(b.vault)).toBeNull();
  });
});

describe("a failure after the switch record", () => {
  test("is finished by the next attempt: bound, view writer claimed, gate open, announced", () => {
    // The vault binding cannot be written: a directory sits at its path.
    // The run fails after `device-switched` and the sticky switch marker.
    mkdirSync(vaultBindingPath(), { recursive: true });
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("in-progress");
    expect(readMigrationGate()).toBeNull();

    // The cause goes away; the next start's attempt finishes the switch.
    rmSync(vaultBindingPath(), { recursive: true, force: true });
    const next = autoRun(bench.vault);

    expect(next.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("done");
    expect(vaultBindingStatus(bench.vault).state).toBe("match");
    expect(readViewWriter(bench.store()).writer).toBe(BENCH_DEVICE);
    expect(readMigrationGate()).toBeNull();
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readAutoMigrationNotice(bench.vault)).not.toBeNull();
    // And a further start finds nothing left to do and leaves no trace.
    const rows = listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE }).length;
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    expect(listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE })).toHaveLength(rows);
  });
});

function successLines(): number {
  return bench
    .records()
    .filter((r) => r.kind === "log-event" && r.body["event_type"] === "store-migration-done")
    .length;
}
function appliedRows(): number {
  return listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE }).filter(
    (r) => r.payload["outcome"] === AUTO_MIGRATION_OUTCOME.applied,
  ).length;
}

describe("the success records", () => {
  for (const failing of ["the clear", "the notice and the clear"] as const) {
    test(`are written once when ${failing} failed and a second pass writes what is left`, () => {
      const clear = spyOn(autoState, "clearAutoMigrationState").mockImplementation(() => {
        throw new Error("fault injection: the disk is full");
      });
      const notice =
        failing === "the notice and the clear"
          ? spyOn(autoState, "recordAutoMigrationNotice").mockImplementation(() => {
              throw new Error("fault injection: the disk is full");
            })
          : null;
      try {
        expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
      } finally {
        clear.mockRestore();
        notice?.mockRestore();
      }
      expect(successLines()).toBe(1);
      expect(appliedRows()).toBe(1);
      // The attempt's record survived the failed clear: the next start finishes.
      expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);
      autoRun(bench.vault);
      expect(successLines()).toBe(1);
      expect(appliedRows()).toBe(1);
      expect(readAutoMigrationFailure(bench.vault)).toBeNull();
      expect(readAutoMigrationNotice(bench.vault)).not.toBeNull();
      // And nothing more after that.
      autoRun(bench.vault);
      expect(successLines()).toBe(1);
      expect(appliedRows()).toBe(1);
    });
  }
});

describe("the opt-out switched off after an attempt switched the machine", () => {
  test("the switch is finished whatever the setting says; the report says so", () => {
    mkdirSync(vaultBindingPath(), { recursive: true });
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    rmSync(vaultBindingPath(), { recursive: true, force: true });
    process.env[AUTO_ENV] = "false";

    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.nextStart).toBe("finishes the switch in the background");
    expect(report.automatic).toBe(true);
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), true)).toBe(
      AUTO_MIGRATION_START,
    );
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("done");
    expect(vaultBindingStatus(bench.vault).state).toBe("match");
    expect(readMigrationGate()).toBeNull();
  });
});

function migrateAndRollBack(): void {
  expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  rollback(bench.vault);
  expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
}

describe("a machine the operator rolled back", () => {
  test("the worker, the start and the report leave it rolled back", () => {
    migrateAndRollBack();
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.rolledBack);
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), false)).toBe(
      AUTO_MIGRATION_SPAWN.rolledBack,
    );
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).toBe(AUTO_MIGRATION_STATE.rolledBack);
    expect(report.automatic).toBe(false);
    expect(report.nextStart).toContain("does not redo a rollback");
    expect(report.manualCommand).toContain("o2b brain migrate-store");
    const block = buildStoreStatusBlock({ vault: bench.vault, configPath: null });
    const automatic = (block["migration"] as { automatic: Record<string, unknown> }).automatic;
    expect(automatic["state"]).toBe("rolled_back");
    expect(String(automatic["next_start"])).toContain("does not redo a rollback");
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
  });

  test("the doctor says it was rolled back, never that the automatic migration is off", () => {
    migrateAndRollBack();
    for (const setting of ["true", "false"]) {
      process.env[AUTO_ENV] = setting;
      const result = runDoctor(bench.vault, { now: new Date() });
      const finding = [...result.warnings, ...(result.uncertain ?? [])].find(
        (f) => f.code === MIGRATION_AVAILABLE_CODE,
      );
      expect([setting, finding?.message ?? ""]).toEqual([
        setting,
        expect.stringContaining("rolled back to the legacy layout"),
      ]);
      expect([setting, finding?.message.includes("is off on this machine")]).toEqual([
        setting,
        false,
      ]);
    }
  });

  test("a gate its finished rollback could not release is opened by the next start, whatever the setting", () => {
    for (const setting of ["true", "false"]) {
      process.env[AUTO_ENV] = "true";
      migrateAndRollBack();
      process.env[AUTO_ENV] = setting;
      const snapshots = migrationSnapshots();
      const runId = runStateOf(migrationDir(bench.store()))!.run_id;
      // The rollback finished every write; its release met a busy gate
      // lock, so its gate stays, its holder gone.
      const path = migrationGatePath();
      mkdirSync(dirname(path), { recursive: true });
      atomicWriteFileSync(
        path,
        JSON.stringify({
          vault: resolve(bench.vault),
          run_id: `rollback-${runId}`,
          since: new Date().toISOString(),
          pid: deadPid(),
        }),
      );
      forgetMachineStateCache();
      const report = autoMigrationReport({ vault: bench.vault });
      expect([setting, report.state]).toEqual([setting, AUTO_MIGRATION_STATE.failed]);
      expect([setting, report.nextStart]).toEqual([
        setting,
        "opens the stopped run's gate in the background, and migrates nothing",
      ]);
      expect([setting, report.manualCommand]).toEqual([
        setting,
        "o2b brain migrate-store --force-release-gate",
      ]);
      expect(planAutoMigrationStart(bench.vault, undefined, new Date(), false)).toBe(
        AUTO_MIGRATION_START,
      );

      expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.rolledBack);
      expect(readMigrationGate()).toBeNull();
      expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
      expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("rolled-back");
      expect(migrationSnapshots()).toEqual(snapshots);
      forgetMachineStateCache();
      expect(autoMigrationReport({ vault: bench.vault }).state).toBe(
        AUTO_MIGRATION_STATE.rolledBack,
      );
      // A fresh bench for the other setting.
      bench.cleanup();
      bench = makeMigrationBench();
      dropUnparseable(bench.vault);
    }
  });

  test("guard: the documented manual command migrates it again", () => {
    migrateAndRollBack();
    const outcome = migrateStore(bench.vault);
    expect(outcome.mode).toBe("migration");
    expect(outcome.mode === "migration" && outcome.ok).toBe(true);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(runStateOf(migrationDir(bench.store()))?.phase).toBe("done");
  });
});

describe("a rollback that failed after it cleared the switch", () => {
  test("no start migrates over it; every surface names the rollback, which then finishes", () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const snapshots = migrationSnapshots();
    const dir = migrationDir(bench.store());
    // A step after the switch is cleared fails (a full disk, a sharing
    // violation): the rollback throws, its gate is opened, its record stays.
    expect(() =>
      rollback(bench.vault, {
        hooks: {
          afterSwitchCleared: () => {
            throw new Error("the disk is full");
          },
        },
      }),
    ).toThrow("the disk is full");
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(runStateOf(dir)?.phase).toBe("done");
    expect(existsSync(join(dir, "rollback.json"))).toBe(true);
    expect(readMigrationGate()).toBeNull();

    // The start spawns the worker to record the refusal; nothing is migrated.
    forgetMachineStateCache();
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), false)).toBe(
      AUTO_MIGRATION_START,
    );
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.manualCommand).toBe(ROLLBACK_COMMAND);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(runStateOf(dir)?.phase).toBe("done");
    expect(migrationSnapshots()).toEqual(snapshots);
    // The refusal cools down: the next start does not spawn again at once.
    forgetMachineStateCache();
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), false)).toBe(
      AUTO_MIGRATION_SPAWN.skippedBackoff,
    );

    // The report and the doctor name the command that finishes the rollback.
    forgetMachineStateCache();
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).toBe(AUTO_MIGRATION_STATE.failed);
    expect(report.manualCommand).toBe(ROLLBACK_COMMAND);
    expect(report.message).toContain("a rollback of this vault began and did not finish");
    const result = runDoctor(bench.vault, { now: new Date() });
    const said = [...result.warnings, ...(result.uncertain ?? [])].map((f) => f.message);
    expect(said).toEqual(expect.arrayContaining([expect.stringContaining(ROLLBACK_COMMAND)]));

    // Opted out, the report still names it.
    process.env[AUTO_ENV] = "false";
    forgetMachineStateCache();
    expect(autoMigrationReport({ vault: bench.vault }).manualCommand).toBe(ROLLBACK_COMMAND);
    process.env[AUTO_ENV] = "true";

    // The named command finishes the rollback.
    rollback(bench.vault);
    expect(runStateOf(dir)?.phase).toBe("rolled-back");
    expect(existsSync(join(dir, "rollback.json"))).toBe(false);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    forgetMachineStateCache();
    expect(autoMigrationReport({ vault: bench.vault }).state).toBe(AUTO_MIGRATION_STATE.rolledBack);
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.rolledBack);
    expect(migrationSnapshots()).toEqual(snapshots);
  });
});

describe("the manual migration over a rollback that did not finish", () => {
  test("migrates, as the operator asked, and ends the rollback's record", () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const dir = migrationDir(bench.store());
    expect(() =>
      rollback(bench.vault, {
        hooks: {
          afterSwitchCleared: () => {
            throw new Error("the disk is full");
          },
        },
      }),
    ).toThrow("the disk is full");
    const outcome = migrateStore(bench.vault);
    expect(outcome.mode === "migration" && outcome.ok).toBe(true);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(existsSync(join(dir, "rollback.json"))).toBe(false);
    expect(existsSync(join(dir, "rollback-journal.jsonl"))).toBe(false);
    // Nothing reads it as a rollback still to finish.
    forgetMachineStateCache();
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).toBe(AUTO_MIGRATION_STATE.done);
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), true)).toBeNull();
  });
});

describe("a rollback that failed before it cleared the switch", () => {
  test("every surface names both ways out; the plain migrate-store stays on the store and ends it", async () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const dir = migrationDir(bench.store());
    const snapshots = migrationSnapshots();
    // A record written after the switch, so the rollback has one to replay.
    appendRecord(bench.store(), {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id: "sig-after",
        path: "Brain/inbox/2026-11-19-after.md",
        staged: false,
        frontmatter: { id: "sig-after", topic: "after", principle: "Written after the switch" },
        raw: "After.",
      },
    });
    // The replay fails: the restore is done and recorded, the switch is
    // not cleared yet.
    expect(() =>
      rollback(bench.vault, {
        hooks: {
          afterReplayed: () => {
            throw new Error("the disk is full");
          },
        },
      }),
    ).toThrow("the disk is full");
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(runStateOf(dir)?.phase).toBe("done");
    expect(existsSync(join(dir, "rollback.json"))).toBe(true);
    expect(readMigrationGate()).toBeNull();

    // Every surface names the rollback's command and the plain one that
    // stays on the store: the report and the update before the worker
    // ran, the worker's record and the doctor after.
    forgetMachineStateCache();
    const before = autoMigrationReport({ vault: bench.vault });
    expect(before.state).toBe(AUTO_MIGRATION_STATE.failed);
    expect(before.manualCommand).toBe(ROLLBACK_COMMAND);
    expect([before.message, before.nextStart]).toEqual([
      expect.stringContaining(STAY_ON_STORE),
      expect.stringContaining("o2b brain migrate-store` to end it"),
    ]);
    const updateBefore = updateStoreMigration(bench.vault, { skip: false, dryRun: true });
    expect(updateBefore.outcome).toBe(UPDATE_STORE_MIGRATION.refused);
    expect(describeUpdateStoreMigration(updateBefore)).toContain(STAY_ON_STORE);
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.manualCommand).toBe(ROLLBACK_COMMAND);
    expect(readAutoMigrationFailure(bench.vault)?.error).toContain(STAY_ON_STORE);
    forgetMachineStateCache();
    expect(autoMigrationReport({ vault: bench.vault }).message).toContain(STAY_ON_STORE);
    const doctorBefore = runDoctor(bench.vault, { now: new Date() });
    expect(
      [...doctorBefore.warnings, ...(doctorBefore.uncertain ?? [])].map((f) => f.message),
    ).toEqual(expect.arrayContaining([expect.stringContaining(STAY_ON_STORE)]));
    // The session notice says nothing of a failure on a switched machine
    // (its wording for this answer is the answer table's row).
    expect(renderRuntimeNotices(collectRuntimeNotices(bench.vault))).not.toContain("rollback");

    // The operator stays on the store with the plain command.
    const manual = await runCli(["brain", "migrate-store", "--vault", bench.vault], {
      env: { ...bench.env, [AUTO_ENV]: "true" },
    });
    expect([manual.returncode, manual.stderr]).toEqual([0, ""]);
    forgetMachineStateCache();
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(existsSync(join(dir, "rollback.json"))).toBe(false);
    expect(existsSync(join(dir, "rollback-journal.jsonl"))).toBe(false);

    // Done, quiet, no surface mentions a rollback, and a start does nothing.
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).toBe(AUTO_MIGRATION_STATE.done);
    expect(JSON.stringify(report)).not.toContain("rollback");
    const doctor = runDoctor(bench.vault, { now: new Date() });
    const said = [...doctor.warnings, ...(doctor.uncertain ?? [])].filter(
      (f) => f.code === MIGRATION_AVAILABLE_CODE || f.message.includes("rollback"),
    );
    expect(said).toEqual([]);
    expect(renderRuntimeNotices(collectRuntimeNotices(bench.vault))).not.toContain("rollback");
    const update = updateStoreMigration(bench.vault, { skip: false, dryRun: true });
    expect(update.outcome).toBe(UPDATE_STORE_MIGRATION.notNeeded);
    expect(planAutoMigrationStart(bench.vault, undefined, new Date(), true)).toBeNull();
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(migrationSnapshots()).toEqual(snapshots);
  });

  test("a stopped rollback that still holds the gate is left to its own command", () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const dir = migrationDir(bench.store());
    appendRecord(bench.store(), {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id: "sig-after",
        path: "Brain/inbox/2026-11-19-after.md",
        staged: false,
        frontmatter: { id: "sig-after", topic: "after", principle: "Written after the switch" },
        raw: "After.",
      },
    });
    expect(() =>
      rollback(bench.vault, {
        hooks: {
          afterReplayed: () => {
            throw new Error("the disk is full");
          },
        },
      }),
    ).toThrow("the disk is full");
    // The rollback was killed instead: its gate stays, its holder gone.
    const runId = runStateOf(dir)!.run_id;
    const path = migrationGatePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(
      path,
      JSON.stringify({
        vault: resolve(bench.vault),
        run_id: `rollback-${runId}`,
        since: new Date().toISOString(),
        pid: deadPid(),
      }),
    );
    forgetMachineStateCache();

    // The plain command does not open that gate, so it does not end the
    // rollback either: the record stays, and the surfaces name only the
    // rollback's command.
    expect(migrateStore(bench.vault).mode).toBe("transition");
    expect(existsSync(join(dir, "rollback.json"))).toBe(true);
    forgetMachineStateCache();
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.manualCommand).toBe(ROLLBACK_COMMAND);
    expect(`${report.message} ${report.nextStart}`).not.toContain(STAY_ON_STORE);
  });
});

describe("a failure whose record cannot be written", () => {
  // Dropping the folder's write bit denies nothing to root or on Windows;
  // the case below makes the same fault without chmod.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "still ends failed, and the attempt's own record holds the next start off",
    () => {
      const stateDir = dirname(autoMigrationStatePath(bench.vault));
      let run: ReturnType<typeof runAutoStoreMigration>;
      try {
        run = autoRun(bench.vault, {
          hooks: {
            afterBackup: () => {
              // From here on nothing new can be written in the state folder.
              chmodSync(stateDir, 0o500);
              throw new Error("fault injection: after backup");
            },
          },
        });
      } finally {
        chmodSync(stateDir, 0o700);
      }
      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
      // The record the attempt wrote when it started is still there, with
      // the cooldown a failure starts.
      const failure = readAutoMigrationFailure(bench.vault);
      expect(failure?.attempt).toBe(true);
      expect(Date.parse(failure!.retryAfter)).toBeGreaterThan(Date.now());
      // The rule the start's spawner applies: no worker until it runs out.
      expect(autoMigrationBackoffActive(failure, new Date())).toBe(true);
    },
  );

  test("guard: the same, on every platform, the state folder is not a folder while the attempt fails", () => {
    const stateDir = dirname(autoMigrationStatePath(bench.vault));
    const aside = `${stateDir}.aside`;
    let run: ReturnType<typeof runAutoStoreMigration>;
    try {
      run = autoRun(bench.vault, {
        hooks: {
          afterBackup: () => {
            // The folder (with the attempt's own record) is moved aside and a
            // plain file takes its place: no write into it can land.
            renameSync(stateDir, aside);
            writeFileSync(stateDir, "not a folder");
            throw new Error("fault injection: after backup");
          },
        },
      });
    } finally {
      rmSync(stateDir, { force: true });
      if (existsSync(aside)) renameSync(aside, stateDir);
    }
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    const failure = readAutoMigrationFailure(bench.vault);
    expect(failure?.attempt).toBe(true);
    const now = new Date();
    expect(Date.parse(failure!.retryAfter)).toBeGreaterThan(now.getTime());
    expect(autoMigrationBackoffActive(failure, now)).toBe(true);
  });
});

describe("the refusals before anything is created", () => {
  test("unparseable items refuse and name the items and the manual command", () => {
    makeMigrationBenchUnparseable();
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.error).toContain("cannot be parsed");
    expect(run.error).toContain("Brain/log/");
    expect(run.manualCommand).toBe("o2b brain migrate-store --dry-run");
    expect(bench.records()).toHaveLength(0);
    expect(readMigrationGate()).toBeNull();
  });

  test("with no store yet, a refusal creates no store", () => {
    benchWithoutStore();
    makeMigrationBenchUnparseable();
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(existsSync(bench.storeRoot)).toBe(false);
  });

  test("a gate another vault's interrupted run left refuses before a store is created", () => {
    benchWithoutStore();
    const gate = migrationGatePath();
    mkdirSync(dirname(gate), { recursive: true });
    writeFileSync(
      gate,
      JSON.stringify({
        vault: join(bench.fx.parent, "another-vault"),
        run_id: "migrate-other",
        since: new Date().toISOString(),
        pid: deadPid(),
      }),
    );
    try {
      const run = autoRun(bench.vault);
      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
      // The refusal names the vault that holds the gate, and the command
      // resumes that vault's run.
      expect(run.error).toContain("a stopped migration of the vault");
      expect(run.error).toContain("another-vault");
      expect(run.manualCommand).toContain("another-vault");
      expect(run.manualCommand).toContain("--resume");
      expect(existsSync(bench.storeRoot)).toBe(false);
    } finally {
      rmSync(gate, { force: true });
    }
  });

  test("a store that cannot be read right now is a wait, not a failure", () => {
    // A file where the store root should be: the probe cannot read it.
    rmSync(bench.storeRoot, { recursive: true, force: true });
    writeFileSync(bench.storeRoot, "not a store\n");
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readAutoMigrationWaiting(bench.vault)?.reason).toContain("cannot be read");
  });
});

describe("a store another device created for this vault", () => {
  test("is waited for, not created again, while it has not arrived", () => {
    benchWithoutStore();
    // Another device's migration logged its snapshot in its own log shard,
    // which synced with the vault; its store has not arrived.
    writeFileSync(
      join(bench.vault, "Brain", "log", "2026-11-17.dev-z.jsonl"),
      JSON.stringify({
        ts: "2026-11-17T10:00:00Z",
        kind: "snapshot",
        payload: { run_id: "store-migration-20261117", reason: "store-migration" },
      }) + "\n",
    );
    const run = autoRun(bench.vault);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(existsSync(bench.storeRoot)).toBe(false);
    const waiting = readAutoMigrationWaiting(bench.vault);
    expect(waiting?.firstMachines).toEqual(["dev-z"]);
    expect(waiting?.reason).toContain("dev-z");
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
  });

  test("a log shard that cannot be read is a wait, not a reason to create a store", () => {
    benchWithoutStore();
    // Another device's shard, which may hold its mark, cannot be opened now.
    writeFileSync(join(bench.vault, "Brain", "log", "2026-11-17.dev-z.jsonl"), `${NOTE_LINE}\n`);
    const real = fs.openSync;
    const refused = spyOn(fs, "openSync").mockImplementation(((
      path: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode | null,
    ) => {
      if (String(path).endsWith("2026-11-17.dev-z.jsonl")) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return real(path, flags ?? "r", mode);
    }) as typeof fs.openSync);
    let run;
    try {
      run = autoRun(bench.vault);
    } finally {
      refused.mockRestore();
    }
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(existsSync(bench.storeRoot)).toBe(false);
    expect(readAutoMigrationWaiting(bench.vault)?.reason).toContain("cannot be read");
    // Not remembered as a wait for another store: the next start looks again.
    expect(readAutoMigrationWaiting(bench.vault)?.awaitsStore).toBe(false);
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  });

  test("a waiting machine starts no worker until that store arrives, or a day later", () => {
    benchWithoutStore();
    writeFileSync(
      join(bench.vault, "Brain", "log", "2026-11-17.dev-z.jsonl"),
      JSON.stringify({
        ts: "2026-11-17T10:00:00Z",
        kind: "snapshot",
        payload: { run_id: "store-migration-20261117", reason: "store-migration" },
      }) + "\n",
    );
    const now = new Date();
    expect(autoRun(bench.vault, { now }).outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    // The answer is remembered: the next starts read no log shard and start
    // no worker while the store is still absent.
    expect(planAutoMigrationStart(bench.vault, undefined, now, false)).toBe(
      AUTO_MIGRATION_SPAWN.waiting,
    );
    const report = autoMigrationReport({ vault: bench.vault, now });
    expect(report.state).toBe(AUTO_MIGRATION_STATE.waiting);
    expect(report.nextStart).toContain("store arrives");
    expect(report.message).toContain("o2b store init");
    // A day later the synced log is looked at again.
    const dayLater = new Date(now.getTime() + 25 * 60 * 60_000);
    expect(planAutoMigrationStart(bench.vault, undefined, dayLater, false)).toBe(
      AUTO_MIGRATION_START,
    );
    // The store arrives: the next start migrates as a later machine.
    initStore({ root: bench.storeRoot });
    forgetMachineStateCache();
    expect(planAutoMigrationStart(bench.vault, undefined, now, false)).toBe(AUTO_MIGRATION_START);
  });
});

describe("what the records carry", () => {
  test("a failure text names no home directory", () => {
    // The home this process always knows, on every platform.
    const home = homedir();
    const run = autoRun(bench.vault, {
      hooks: {
        afterBackup: () => {
          throw new Error(`fault injection: ${join(home, "secret-place", "file")}\ninjected`);
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    const failure = readAutoMigrationFailure(bench.vault)!;
    expect(failure.error).not.toContain(home);
    expect(failure.error).toContain("~");
    expect(failure.error).not.toContain("\n");
    expect(run.error).not.toContain(home);
  });

  test("the log line carries no local path, and the notice no empty snapshot", () => {
    expect(autoRun(bench.vault).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const line = bench
      .records()
      .find((r) => r.kind === "log-event" && r.body["event_type"] === "store-migration-done");
    expect(line?.partition).toBe("shared");
    expect(JSON.stringify(line?.body)).not.toContain(bench.storeRoot);
    expect(JSON.stringify(line?.body)).not.toContain("store_root");
    expect(readAutoMigrationNotice(bench.vault)?.snapshot).not.toBe("");
  });
});
