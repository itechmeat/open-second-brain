/**
 * The failure table of the automatic store migration: its rows, its
 * fixture and its oracle, shared by the `auto-failure-table-*.test.ts`
 * files, one per column, so no single file carries the whole table.
 *
 * The automatic store migration under every way an attempt can stop: one
 * table over "where the run stopped" (every step boundary of an attempt)
 * by "how it stopped" (a thrown error in the attempt's process, or a real
 * SIGKILL of a child process running the attempt), with one oracle.
 *
 * After the stopped attempt, a later start decides what a start would
 * (`planAutoMigrationStart`, the decision `ensureVaultCurrent` takes) and,
 * when that is to start the worker, runs the worker's logic in this
 * process. The oracle is checked after one later start and again after a
 * second: the machine is either
 *
 *  - fully legacy: the gate free, the worker lock free, an agent write
 *    succeeds, the legacy tree intact, and a later attempt (run here at
 *    the end) reuses whatever the stopped attempt created and switches; or
 *  - fully switched: the run done, the vault bound, the view writer
 *    claimed, the gate free, the lock free, an agent write succeeds, every
 *    legacy record in the store exactly once, no failure reported;
 *
 * never anything else, and the success notice is shown exactly once.
 *
 * A third column kills the attempt and then switches the opt-out off
 * before the later starts: finishing an attempt that already started (a
 * switch that did not finish, or a gate a killed attempt left closed) is
 * not a new migration and runs whatever the setting says; a machine that
 * ends on the legacy layout stays there, writable, and no start begins a
 * migration on it until the setting is on again.
 *
 * A fourth dimension, "what comes next", kills the attempt and then runs
 * each thing that can come through next: a start, `o2b update` in the
 * foreground, `o2b update --skip-store-migration`, `o2b update` with the
 * opt-out off, a start whose dry run now refuses (an unmapped or an
 * unparseable item appeared after the kill), a manual
 * `o2b brain migrate-store` and a manual `--dry-run`. The same oracle is
 * checked after that step and after one more start; a refusal still
 * leaves its failure record and the manual command. Its rows are reduced
 * to the three boundaries whose recovery differs: a gate whose run is not
 * on record yet ("after the gate is taken"; no state names the run, so
 * the gate is recognised by its migration run id alone), the gate held on
 * a machine that has not switched ("after the gate closes"; every kill
 * from there to "after migration-done" leaves the same state for what
 * comes next: an in-progress run and a dead holder's gate) and a machine
 * that switched with the gate still held ("after device-switched"; the
 * later kills take the same switched branch). The two read-only steps (the skip
 * and the manual dry run) change nothing by design, so for them the
 * oracle is checked after the one more start only.
 *
 * A fifth column, "a read failure after the switch", stops the attempt
 * (a thrown error) at every boundary after the device switched, then
 * lets the run state fail to read in a later start, at two points: when
 * the start begins (the state cannot be read at all), and right after the
 * start finishes an interrupted switch (it wrote `done`, and the read
 * that should prove it fails). The success outputs depend on one
 * predicate, the switch proven finished (the state reads back as done on
 * a switched device): while the read fails, no output is written (no
 * metrics row, no notice) and the attempt's record stays pending, an
 * attempt's, never a failure a later start would only clear. Once the
 * state reads again, one more start finishes and publishes, and the
 * oracle holds with the notice shown exactly once.
 *
 * A sixth column, "the gate release meets a busy gate lock", runs the
 * attempt in a child process; at each boundary where the run holds the
 * gate, a second process takes the gate lock and keeps it past the
 * release's wait, and the attempt throws there, or (one more row) runs to
 * its end. The attempt's release leaves the gate as it is and reports
 * busy (nothing is opened without the gate lock), and the child exits, so
 * the gate's holder is gone. The later starts recover the gate as a
 * stopped run's, and the oracle holds.
 *
 * Rows that cannot be told apart: "after the view writer claim" and
 * "before the final save" are the same boundary (nothing runs between the
 * claim and the save of `phase: done`), so one row covers both.
 */
