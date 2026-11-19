/**
 * What a writer refused by the migration gate is told, for each run that
 * holds the gate (a migration, its rollback, the removal of the legacy
 * tree), whether that run is still running or stopped with the gate
 * closed, and how far a running migration is. The rollback and the removal
 * hold the same gate as the migration, so they refuse the same writers.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetFreezeMarkerCache } from "../../src/core/brain/freeze-marker.ts";
import { appendBrainNote } from "../../src/core/brain/note.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import {
  assertDestinationOutsideGatedVault,
  assertNoMigrationInProgress,
  holdMigrationGate,
  MigrationInProgressError,
  migrationGatePath,
  migrationGateResolveCount,
  migrationGateStatCount,
  recordMigrationGateProgress,
  releaseMigrationGate,
} from "../../src/core/migration-gate.ts";
import { runMigration } from "../../src/core/store-migration/migrate.ts";
import { processStartIdentity } from "../../src/core/store-migration/process-identity.ts";
import { treeSnapshot } from "../helpers/vault-digest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { dropUnparseable, makeMigrationBench } from "./store-migration/fixtures/migration-env.ts";

// One test runs a whole migration; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** A pid no process carries: the holder of a gate whose run stopped. */
const GONE_PID = 2147483646;

let tmp: string;
let vault: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-gate-refusal-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const key of ["XDG_STATE_HOME", "LOCALAPPDATA"]) {
    saved[key] = process.env[key];
    process.env[key] = join(tmp, "state");
  }
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  // Restored, not deleted: the preload points the state root at a temp dir.
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

/** This process's start identity, as a run records its own (null where unreadable). */
const OWN_IDENTITY = processStartIdentity(process.pid);

/**
 * Write a gate for `vault` held by `pid`, as a run would leave it. A live
 * holder is this test process, with its start identity recorded unless
 * `started` says otherwise.
 */
function plantGate(
  runId: string,
  pid: number,
  started: string | null = pid === process.pid ? OWN_IDENTITY : null,
  target: string = vault,
): void {
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      vault: target,
      run_id: runId,
      since: "2026-11-19T10:00:00.000Z",
      pid,
      ...(started === null ? {} : { started }),
    }),
  );
}

