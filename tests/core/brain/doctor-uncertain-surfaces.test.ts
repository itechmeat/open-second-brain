/**
 * The doctor's `uncertain` stream, and the two producers that were
 * written for it and never wired to it.
 *
 * `vaultMarkerAbsentNotice` shipped pure, throwing, tested - and with no
 * caller inside `runDoctor`, so the one condition an unmarked root is
 * diagnostic of (a mis-resolved vault materialized by its first write)
 * never reached the one command an operator runs to check the store.
 *
 * `scanStaleLocks` shipped with a docblock reading "the brain doctor
 * surfaces these" and `rg scanStaleLocks src/` matching only its own
 * definition. The lock primitive deliberately has no breaker, so a lock
 * a SIGKILLed writer left behind is recoverable ONLY by an operator
 * deleting it - which requires something to name it first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import { recordLineageObservation } from "../../../src/core/brain/lineage/ledger.ts";
import {
  resetVaultIdentityPins,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-uncertain-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  resetVaultIdentityPins();
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function codes(): string[] {
  return (runDoctor(vault).uncertain ?? []).map((entry) => entry.code);
}

describe("runDoctor — the vault identity marker", () => {
  test("an unmarked root is reported as uncertainty, naming the root", () => {
    const entry = (runDoctor(vault).uncertain ?? []).find(
      (u) => u.code === DEGRADATION_CODE.vaultMarkerAbsent,
    );
    expect(entry).toBeDefined();
    expect(entry!.path).toBeDefined();
    expect(entry!.message).toContain("o2b brain init");
  });

  test("a marked root reports nothing", () => {
    writeVaultIdentity(vault);
    expect(codes()).not.toContain(DEGRADATION_CODE.vaultMarkerAbsent);
  });

  test("a CORRUPT marker reads as absent, never as a mismatch", () => {
    writeFileSync(join(vault, "Brain", "vault-id.json"), "{ not json", "utf8");
    expect(codes()).toContain(DEGRADATION_CODE.vaultMarkerAbsent);
    // And the doctor still completes: a corrupt marker is a warning
    // condition, not a refusal.
    expect(runDoctor(vault).errors).toEqual([]);
  });

  test("it never throws the doctor", () => {
    rmSync(join(vault, "Brain", "_brain.yaml"));
    expect(() => runDoctor(vault)).not.toThrow();
  });
});

describe("runDoctor — writer locks left on disk", () => {
  test("a held lock under Brain/ is named with its path", () => {
    writeVaultIdentity(vault);
    const target = join(vault, "Brain", "log", "continuity", "2026-06.jsonl");
    mkdirSync(join(vault, "Brain", "log", "continuity"), { recursive: true });
    const handle = acquireLockSync(target);
    try {
      const entry = (runDoctor(vault).uncertain ?? []).find((u) => u.code === "stale-lock");
      expect(entry).toBeDefined();
      expect(entry!.path).toBe(handle.path);
      expect(entry!.message).toContain("remove the file by hand");
    } finally {
      handle.release();
    }
  });

  /**
   * The retry docblock tells an operator that a lock a crash left behind
   * is what `brain doctor` reports. For the two locks the parallel ingest
   * path takes most often that was untrue: both live in
   * `.open-second-brain/`, and the probe walked `Brain/` only, so the
   * doctor reported nothing with the lock plainly on disk.
   */
  test("a held lock under .open-second-brain/ is named with its path", () => {
    writeVaultIdentity(vault);
    const target = join(vault, ".open-second-brain", "ingest-manifest.json");
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const handle = acquireLockSync(target);
    try {
      const entry = (runDoctor(vault).uncertain ?? []).find((u) => u.code === "stale-lock");
      expect(entry).toBeDefined();
      expect(entry!.path).toBe(handle.path);
    } finally {
      handle.release();
    }
  });

  test("a vault with no locks reports none", () => {
    writeVaultIdentity(vault);
    expect(codes()).not.toContain("stale-lock");
  });
});

describe("runDoctor — lineage ledger findings reach uncertain", () => {
  test("a destroyed ledger is uncertainty, not silence", () => {
    writeVaultIdentity(vault);
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(join(vault, "Brain", ".state", "session-lineage.jsonl"), "garbage\n", "utf8");
    expect(codes()).toContain(DEGRADATION_CODE.lineageChainBroken);
  });

  test("a dropped observation is uncertainty too", () => {
    writeVaultIdentity(vault);
    recordLineageObservation(vault, { sessionId: "s-1", at: new Date().toISOString(), event: "S" });
    const ledger = join(vault, "Brain", ".state", "session-lineage.jsonl");
    const handle = acquireLockSync(ledger);
    let found: string[];
    try {
      recordLineageObservation(vault, {
        sessionId: "s-2",
        at: new Date().toISOString(),
        event: "S",
      });
      found = codes();
    } finally {
      handle.release();
    }
    expect(found).toContain(DEGRADATION_CODE.lineageObservationDropped);
  });
});