import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  AUTO_MIGRATION_START,
  planAutoMigrationStart,
} from "../../../../src/core/maintenance/ensure-current.ts";
import { readMigrationGate } from "../../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { deviceSwitchedHere, storeOnlyMode } from "../../../../src/core/store/store-only.ts";
import { inspectStore, openStore } from "../../../../src/core/store/store-open.ts";
import { listMetrics } from "../../../../src/core/brain/metrics.ts";
import * as probe from "../../../../src/core/store-migration/auto-probe.ts";
import { autoMigrationReport } from "../../../../src/core/store-migration/auto-report.ts";
import {
  clearAutoMigrationNotice,
  readAutoMigrationFailure,
  readAutoMigrationNotice,
  readAutoMigrationRunning,
} from "../../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  AUTO_MIGRATION_SURFACE,
  runAutoStoreMigration,
  type AutoMigrationHooks,
} from "../../../../src/core/store-migration/auto-worker.ts";
import {
  MIGRATION_STATE_FILE,
  migrationDir,
} from "../../../../src/core/store-migration/journal.ts";
import * as migrate from "../../../../src/core/store-migration/migrate.ts";
import { runStateOf } from "./run-state.ts";
import { migratedMark } from "../../../../src/core/store-migration/migration-records.ts";
import { updateStoreMigration } from "../../../../src/core/store-migration/update-step.ts";
import { vaultBindingStatus } from "../../../../src/core/vault-adapter/vault-binding.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { dropUnparseable } from "./migration-env.ts";
import { readViewWriter } from "../../../../src/core/view/writer.ts";

const KILL_CHILD = join(import.meta.dir, "auto-kill-child.ts");
const RELEASE_BUSY_CHILD = join(import.meta.dir, "auto-release-busy-child.ts");
const LOCK_HOLDER = join(import.meta.dir, "gate-lock-holder-child.ts");

/**
 * No settle wait in the attempts run here and in the kill child: nothing
 * writes while they run, and the wait is a fixed sleep per migration.
 */
const FAST = { settleMs: 0 } as const;
const DEVICE = "dev-a";

/** Every step boundary of an automatic attempt, in run order. */
export const ROWS: ReadonlyArray<{ readonly name: string; readonly step: string }> = [
  { name: "before the lock", step: "before-lock" },
  { name: "after the lock", step: "lock-claimed" },
  { name: "during the upgrade step", step: "upgrade" },
  { name: "during the dry run", step: "dry-run" },
  { name: "after store init", step: "store-ready" },
  { name: "after the gate is taken, before the run is on record", step: "gate-taken" },
  { name: "after the gate closes", step: "gate-closed" },
  { name: "after the backup", step: "backed-up" },
  { name: "during convert", step: "convert" },
  { name: "during verify", step: "verify" },
  { name: "after migration-done", step: "migration-done" },
  { name: "after device-switched", step: "device-switched" },
  { name: "after the switch marker", step: "switch-marker" },
  { name: "after the vault binding", step: "vault-bound" },
  { name: "after the view writer claim (before the final save)", step: "view-writer" },
  { name: "during the success records", step: "success-records" },
  { name: "after the notice, before the attempt's record is cleared", step: "notice-written" },
];