/** The refusal a Brain log note meets, and the tree it must leave alone. */
function refusalOfNote(): MigrationInProgressError {
  const before = treeSnapshot(vault);
  let caught: unknown = null;
  try {
    appendBrainNote({ vault, text: "a note during the run", agent: "@census" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationInProgressError);
  expect(treeSnapshot(vault)).toEqual(before);
  return caught as MigrationInProgressError;
}

describe("a run that is still running", () => {
  const RUNS = [
    ["migrate-20261119T100000000Z", "a brain store migration of this vault is running"],
    [
      "rollback-migrate-20261119T100000000Z",
      "the rollback of the brain store migration of this vault is running",
    ],
    [
      "remove-legacy-2026-11-19T10:00:00.000Z",
      "the removal of this vault's legacy brain tree is running",
    ],
  ] as const;
  for (const [runId, named] of RUNS) {
    test(`${runId.split("-")[0]}: the writer is refused, told what runs and since when`, () => {
      plantGate(runId, process.pid);
      const refusal = refusalOfNote();
      if (OWN_IDENTITY === null) return; // judged "unknown" below on such a platform
      expect(refusal.message).toContain(named);
      expect(refusal.message).toContain("since 2026-11-19T10:00:00.000Z");
      expect(refusal.message).toContain("Try again when it has finished");
      expect(refusal.retry).toBe("later");
      expect(refusal.holder).toBe("running");
    });
  }

  test("the run's progress is in the refusal when it reported one", () => {
    holdMigrationGate(vault, "migrate-progress");
    recordMigrationGateProgress(
      "migrate-progress",
      "importing: pass 2, 40 item(s) imported so far",
    );
    expect(refusalOfNote().message).toContain("importing: pass 2, 40 item(s) imported so far");
    // Another run's progress is never shown as this one's.
    recordMigrationGateProgress("migrate-other", "verifying 3 imported item(s)");
    expect(refusalOfNote().progress).toBeNull();
    releaseMigrationGate(vault, "migrate-progress");
  });
});

describe("a run that stopped with the gate closed", () => {
  const RUNS = [
    ["migrate-20261119T100000000Z", "o2b brain migrate-store --resume"],
    ["rollback-migrate-20261119T100000000Z", "o2b brain migrate-store --rollback"],
    ["remove-legacy-2026-11-19T10:00:00.000Z", "o2b brain migrate-store --remove-legacy"],
  ] as const;
  for (const [runId, command] of RUNS) {
    test(`${runId.split("-")[0]}: the writer is refused, told what recovers it`, () => {
      plantGate(runId, GONE_PID);
      const refusal = refusalOfNote();
      expect(refusal.message).toContain("stopped without finishing");
      expect(refusal.message).toContain("the next start of Open Second Brain");
      expect(refusal.message.split(command)).toHaveLength(2);
      expect(refusal.next_command).toBe(command);
      expect(refusal.retry).toBe("recover");
      expect(refusal.holder).toBe("stopped");
    });
  }
});

describe("how the holder of the gate is judged", () => {
  const RUN = "migrate-20261119T100000000Z";

  test("a holder whose process is gone is a stopped run", () => {
    plantGate(RUN, GONE_PID, "1700000000:gone");
    const refusal = refusalOfNote();
    expect([refusal.holder, refusal.retry]).toEqual(["stopped", "recover"]);
  });

  test("a live pid with another start identity is a reused pid: the run stopped", () => {
    plantGate(RUN, process.pid, "not-the-identity-of-this-process");
    const refusal = refusalOfNote();
    // Where no identity can be read the reuse cannot be told either.
    const expected = OWN_IDENTITY === null ? "unknown" : "stopped";
    expect(refusal.holder).toBe(expected);
    if (expected === "stopped") {
      expect(refusal.message).toContain("stopped without finishing");
      expect(refusal.message).not.toContain("Try again when it has finished");
    }
  });

  test("a live pid whose identity cannot be told is said to be so, with the forced release", () => {
    plantGate(RUN, process.pid, null);
    const refusal = refusalOfNote();
    expect(refusal.holder).toBe("unknown");
    expect(refusal.retry).toBe("later");
    expect(refusal.message).toContain("cannot be told");
    expect(refusal.message).toContain("o2b brain migrate-store --force-release-gate");
  });
});

describe("a gate that cannot be read", () => {
  test("an unreadable gate refuses every vault, naming the file and the remedy", () => {
    // A directory where the gate file belongs reads as EISDIR on every platform.
    mkdirSync(migrationGatePath(), { recursive: true });
    const refusal = refusalOfNote();
    expect(refusal.message).toContain(migrationGatePath());
    expect(refusal.message).toContain("cannot be read");
    expect(refusal.message).toContain("fix its permissions");
    expect(refusal.message).not.toContain("Try again when it has finished");
    expect(refusal.retry).toBe("recover");
  });

  test("a damaged gate refuses every vault, naming the file and the forced release", () => {
    const path = migrationGatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not a gate");
    const refusal = refusalOfNote();
    expect(refusal.message).toContain(path);
    expect(refusal.message).toContain("damaged");
    expect(refusal.message).toContain("o2b brain migrate-store --force-release-gate");
    expect(refusal.message).not.toContain("Try again when it has finished");
    expect(refusal.next_command).toBe("o2b brain migrate-store --force-release-gate");
  });
});

describe("a gate that names no vault", () => {
  test("an empty vault reads as damaged and refuses every vault", () => {
    const path = migrationGatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ vault: "", run_id: "migrate-x" }));
    const refusal = refusalOfNote();
    expect(refusal.fault?.kind).toBe("damaged");
    expect(refusal.message).toContain(path);
  });
});

