/**
 * The doctor names a frozen vault (who-wrote-what, Task C).
 *
 * A freeze is a standing condition rather than a fault, and it is the
 * condition that explains every other symptom an operator might chase:
 * writes that vanish, a pass that reports nothing, an agent that keeps
 * apologising. So it is a WARNING with an exact next command, never an
 * error and never silence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { VAULT_FROZEN_CODE } from "../../../src/core/brain/doctor/frozen-check.ts";
import { freezeVault, unfreezeVault } from "../../../src/core/brain/freeze.ts";
import { frozenMarkerPath, resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-frozen-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

describe("the frozen-vault check", () => {
  test("says nothing about a vault nobody froze", async () => {
    const report = await runDoctor(vault);
    expect(report.warnings.filter((i) => i.code === VAULT_FROZEN_CODE)).toHaveLength(0);
  });

  test("warns while the marker stands, naming who froze it and why", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    const report = await runDoctor(vault);
    const found = report.warnings.filter((i) => i.code === VAULT_FROZEN_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.message).toContain("@operator");
    expect(found[0]!.message).toContain("migrating");
    expect(found[0]!.path).toBe(frozenMarkerPath(vault));
  });

  test("stops warning once the freeze is lifted", async () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating" });
    unfreezeVault(vault, { agent: "@operator" });
    const report = await runDoctor(vault);
    expect(report.warnings.filter((i) => i.code === VAULT_FROZEN_CODE)).toHaveLength(0);
  });

  test("warns about a marker nobody can parse, which freezes just the same", async () => {
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(frozenMarkerPath(vault), "{ not json", "utf8");
    const report = await runDoctor(vault);
    expect(report.warnings.filter((i) => i.code === VAULT_FROZEN_CODE)).toHaveLength(1);
  });
});

describe("the exit", () => {
  test("the finding carries the one command that lifts it", () => {
    const signal = DIAGNOSTIC_SIGNALS.get(VAULT_FROZEN_CODE);
    expect(signal).toBeDefined();
    expect(signal!.nextCommand).toBe("o2b brain unfreeze");
    // A freeze is an operator's decision; no repair pass may undo one.
    expect(signal!.autoRepairable).toBe(false);
  });
});