const ENV_KEYS = [
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

let root: string;
let vault: string;
let storeRoot: string;
let configPath: string;
let signalPath: string;
let signalText: string;
let writes = 0;
const saved = new Map<string, string | undefined>();

/**
 * Registers the per-test fixture (a fresh vault with one legacy signal, a
 * store root, the device-local state) in the calling test file.
 */
export function useTableFixture(): void {
  beforeEach(setUp);
  afterEach(tearDown);
}

function setUp(): void {
  root = mkdtempSync(join(tmpdir(), "osb-auto-table-"));
  vault = join(root, "vault");
  storeRoot = join(root, "store");
  configPath = join(root, "config.yaml");
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  Object.assign(process.env, {
    [STORE_ROOT_ENV]: storeRoot,
    O2B_DEVICE_ID: DEVICE,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    LOCALAPPDATA: join(root, "state"),
    APPDATA: join(root, "data"),
  });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  forgetMachineStateCache();
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  const written = writeSignal(vault, {
    topic: "legacy",
    signal: "positive",
    agent: "@a",
    principle: "A legacy signal to migrate",
    created_at: "2026-11-17T09:00:00.000Z",
    date: "2026-11-17",
    slug: "legacy-signal",
  });
  signalPath = written.path;
  signalText = readFileSync(signalPath, "utf8");
  writes = 0;
  legacyWrites = [];
}

function tearDown(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  forgetMachineStateCache();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The hooks that stop the attempt at `step` by `stop`. */
function stopAt(step: string, stop: () => never): AutoMigrationHooks {
  return {
    atStep: (at) => {
      if (at === step) stop();
    },
    afterItemAppended: () => {
      if (step === "convert") stop();
    },
    beforeVerify: () => {
      if (step === "verify") stop();
    },
  };
}

export function throwAt(step: string): void {
  const run = runAutoStoreMigration(vault, {
    configPath,
    ...FAST,
    hooks: stopAt(step, () => {
      throw new Error(`fault injection: ${step}`);
    }),
  });
  // A thrown error never escapes the worker; the attempt answers failed.
  expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
}

export function killAt(step: string): void {
  const marker = join(root, "kill-point");
  rmSync(marker, { force: true });
  const child = Bun.spawnSync(
    [process.execPath, "run", KILL_CHILD, vault, configPath, step, marker],
    {
      env: { ...process.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 90_000,
    },
  );
  // The kill point was met: the child neither finished nor stopped short.
  expect([step, child.exitCode, child.stderr.toString().slice(-300)]).not.toEqual([
    step,
    3,
    child.stderr.toString().slice(-300),
  ]);
  expect(child.success).toBe(false);
  if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
  // The child wrote the step right before it killed itself: the process
  // died at the selected boundary, not earlier (on Windows a kill and any
  // other failure both read as exit code 1).
  expect([step, existsSync(marker) ? readFileSync(marker, "utf8") : null]).toEqual([step, step]);
}

/** The boundaries where the run holds the gate: the rows of the busy release column. */
export const GATE_HELD_ROWS: ReadonlyArray<{ readonly name: string; readonly step: string }> =
  ROWS.slice(
    ROWS.findIndex((r) => r.step === "gate-taken"),
    ROWS.findIndex((r) => r.step === "view-writer") + 1,
  );

/**
 * The attempt, in a child process, meets a gate lock another process holds
 * from `step` on, past its release: it throws at `step` (`throw`) or runs
 * to its end (`end`). The lock is let go once the child has exited.
 *
 * This process spawns the lock holder and stays its parent: on Windows a
 * child that is not detached is ended together with the process that
 * spawned it, so a holder the attempt's process started died with it. The
 * attempt only says when to take the lock (the `take` file).
 */
export async function releaseBusyAt(step: string, mode: "throw" | "end"): Promise<void> {
  const marker = join(root, "release-point");
  const take = join(root, "lock-take");
  const ready = join(root, "lock-ready");
  const done = join(root, "lock-done");
  for (const path of [marker, take, ready, done]) rmSync(path, { force: true });
  const holder = Bun.spawn([process.execPath, "run", LOCK_HOLDER, ready, done, take], {
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let holderExit: number | string;
  let childExit: number | null;
  let childErr: string;
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "run",
        RELEASE_BUSY_CHILD,
        vault,
        configPath,
        step,
        mode,
        marker,
        take,
        ready,
      ],
      {
        env: { ...process.env, OPEN_SECOND_BRAIN_LOCK_WAIT_MS: "200" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 90_000,
      },
    );
    childExit = child.exitCode;
    childErr = child.stderr.toString().slice(-300);
  } finally {
    // The holder lets the lock go as soon as `done` appears; a holder that
    // has not exited within the bound is ended and named in the failure.
    writeFileSync(done, "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    holderExit = await Promise.race([
      holder.exited,
      new Promise<string>((settle) => {
        timer = setTimeout(
          () => settle("the lock holder did not exit within 10 s of done"),
          10_000,
        );
      }),
    ]);
    clearTimeout(timer);
    if (typeof holderExit === "string") {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  }
  expect([step, childExit, childErr]).toEqual([step, 0, childErr]);
  // The lock was held from the step on, and the attempt ended.
  expect([step, readFileSync(marker, "utf8").startsWith(`${step} `)]).toEqual([step, true]);
  // The holder took the lock and let it go (5: it was never asked to take it).
  const holderErr = (await new Response(holder.stderr).text()).slice(-300);
  expect([step, "lock holder exit", holderExit, holderErr]).toEqual([
    step,
    "lock holder exit",
    0,
    holderErr,
  ]);
  // Its release left the gate: nothing opens it without the gate lock.
  forgetMachineStateCache();
  expect([step, readMigrationGate() !== null]).toEqual([step, true]);
}

/** What a later start does: the start's own decision, the worker in this process. */
function laterStart(): void {
  forgetMachineStateCache();
  const switched = storeOnlyMode({ vault, configPath }).reason === "device-switched";
  const plan = planAutoMigrationStart(vault, configPath, new Date(), switched);
  if (plan === AUTO_MIGRATION_START) runAutoStoreMigration(vault, { configPath, ...FAST });
}

function storeHandle() {
  return openStore({ root: storeRoot, device: DEVICE });
}

/** Store records by migrated legacy key. */
function migratedByKey(): Map<string, Array<{ part: number }>> {
  const out = new Map<string, Array<{ part: number }>>();
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(storeRoot, partition))) {
      for (const record of shard.all) {
        const mark = migratedMark(record);
        if (mark === null) continue;
        out.set(mark.key, [...(out.get(mark.key) ?? []), { part: mark.part }]);
      }
    }
  }
  return out;
}

