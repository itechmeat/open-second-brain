/**
 * Unit J - guard against writes to an unexpected memory-store location.
 *
 * `resolveVault` returns a path from four branches with no existence
 * validation at all, and the first Brain write materializes whatever it
 * got. These tests pin the two halves of the answer: an unmarked root is
 * ambiguous and warns, a root whose recorded identity changed under a
 * live process is unambiguous and refuses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActive } from "../../../src/core/brain/active.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { collectExportRows } from "../../../src/core/brain/export.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { regenerateLessons } from "../../../src/core/brain/lessons.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { brainDirs, brainDirsForWrite } from "../../../src/core/brain/paths.ts";
import {
  applyPending,
  listPending,
  rejectPending,
  stagePendingSignal,
} from "../../../src/core/brain/pending.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { retireSignal } from "../../../src/core/brain/signal-retire.ts";
import { computeBrainStatus } from "../../../src/core/brain/status.ts";
import { runBrainWatchdog } from "../../../src/core/brain/watchdog.ts";
import {
  VaultIdentityMismatchError,
  readVaultIdentity,
  resetVaultIdentityPins,
  vaultIdentityPath,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";
import type { DegradationNotice } from "../../../src/core/integrity/degradation.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vault-identity-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-vault-identity-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  resetVaultIdentityPins();
});

describe("vault identity marker", () => {
  test("writing is idempotent and records no machine-local path", () => {
    const first = writeVaultIdentity(vault);
    const second = writeVaultIdentity(vault);
    expect(second.vault_id).toBe(first.vault_id);
    expect(readVaultIdentity(vault)?.vault_id).toBe(first.vault_id);
    // The marker travels with the vault across synced devices, so it must
    // carry no absolute path - a machine-local key is stale on every peer.
    expect(JSON.stringify(first)).not.toContain(vault);
    expect(first.schema_version).toBe(1);
  });

  test("an unreadable or malformed marker reads as absent, never as a mismatch", () => {
    writeFileSync(vaultIdentityPath(vault), "{ not json", "utf8");
    expect(readVaultIdentity(vault)).toBeNull();
  });
});

describe("brainDirsForWrite", () => {
  test("returns the same directories as brainDirs", () => {
    writeVaultIdentity(vault);
    expect(brainDirsForWrite(vault)).toEqual(brainDirs(vault));
  });

  test("an absent marker warns instead of refusing", () => {
    const notices: DegradationNotice[] = [];
    const dirs = brainDirsForWrite(vault, notices);
    expect(dirs.brain).toBe(brainDirs(vault).brain);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe("vault-marker-absent");
    expect(notices[0]!.path).toBe(vault);
  });

  test("a marker that changed under a live process refuses the write", () => {
    writeVaultIdentity(vault);
    // First write pins what this process is writing to.
    brainDirsForWrite(vault);

    // The store at this path is now a different vault.
    rmSync(vaultIdentityPath(vault));
    const replacement = writeVaultIdentity(vault);

    let raised: unknown;
    try {
      brainDirsForWrite(vault);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(VaultIdentityMismatchError);
    const error = raised as VaultIdentityMismatchError;
    expect(error.notice.code).toBe("vault-marker-mismatch");
    expect(error.message).toContain(replacement.vault_id);
    expect(error.message).toContain(vault);
  });

  test("a matching marker never refuses, however many writes follow", () => {
    writeVaultIdentity(vault);
    for (let i = 0; i < 3; i++) expect(() => brainDirsForWrite(vault)).not.toThrow();
  });
});

/**
 * The guard is only worth its docblock if it fires on the write paths
 * an operator actually drives, not just on the three call sites the
 * first cut converted. One row per representative Brain writer; adding
 * a writer that skips the guard makes its row fail.
 */
