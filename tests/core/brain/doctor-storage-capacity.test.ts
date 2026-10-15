/**
 * The storage-capacity doctor check.
 *
 * Claims pinned here:
 *
 *   1. With a cap configured, a vault measured inside the warn band
 *      emits a warning issue and a vault past the critical band emits an
 *      error issue, both under registered codes; without a cap the check
 *      is inert - no cap, nothing to report.
 *   2. An unmeasurable store lands an `uncertain` entry naming the
 *      refused surface, never a fake all-clear.
 *   3. The store is measured at `ctx.dbPath` when the pass carries one,
 *      fail-soft: the doctor's resolved store path is the one that gets
 *      measured, and an absent one falls back to the default resolution.
 *   4. Below local reach the reading is not reported at all: the check
 *      answers in the uncertain stream, by name, and neither the warn
 *      nor the critical issue - either would carry the census in its
 *      message - is emitted. Absent reach reads as local, so the shell
 *      caller's report is unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  STORAGE_CAPACITY_CRITICAL_CODE,
  STORAGE_CAPACITY_UNMEASURED_CODE,
  STORAGE_CAPACITY_WARN_CODE,
} from "../../../src/core/brain/doctor/storage-capacity.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-storage-"));
  // Minimal Brain skeleton, the doctor-drift pattern.
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(brainConfigPath(vault), "schema_version: 1\n", "utf8");
  writeFileSync(join(vault, "Brain", "_BRAIN.md"), "---\ntitle: Brain\n---\n", "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function configureCap(capBytes: number): void {
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\n\nstorage:\n  cap_bytes: ${capBytes}\n`,
    "utf8",
  );
}

function writePage(totalBytes: number): void {
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(join(vault, "Brain", "sources", "AA-page.md"), "x".repeat(totalBytes), "utf8");
}

describe("storageCapacityCheck", () => {
  test("an unbounded vault is silent - no cap, nothing to report", () => {
    writePage(50_000);
    const result = runDoctor(vault);
    expect(result.warnings.filter((i) => i.code === STORAGE_CAPACITY_WARN_CODE)).toEqual([]);
    expect(result.errors.filter((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE)).toEqual([]);
  });

  test("usage inside the warn band is silent", () => {
    configureCap(1_000_000);
    writePage(10_000);
    const result = runDoctor(vault);
    expect(result.warnings.filter((i) => i.code === STORAGE_CAPACITY_WARN_CODE)).toEqual([]);
    expect(result.errors.filter((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE)).toEqual([]);
  });

  test("usage past the warn band warns", () => {
    configureCap(10_000);
    writePage(9_000);
    const result = runDoctor(vault);
    const warns = result.warnings.filter((i) => i.code === STORAGE_CAPACITY_WARN_CODE);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("storage");
  });

  test("usage past the critical band is an error", () => {
    configureCap(10_000);
    writePage(20_000);
    const result = runDoctor(vault);
    const errors = result.errors.filter((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE);
    expect(errors).toHaveLength(1);
    // The measured fact travels in the message.
    expect(errors[0]!.message).toMatch(/\d+ bytes/);
  });

  test("below local reach the reading is not reported - the reach is named instead", () => {
    configureCap(10_000);
    writePage(20_000);
    const result = runDoctor(vault, { reach: TRANSPORT_REACH.remote });
    // Neither tier issue is emitted: each would carry the whole-vault
    // census in its message prose.
    expect(result.errors.filter((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE)).toEqual([]);
    expect(result.warnings.filter((i) => i.code === STORAGE_CAPACITY_WARN_CODE)).toEqual([]);
    const unmeasured = (result.uncertain ?? []).filter(
      (e) => e.code === STORAGE_CAPACITY_UNMEASURED_CODE,
    );
    expect(unmeasured).toHaveLength(1);
    expect(unmeasured[0]!.message).toContain("reach");
    expect(unmeasured[0]!.message).not.toMatch(/\d/);
  });

  test("at local reach - named or absent - the reading is reported as before", () => {
    configureCap(10_000);
    writePage(20_000);
    for (const reach of [TRANSPORT_REACH.local, undefined]) {
      const result = runDoctor(vault, reach === undefined ? {} : { reach });
      expect(result.errors.some((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE)).toBe(true);
    }
  });

  test("both codes resolve to a registered next command", () => {
    for (const code of [STORAGE_CAPACITY_WARN_CODE, STORAGE_CAPACITY_CRITICAL_CODE]) {
      const signal = DIAGNOSTIC_SIGNALS.get(code);
      expect(signal).toBeDefined();
      expect(signal!.nextCommand.startsWith("o2b ")).toBe(true);
      expect(signal!.autoRepairable).toBe(false);
    }
  });

  test("the store is measured at ctx.dbPath when the pass carries one", () => {
    configureCap(10_000);
    // The pass names a 20 KB store outside the Brain tree; measured
    // usage crosses the critical band only if that path was used.
    const dbPath = join(vault, "elsewhere.sqlite");
    writeFileSync(dbPath, Buffer.alloc(20_000, 0x78), "utf8");
    const result = runDoctor(vault, { dbPath });
    expect(
      result.errors.some((i) => i.code === STORAGE_CAPACITY_CRITICAL_CODE),
      "the named store should be the one measured",
    ).toBe(true);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unmeasurable store lands an uncertain entry, not an all-clear",
    () => {
      configureCap(10_000);
      writePage(9_000);
      mkdirSync(join(vault, "Brain", ".artifacts"), { recursive: true });
      chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
      try {
        const result = runDoctor(vault);
        expect(result.warnings.filter((i) => i.code === STORAGE_CAPACITY_WARN_CODE)).toEqual([]);
        const unmeasured = (result.uncertain ?? []).filter(
          (e) => e.code === STORAGE_CAPACITY_UNMEASURED_CODE,
        );
        expect(unmeasured).toHaveLength(1);
        expect(unmeasured[0]!.message).toContain("artifacts");
      } finally {
        chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
      }
    },
  );
});