/** The slugs the oracle wrote while the machine was on the legacy layout. */
let legacyWrites: string[] = [];

/** An agent write; it must succeed on either layout. */
function agentWrite(layout: Layout): void {
  writes += 1;
  if (layout === "legacy") legacyWrites.push(`oracle-${writes}`);
  writeSignal(vault, {
    topic: "oracle",
    signal: "positive",
    agent: "@oracle",
    principle: `An oracle write ${writes}`,
    created_at: "2026-11-18T09:00:00.000Z",
    date: "2026-11-18",
    slug: `oracle-${writes}`,
  });
}

type Layout = "legacy" | "switched";

/** The oracle; returns the layout, failing the test on anything in between. */
function oracle(label: string): Layout {
  forgetMachineStateCache();
  const ctx = `${label}`;
  expect([ctx, readMigrationGate()]).toEqual([ctx, null]);
  expect([ctx, readAutoMigrationRunning(vault)]).toEqual([ctx, null]);
  const store = inspectStore(storeRoot);
  const switched = store !== null && deviceSwitchedHere(storeHandle(), DEVICE);
  if (switched) {
    expect([ctx, runStateOf(migrationDir(storeHandle()))?.phase]).toEqual([ctx, "done"]);
    expect([ctx, vaultBindingStatus(vault, { configPath }).state]).toEqual([ctx, "match"]);
    expect([ctx, readViewWriter(storeHandle()).writer]).toEqual([ctx, DEVICE]);
    expect([ctx, readAutoMigrationFailure(vault)]).toEqual([ctx, null]);
    expect([ctx, autoMigrationReport({ vault, configPath }).state]).toEqual([ctx, "done"]);
    const byKey = migratedByKey();
    expect([ctx, byKey.size > 0]).toEqual([ctx, true]);
    for (const [key, records] of byKey) {
      const parts = new Set(records.map((r) => r.part));
      expect([ctx, key, records.length]).toEqual([ctx, key, parts.size]);
    }
    expect([ctx, [...byKey.keys()].some((k) => k.endsWith("legacy-signal.md"))]).toEqual([
      ctx,
      true,
    ]);
    // Every write that landed on the legacy layout before the switch is in
    // the store: a resume loses none of them.
    for (const slug of legacyWrites) {
      expect([ctx, slug, [...byKey.keys()].some((k) => k.endsWith(`${slug}.md`))]).toEqual([
        ctx,
        slug,
        true,
      ]);
    }
  } else {
    // The legacy tree is as it was: the legacy item untouched.
    expect([ctx, readFileSync(signalPath, "utf8")]).toEqual([ctx, signalText]);
  }
  const layout: Layout = switched ? "switched" : "legacy";
  agentWrite(layout);
  return layout;
}