describe("the guard fires on Brain write paths", () => {
  interface WriteCase {
    readonly name: string;
    /** Bring the vault into the state the write needs. */
    readonly seed?: (vault: string) => void;
    readonly write: (vault: string) => void;
  }

  const SIGNAL_INPUT = {
    topic: "guard-topic",
    signal: "positive",
    agent: "test-agent",
    principle: "guard the write path",
    created_at: "2026-07-26T00:00:00Z",
    date: "2026-07-26",
    slug: "guard-topic",
  } as const;

  const CASES: ReadonlyArray<WriteCase> = [
    {
      name: "writeSignal",
      write: (v) => void writeSignal(v, SIGNAL_INPUT),
    },
    {
      name: "appendLogEvent",
      write: (v) =>
        appendLogEvent(v, {
          timestamp: "2026-07-26T00:00:00Z",
          eventType: "note",
          agent: "test-agent",
          body: { text: "guarded" },
        }),
    },
    {
      name: "retireSignal",
      seed: (v) => void writeSignal(v, SIGNAL_INPUT),
      write: (v) => void retireSignal(v, "sig-2026-07-26-guard-topic", { reason: "obsolete" }),
    },
    {
      name: "stagePendingSignal",
      write: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
    },
    {
      name: "applyPending",
      seed: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
      write: (v) => void applyPending(v, "sig-2026-07-26-guard-topic"),
    },
    {
      name: "rejectPending",
      seed: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
      write: (v) => void rejectPending(v, "sig-2026-07-26-guard-topic", "not durable"),
    },
    {
      name: "regenerateActive",
      write: (v) => void regenerateActive(v),
    },
    {
      name: "regenerateLessons",
      write: (v) => void regenerateLessons(v),
    },
    {
      // Every watchdog run appends an audit record under `Brain/log/`,
      // so the probe form is a write path too - not only the remediating
      // one, which also creates and replaces directories.
      name: "runBrainWatchdog",
      write: (v) => void runBrainWatchdog(v, { remediate: true }),
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.name} refuses a vault whose marker changed`, () => {
      bootstrapBrain(vault, { configPath });
      testCase.seed?.(vault);
      // Pin what this process has been writing to.
      brainDirsForWrite(vault);

      // The store under this path is now a different vault.
      rmSync(vaultIdentityPath(vault));
      writeVaultIdentity(vault);

      expect(() => testCase.write(vault)).toThrow(VaultIdentityMismatchError);
    });
  }
});

/**
 * The other half of the contract: widening the guard onto read paths
 * would break the fail-open surfaces (`src/openclaw`, the hooks), so a
 * read must stay indifferent to the marker.
 */
describe("the guard stays off read paths", () => {
  const READS: ReadonlyArray<{ name: string; read: (vault: string) => void }> = [
    { name: "listPending", read: (v) => void listPending(v) },
    { name: "runDoctor", read: (v) => void runDoctor(v) },
    { name: "computeBrainStatus", read: (v) => void computeBrainStatus(v) },
    { name: "collectExportRows", read: (v) => void collectExportRows(v) },
  ];

  for (const testCase of READS) {
    test(`${testCase.name} is indifferent to a changed marker`, () => {
      bootstrapBrain(vault, { configPath });
      brainDirsForWrite(vault);
      rmSync(vaultIdentityPath(vault));
      writeVaultIdentity(vault);
      expect(() => testCase.read(vault)).not.toThrow();
    });
  }
});

describe("bootstrap path", () => {
  test("o2b brain init stamps the marker and never trips the guard", () => {
    expect(existsSync(vaultIdentityPath(vault))).toBe(false);
    expect(() => bootstrapBrain(vault, { configPath })).not.toThrow();
    const identity = readVaultIdentity(vault);
    expect(identity).not.toBeNull();

    // A second bootstrap keeps the identity it already established.
    bootstrapBrain(vault, { configPath });
    expect(readVaultIdentity(vault)!.vault_id).toBe(identity!.vault_id);

    const notices: DegradationNotice[] = [];
    expect(() => brainDirsForWrite(vault, notices)).not.toThrow();
    expect(notices).toHaveLength(0);
  });
});
