/**
 * The undated-quantity diagnostic signal (write-honesty, F4, t_fb442a24).
 *
 * The finding is advisory, but an advisory with no registered exit is a
 * dead end: `nextCommandField` would contribute no key and the operator
 * would read a quantity warning with nowhere to go. The claims surface is
 * the place a claim's validity is read, so the code must resolve to it by
 * name. Pinned by NAME here so the producer and the registry cannot drift
 * into two spellings of one code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { nextCommandField, resolveNextStep } from "../../../src/core/brain/next-step.ts";
import { UNDATED_QUANTITY_CODE, lintWrittenPages } from "../../../src/core/brain/page-lint.ts";
import { READ_ALL_REFS } from "../../../src/core/brain/near-duplicate.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-undated-diagnostics-"));
  for (const dir of ["preferences", "retired", "log", "inbox"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  mkdirSync(join(vault, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("the undated-quantity diagnostic signal", () => {
  test("the code is registered with the claims surface as its exit", () => {
    expect(UNDATED_QUANTITY_CODE).toBe("undated-quantity");
    expect(DIAGNOSTIC_SIGNALS.get(UNDATED_QUANTITY_CODE)).toMatchObject({
      code: UNDATED_QUANTITY_CODE,
      nextCommand: "o2b brain claims",
      autoRepairable: false,
    });
    expect(resolveNextStep(UNDATED_QUANTITY_CODE)).toMatchObject({
      code: UNDATED_QUANTITY_CODE,
      nextCommand: "o2b brain claims",
    });
    expect(nextCommandField(UNDATED_QUANTITY_CODE)).toEqual({ next_command: "o2b brain claims" });
  });

  test("an undated-quantity finding carries the resolved next command", () => {
    const rel = "Notes/Undated.md";
    writeFileSync(join(vault, rel), "---\ntitle: U\n---\n\nWe onboarded 5,000 users.\n", "utf8");
    const report = lintWrittenPages(vault, [rel], { readable: READ_ALL_REFS });
    const finding = report.findings.find((f) => f.code === UNDATED_QUANTITY_CODE);
    expect(finding).toBeDefined();
    expect(finding!.next_command).toBe(resolveNextStep(UNDATED_QUANTITY_CODE)!.nextCommand);
  });
});