/** The notice, as a session start shows it: counted once and cleared. */
function showNotice(): number {
  if (readAutoMigrationNotice(vault) === null) return 0;
  clearAutoMigrationNotice(vault);
  return 1;
}

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";

export function check(stopped: () => void, opts: { optOutAfter?: boolean } = {}): void {
  stopped();
  if (opts.optOutAfter === true) process.env[AUTO_ENV] = "false";
  laterStart();
  const first = oracle("after one later start");
  let shown = showNotice();
  laterStart();
  const second = oracle("after a second later start");
  shown += showNotice();
  // A machine never goes back from switched on its own.
  if (first === "switched") expect(second).toBe("switched");
  if (second === "switched") {
    expect(shown).toBe(1);
    return;
  }
  expect(shown).toBe(0);
  if (opts.optOutAfter === true) {
    // The opt-out governs starting a migration: none starts while it is off.
    forgetMachineStateCache();
    expect(planAutoMigrationStart(vault, configPath, new Date(), false)).toBe("disabled");
    expect(runAutoStoreMigration(vault, { configPath, ...FAST }).outcome).toBe(
      AUTO_MIGRATION_OUTCOME.disabled,
    );
    expect(oracle("with the opt-out off")).toBe("legacy");
    process.env[AUTO_ENV] = "true";
  }
  // Fully legacy: whatever the stopped attempt created (a store, a backup,
  // a journal) is reused by a later attempt, which switches.
  const later = runAutoStoreMigration(vault, { configPath, ...FAST });
  expect(later.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  expect(oracle("after a later attempt")).toBe("switched");
  expect(showNotice()).toBe(1);
  expect(existsSync(storeRoot)).toBe(true);
}

// ----- What comes next ------------------------------------------------------

/** The boundaries the "what comes next" dimension stops at; see the header. */
export const NEXT_BOUNDARIES: ReadonlyArray<{ readonly name: string; readonly step: string }> = [
  { name: "the gate taken, the run not on record", step: "gate-taken" },
  { name: "the gate held", step: "gate-closed" },
  { name: "the machine switched", step: "device-switched" },
];

const STRAY = ["Brain", "log", "stray.txt"] as const;

/** The fixture's environment, for a CLI run in this process. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface NextStep {
  readonly name: string;
  readonly run: () => Promise<void> | void;
  /** The step reads only: the oracle is checked after the one more start. */
  readonly readOnly?: boolean;
  /** The dry run refuses from now on: a legacy end keeps its failure record. */
  readonly refuses?: boolean;
  /** The opt-out is off for the step and the one more start. */
  readonly optOut?: boolean;
  /**
   * A person runs it and reads its outcome: a switch it makes ends what
   * the automatic migration recorded, its success notice included.
   */
  readonly manual?: boolean;
  /** Undo what the step put in the vault, before the final attempt. */
  readonly undo?: () => void;
}

