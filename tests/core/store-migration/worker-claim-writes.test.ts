/**
 * What the automatic worker's claim guards, and what it writes before it
 * holds one.
 *
 *  1. Before the claim the worker writes nothing: in every state the gate
 *     decision answers "nothing" for, no file under the bench (vault,
 *     store, device-local state, config) is created, changed or removed
 *     before the claim, and when the answer needs no claim, none at all.
 *  2. A worker whose claim is taken over while it runs writes nothing
 *     more: its attempt record, success outputs and notice are made only
 *     under its own claim, so the new holder's record stays as it is.
 *  3. Guard: the worker reaches the state, notice, metrics, log and store
 *     writers only through the claim-checked writes.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readVaultIdentity, vaultIdentityPath } from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { migrationGatePath } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import {
  AUTO_MIGRATION_SELF_CLAIM,
  autoMigrationLockPath,
  autoMigrationNoticePath,
  readAutoMigrationFailure,
  readAutoMigrationWaiting,
  recordAutoMigrationFailure,
  recordAutoMigrationWaiting,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
  type AutoMigrationOutcome,
} from "../../../src/core/store-migration/auto-worker.ts";
import { migrationDir, writeMigrationState } from "../../../src/core/store-migration/journal.ts";
import { MIGRATION_COHORT_KIND } from "../../../src/core/store-migration/migration-records.ts";
import { processStartIdentity } from "../../../src/core/store-migration/process-identity.ts";
import * as quiesce from "../../../src/core/store-migration/quiesce.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
/** Another worker's claim token (32 hex characters, never this worker's). */
const THEIRS = "f".repeat(32);

let bench: MigrationBench;
let savedAuto: string | undefined;

function setUp(withStore: boolean): void {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench("osb-claim-writes-", { withStore });
  dropUnparseable(bench.vault);
  forgetMachineStateCache();
}

function tearDown(): void {
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
}

/** Every file and folder under the bench's parent, with its content's hash. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const claim = autoMigrationLockPath(bench.vault);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // The claim itself (its file and its mutex) is what the claim makes.
      if (path === claim || path.startsWith(`${claim}.`)) continue;
      if (entry.isDirectory()) {
        out.set(path, "dir");
        walk(path);
      } else {
        out.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  walk(bench.fx.parent);
  return out;
}

function differences(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, sum] of before) {
    if (!after.has(path)) out.push(`removed ${path}`);
    else if (after.get(path) !== sum) out.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`created ${path}`);
  return out;
}

function writeRunState(phase: "rolled-back" | "garbage"): void {
  const dir = migrationDir(bench.store());
  if (phase === "garbage") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    return;
  }
  const at = new Date().toISOString();
  writeMigrationState(dir, {
    run_id: "migrate-20261119T000000000Z",
    phase,
    started_at: at,
    updated_at: at,
    backed_up: true,
  });
}

/** A gate of `vault` held by this live process. */
function liveGate(vault: string): void {
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(
    path,
    JSON.stringify({
      vault,
      run_id: "migrate-20261119T010000000Z",
      since: new Date().toISOString(),
      pid: process.pid,
      started: processStartIdentity(process.pid),
    }),
  );
}

function failure(): void {
  recordAutoMigrationFailure(bench.vault, "an earlier attempt failed", {
    manualCommand: "o2b brain migrate-store",
    now: new Date(),
  });
}

interface Row {
  readonly name: string;
  readonly withStore?: boolean;
  readonly plant: () => void;
  readonly outcome: AutoMigrationOutcome;
  /** Whether the answer writes, so it is decided again and made under the claim. */
  readonly claims: boolean;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "disabled",
    plant: () => (process.env[AUTO_ENV] = "false"),
    outcome: AUTO_MIGRATION_OUTCOME.disabled,
    claims: false,
  },
  {
    name: "not-available, no record",
    plant: () => rmSync(join(bench.vault, "Brain"), { recursive: true, force: true }),
    outcome: AUTO_MIGRATION_OUTCOME.notNeeded,
    claims: false,
  },
  {
    name: "not-available, a moot record to clear",
    plant: () => {
      failure();
      rmSync(join(bench.vault, "Brain"), { recursive: true, force: true });
    },
    outcome: AUTO_MIGRATION_OUTCOME.notNeeded,
    claims: true,
  },
  {
    name: "rolled-back",
    plant: () => writeRunState("rolled-back"),
    outcome: AUTO_MIGRATION_OUTCOME.rolledBack,
    claims: false,
  },
  {
    name: "run-unreadable",
    plant: () => writeRunState("garbage"),
    outcome: AUTO_MIGRATION_OUTCOME.waiting,
    claims: true,
  },
  {
    name: "waiting",
    withStore: false,
    plant: () =>
      recordAutoMigrationWaiting(
        bench.vault,
        { missing: [], firstMachines: ["dev-b"], awaitsStore: true },
        new Date(),
      ),
    outcome: AUTO_MIGRATION_OUTCOME.waiting,
    claims: false,
  },
  {
    name: "backoff",
    plant: failure,
    outcome: AUTO_MIGRATION_OUTCOME.refused,
    claims: false,
  },
  {
    name: "running",
    plant: () => liveGate(resolve(bench.vault)),
    outcome: AUTO_MIGRATION_OUTCOME.running,
    claims: false,
  },
  {
    name: "other-vault-running",
    plant: () => liveGate(resolve(bench.fx.parent, "another-vault")),
    outcome: AUTO_MIGRATION_OUTCOME.running,
    claims: false,
  },
];