describe("another vault's gate", () => {
  test("a vault link retargeted at the gated vault is refused at once", () => {
    const other = join(tmp, "other-vault");
    mkdirSync(join(other, "Brain"), { recursive: true });
    const link = join(tmp, "vault-link");
    // A junction on Windows needs no privilege; a symlink elsewhere.
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(other, link, linkType);
    plantGate("migrate-this", process.pid, OWN_IDENTITY, vault);
    expect(() => assertNoMigrationInProgress(link)).not.toThrow();
    rmSync(link, { recursive: false, force: true });
    symlinkSync(vault, link, linkType);
    expect(() => assertNoMigrationInProgress(link)).toThrow(MigrationInProgressError);
  });

  test("resolves the two spellings once for a pass of writes, and never answers stale", () => {
    const other = join(tmp, "other-vault");
    mkdirSync(other, { recursive: true });
    plantGate("migrate-other", process.pid, OWN_IDENTITY, other);
    const before = migrationGateResolveCount();
    const statsBefore = migrationGateStatCount();
    for (let i = 0; i < 2000; i++) assertNoMigrationInProgress(vault);
    // The two spellings are resolved once; what is paid per write is one
    // stat of each spelling, the identity the cached answer is keyed on.
    expect(migrationGateResolveCount() - before).toBeLessThanOrEqual(2);
    expect(migrationGateStatCount() - statsBefore).toBe(2 * 2000);
    // The gate changes to name this vault: the very next write is refused.
    plantGate("migrate-this", process.pid, OWN_IDENTITY, vault);
    expect(() => assertNoMigrationInProgress(vault)).toThrow(MigrationInProgressError);
    // And back to the other vault: the write passes again.
    plantGate("migrate-other", process.pid, OWN_IDENTITY, other);
    expect(() => assertNoMigrationInProgress(vault)).not.toThrow();
  });
});

describe("a migration that is running", () => {
  test("tells a refused writer how far it is", () => {
    const bench = makeMigrationBench("osb-gate-progress-");
    try {
      dropUnparseable(bench.vault);
      const messages: string[] = [];
      const note = (): void => {
        try {
          appendBrainNote({ vault: bench.vault, text: "during the run", agent: "@census" });
        } catch (error) {
          if (error instanceof MigrationInProgressError) messages.push(error.message);
        }
      };
      const result = runMigration(bench.vault, {
        settleMs: 0,
        hooks: { afterBackup: note, beforeVerify: note },
      });
      expect(result.ok).toBe(true);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("backed up, importing the legacy tree");
      expect(messages[1]).toContain("verifying");
    } finally {
      bench.cleanup();
    }
  });
});

describe("a caller-named destination and the gated vault", () => {
  // Whole path components decide: a name that merely starts with dots, or a
  // sibling whose name starts with the vault's, is not the same place.
  const CASES: ReadonlyArray<readonly [string, (v: string, parent: string) => string, boolean]> = [
    ["the vault itself", (v) => v, true],
    ["a file in it", (v) => join(v, "export.json"), true],
    ['a folder named "..notes" in it', (v) => join(v, "..notes", "export.json"), true],
    ["its parent, spelled with ..", (v) => join(v, ".."), false],
    ["a sibling, spelled ../x", (v) => join(v, "..", "x"), false],
    [
      "a sibling whose name starts with the vault's",
      (v, parent) => join(parent, "vault-other", "x"),
      false,
    ],
  ];
  for (const [label, spell, inside] of CASES) {
    test(`${label}: ${inside ? "refused" : "left alone"}`, () => {
      plantGate("migrate-dest", process.pid, OWN_IDENTITY, vault);
      const check = () => assertDestinationOutsideGatedVault(spell(vault, tmp));
      if (inside) expect(check).toThrow(MigrationInProgressError);
      else expect(check).not.toThrow();
    });
  }
});