export const NEXT_STEPS: ReadonlyArray<NextStep> = [
  { name: "a start", run: () => laterStart() },
  {
    name: "o2b update in the foreground",
    run: () => {
      updateStoreMigration(vault, { configPath, skip: false, dryRun: false });
    },
  },
  {
    name: "o2b update --skip-store-migration",
    run: () => {
      expect(updateStoreMigration(vault, { configPath, skip: true, dryRun: false }).outcome).toBe(
        "skipped",
      );
    },
    readOnly: true,
  },
  {
    name: "o2b update with the opt-out off",
    run: () => {
      updateStoreMigration(vault, { configPath, skip: false, dryRun: false });
    },
    optOut: true,
  },
  {
    name: "a start whose dry run now refuses an unmapped item",
    run: () => {
      writeFileSync(join(vault, ...STRAY), "an entry no surface maps\n");
      laterStart();
    },
    refuses: true,
    undo: () => rmSync(join(vault, ...STRAY), { force: true }),
  },
  {
    name: "a start whose dry run now refuses an unparseable item",
    run: () => {
      writeFileSync(join(vault, "Brain", "log", "2026-11-17.jsonl"), "{not json\n");
      laterStart();
    },
    refuses: true,
    undo: () => dropUnparseable(vault),
  },
  {
    name: "a manual o2b brain migrate-store",
    run: async () => {
      const out = await runCli(["brain", "migrate-store", "--vault", vault, "--json"], {
        env: cliEnv(),
      });
      forgetMachineStateCache();
      const switched = deviceSwitchedHere(storeHandle(), DEVICE);
      // It switches the machine itself, or refuses because a stopped run is
      // to be resumed and says so: a later start never covers for it.
      if (out.returncode === 0) {
        expect(["switched", switched]).toEqual(["switched", true]);
      } else {
        expect([switched, `${out.stdout}${out.stderr}`]).toEqual([
          false,
          expect.stringContaining("--resume"),
        ]);
      }
    },
    manual: true,
  },
  {
    name: "a manual o2b brain migrate-store --dry-run",
    run: async () => {
      const out = await runCli(
        ["brain", "migrate-store", "--vault", vault, "--dry-run", "--json"],
        { env: cliEnv() },
      );
      expect([out.returncode, out.stderr]).toEqual([0, expect.any(String)]);
    },
    readOnly: true,
  },
];

/** A refusal leaves its failure record and the manual command. */
function refusalReported(label: string): void {
  const failure = readAutoMigrationFailure(vault);
  expect([label, failure !== null, failure?.attempt]).toEqual([label, true, false]);
  expect([label, typeof failure?.manualCommand]).toEqual([label, "string"]);
  const report = autoMigrationReport({ vault, configPath });
  expect([label, report.state, report.manualCommand !== null]).toEqual([label, "failed", true]);
}

export async function checkNext(boundary: string, next: NextStep): Promise<void> {
  killAt(boundary);
  if (next.optOut === true) process.env[AUTO_ENV] = "false";
  const gateBefore = readMigrationGate();
  await next.run();
  let shown = 0;
  if (next.readOnly === true) {
    // A read-only step leaves the stopped attempt as it found it.
    forgetMachineStateCache();
    expect(readMigrationGate()).toEqual(gateBefore);
  } else {
    const first = oracle(`after ${next.name}`);
    if (next.refuses === true && first === "legacy") refusalReported(`after ${next.name}`);
    if (next.manual === true && first === "switched") {
      expect(readAutoMigrationNotice(vault)).toBeNull();
      shown += 1;
    }
    shown += showNotice();
  }
  laterStart();
  const second = oracle(`after ${next.name} and one more start`);
  if (next.refuses === true && second === "legacy") {
    refusalReported(`after ${next.name} and one more start`);
  }
  shown += showNotice();
  if (second === "switched") {
    expect(shown).toBe(1);
    return;
  }
  expect(shown).toBe(0);
  if (next.optOut === true) process.env[AUTO_ENV] = "true";
  next.undo?.();
  // Fully legacy: a later attempt reuses what the stopped one created.
  const later = runAutoStoreMigration(vault, { configPath, ...FAST });
  expect(later.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  expect(oracle("after a later attempt")).toBe("switched");
  expect(showNotice()).toBe(1);
}

// ----- A read failure after the switch ---------------------------------------

/** Every boundary at which the device has switched already. */
export const SWITCHED_ROWS = ROWS.slice(ROWS.findIndex((r) => r.step === "device-switched"));

/** Of those, the ones that leave the run in progress: a later start finishes the switch. */
export const INTERRUPTED_ROWS = SWITCHED_ROWS.filter(
  (r) => r.step !== "success-records" && r.step !== "notice-written",
);

/** How many applied metrics rows the automatic migration wrote. */
function appliedRows(): number {
  return listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE }).filter(
    (r) => r.payload["outcome"] === AUTO_MIGRATION_OUTCOME.applied,
  ).length;
}