describe("before its claim the worker writes nothing", () => {
  afterEach(tearDown);

  for (const row of ROWS) {
    test(`${row.name}: ${row.claims ? "nothing before the claim" : "no claim, nothing at all"}`, () => {
      setUp(row.withStore !== false);
      row.plant();
      const before = snapshot();
      let atClaim: Map<string, string> | null = null;
      const run = runAutoStoreMigration(bench.vault, {
        lockToken: AUTO_MIGRATION_SELF_CLAIM,
        settleMs: 0,
        hooks: {
          atStep: (step) => {
            if (step === "lock-claimed") atClaim = snapshot();
          },
        },
      });
      expect(run.outcome).toBe(row.outcome);
      if (row.claims) {
        expect(atClaim).not.toBeNull();
        // The claim makes its own folders when there are none yet; the walk
        // ends where dirname stops moving ("/" or a drive root like "D:\\").
        const claimFolders = new Set<string>();
        for (
          let d = dirname(autoMigrationLockPath(bench.vault));
          d !== dirname(d);
          d = dirname(d)
        ) {
          claimFolders.add(`created ${d}`);
        }
        expect(differences(before, atClaim!).filter((d) => !claimFolders.has(d))).toEqual([]);
      } else {
        expect(atClaim).toBeNull();
        expect(differences(before, snapshot())).toEqual([]);
      }
    });
  }

  test("a moot record is cleared under the claim, and a wait is remembered under it", () => {
    setUp(true);
    failure();
    rmSync(join(bench.vault, "Brain"), { recursive: true, force: true });
    runAutoStoreMigration(bench.vault, { lockToken: AUTO_MIGRATION_SELF_CLAIM, settleMs: 0 });
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
  });
});

/** Another worker takes the claim over and records its own attempt. */
function takeOver(): void {
  atomicWriteFileSync(
    autoMigrationLockPath(bench.vault),
    JSON.stringify({
      token: THEIRS,
      pid: process.pid,
      started: null,
      since: new Date().toISOString(),
    }),
  );
  recordAutoMigrationFailure(bench.vault, "their attempt", {
    manualCommand: "o2b brain migrate-store",
    now: new Date(),
  });
}

describe("a worker whose claim is taken over writes nothing more", () => {
  beforeEach(() => setUp(true));
  afterEach(tearDown);

  test("taken over before the migration: the new holder's record stays", () => {
    const run = runAutoStoreMigration(bench.vault, {
      lockToken: AUTO_MIGRATION_SELF_CLAIM,
      settleMs: 0,
      hooks: {
        atStep: (step) => {
          if (step === "dry-run") takeOver();
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.running);
    expect(readAutoMigrationFailure(bench.vault)?.error).toBe("their attempt");
  });

  test("taken over before the success outputs: no notice, the new holder's record stays", () => {
    runAutoStoreMigration(bench.vault, {
      lockToken: AUTO_MIGRATION_SELF_CLAIM,
      settleMs: 0,
      hooks: {
        atStep: (step) => {
          if (step === "success-records") takeOver();
        },
      },
    });
    expect(existsSync(autoMigrationNoticePath(bench.vault))).toBe(false);
    expect(readAutoMigrationFailure(bench.vault)?.error).toBe("their attempt");
    expect(readAutoMigrationWaiting(bench.vault)).toBeNull();
  });
});

describe("a claim taken over between the ownership check and the gate", () => {
  beforeEach(() => setUp(true));
  afterEach(tearDown);

  test("the vault marker and the id the migration records agree", () => {
    // A vault of an older build: it carries no identity marker yet.
    rmSync(vaultIdentityPath(bench.vault), { force: true });
    const real = quiesce.quiesceLegacyWriters;
    let raced = false;
    const spy = spyOn(quiesce, "quiesceLegacyWriters").mockImplementation((vault, runId, ms) => {
      if (!raced) {
        raced = true;
        // After this worker's last ownership check and before it holds the
        // gate, another worker takes the claim over, and its own run (which
        // also found no marker) writes the marker with an id of its own.
        takeOver();
        atomicWriteFileSync(
          vaultIdentityPath(bench.vault),
          `${JSON.stringify({ schema_version: 1, vault_id: "e".repeat(32), created_at: new Date().toISOString() }, null, 2)}\n`,
        );
      }
      real(vault, runId, ms);
    });
    try {
      runAutoStoreMigration(bench.vault, { lockToken: AUTO_MIGRATION_SELF_CLAIM, settleMs: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    const marker = readVaultIdentity(bench.vault)?.vault_id;
    const recorded = bench
      .records()
      .filter((r) => r.kind === MIGRATION_COHORT_KIND)
      .map((r) => r.body["vault_id"]);
    expect(recorded.length).toBeGreaterThan(0);
    expect(new Set(recorded)).toEqual(new Set([marker]));
  });
});

describe("guard: the worker writes only through its claim", () => {
  const WRITERS = new Set([
    "recordAutoMigrationAttempt",
    "recordAutoMigrationFailure",
    "recordAutoMigrationWaiting",
    "recordAutoMigrationUnfinishedSwitch",
    "recordAutoMigrationGateOwed",
    "settleAutoMigrationGateOwed",
    "markAutoMigrationSuccessWritten",
    "clearAutoMigrationState",
    "recordAutoMigrationNotice",
    "dropShownAutoMigrationNotice",
    "appendMetric",
    "appendLogEvent",
    "ensureBrainStore",
    "atomicWriteFileSync",
    "writeFileSync",
    "unlinkSync",
    "rmSync",
    "mkdirSync",
  ]);

  test("guard: auto-worker.ts imports none of the writers", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../src/core/store-migration/auto-worker.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)]
      .flatMap((m) => m[1]!.split(","))
      .map((name) =>
        name
          .replace(/^\s*type\s+/, "")
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter((name) => name !== "");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => WRITERS.has(name))).toEqual([]);
  });
});