interface Published {
  readonly rows: number;
  readonly notice: unknown;
}

function published(): Published {
  return { rows: appliedRows(), notice: readAutoMigrationNotice(vault) };
}

/**
 * While the switch is not proven finished: nothing more is published, and
 * the attempt's record stays an attempt's (pending), never a failure.
 * `unreadable`: the state still cannot be read, so no report says done
 * either (after a failed read-back the state on disk is done, and the
 * report, which reads it, rightly says so with the records still to write).
 */
function pending(label: string, before: Published, unreadable: boolean): void {
  forgetMachineStateCache();
  expect([label, published()]).toEqual([label, before]);
  const failure = readAutoMigrationFailure(vault);
  expect([label, failure?.attempt]).toEqual([label, true]);
  const report = autoMigrationReport({ vault, configPath });
  if (unreadable) expect([label, report.state]).not.toEqual([label, "done"]);
  else expect([label, report.nextStart]).toEqual([label, expect.stringContaining("last records")]);
}

/** The state reads again: one more start publishes, the oracle holds, the notice shows once. */
function publishedOnceReadable(): void {
  laterStart();
  expect(oracle("after the run state reads again")).toBe("switched");
  let shown = showNotice();
  laterStart();
  expect(oracle("after one more start")).toBe("switched");
  shown += showNotice();
  expect(shown).toBe(1);
  expect(appliedRows()).toBe(1);
}

/** The run state cannot be read when the later starts begin. */
export function checkUnreadableAtStart(step: string): void {
  throwAt(step);
  forgetMachineStateCache();
  const path = join(migrationDir(storeHandle()), MIGRATION_STATE_FILE);
  const good = readFileSync(path, "utf8");
  const before = published();
  writeFileSync(path, "{ a torn state");
  laterStart();
  pending("the run state cannot be read: one start", before, true);
  laterStart();
  pending("the run state cannot be read: two starts", before, true);
  writeFileSync(path, good);
  publishedOnceReadable();
}

/**
 * The later start finishes the interrupted switch (it writes `done`), and
 * the read that should prove it fails.
 */
export function checkReadBackFails(step: string): void {
  throwAt(step);
  const before = published();
  const finish = migrate.finishInterruptedSwitch;
  const read = probe.ownMigrationRunRead;
  let finished = false;
  const finishSpy = spyOn(migrate, "finishInterruptedSwitch").mockImplementation((...args) => {
    const result = finish(...args);
    finished = true;
    return result;
  });
  const readSpy = spyOn(probe, "ownMigrationRunRead").mockImplementation((path) => {
    const real = read(path);
    if (!finished || real.kind !== "run") return real;
    return {
      ...real,
      run: { ...real.run, state: { kind: "unreadable", error: "a read that failed" } },
    };
  });
  try {
    laterStart();
  } finally {
    finishSpy.mockRestore();
    readSpy.mockRestore();
  }
  expect(finished).toBe(true);
  forgetMachineStateCache();
  expect(runStateOf(migrationDir(storeHandle()))?.phase).toBe("done");
  pending("the read-back after the switch failed", before, false);
  publishedOnceReadable();
}
