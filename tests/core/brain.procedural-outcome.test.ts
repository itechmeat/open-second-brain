import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  proceduralSuccessRate,
  rankProceduralMemory,
  recordProceduralOutcome,
  reconcileProceduralMemory,
} from "../../src/core/brain/procedural-memory.ts";
import { proceduralMemoryUsagePath } from "../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-proc-outcome-"));
  mkdirSync(join(vault, "Brain", "procedures"), { recursive: true });
  writeFileSync(join(vault, "Brain", "procedures", "alpha.md"), "# Alpha\n\nA reliable runbook.\n");
  writeFileSync(join(vault, "Brain", "procedures", "beta.md"), "# Beta\n\nA flaky runbook.\n");
  reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function idFor(title: string): string {
  const e = listProceduralMemory(vault).find((x) => x.title === title);
  if (!e) throw new Error(`no entry ${title}`);
  return e.id;
}

test("fresh entries carry zero outcome counters and a null success rate", () => {
  const entries = listProceduralMemory(vault);
  expect(entries.length).toBe(2);
  for (const e of entries) {
    expect(e.successCount).toBe(0);
    expect(e.failureCount).toBe(0);
    expect(proceduralSuccessRate(e)).toBeNull();
  }
});

test("recordProceduralOutcome accumulates success/failure counters", () => {
  const alpha = idFor("Alpha");
  recordProceduralOutcome(vault, alpha, "success");
  recordProceduralOutcome(vault, alpha, "success");
  recordProceduralOutcome(vault, alpha, "failure");
  const e = listProceduralMemory(vault).find((x) => x.id === alpha)!;
  expect(e.successCount).toBe(2);
  expect(e.failureCount).toBe(1);
  expect(proceduralSuccessRate(e)).toBeCloseTo(2 / 3, 6);
});

test("an unknown id returns null", () => {
  expect(recordProceduralOutcome(vault, "pmem-nope", "success")).toBeNull();
});

test("ranking surfaces the proven procedure above the failing one", () => {
  const alpha = idFor("Alpha");
  const beta = idFor("Beta");
  recordProceduralOutcome(vault, alpha, "success");
  recordProceduralOutcome(vault, alpha, "success");
  recordProceduralOutcome(vault, beta, "failure");
  recordProceduralOutcome(vault, beta, "failure");
  const ranked = rankProceduralMemory(listProceduralMemory(vault));
  expect(ranked[0]!.id).toBe(alpha); // rate 1.0
  expect(ranked[1]!.id).toBe(beta); // rate 0.0
});

test("an unproven procedure ranks between a proven-good and a proven-bad one", () => {
  const alpha = idFor("Alpha");
  const beta = idFor("Beta");
  recordProceduralOutcome(vault, alpha, "success"); // rate 1.0
  recordProceduralOutcome(vault, beta, "failure"); // rate 0.0
  // A third, unproven procedure.
  writeFileSync(join(vault, "Brain", "procedures", "gamma.md"), "# Gamma\n\nUntested.\n");
  reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
  const gamma = idFor("Gamma");
  const ranked = rankProceduralMemory(listProceduralMemory(vault)).map((e) => e.id);
  expect(ranked).toEqual([alpha, gamma, beta]);
});

test("outcome recording is order-insensitive", () => {
  const alpha = idFor("Alpha");
  for (const o of ["success", "failure", "success"] as const)
    recordProceduralOutcome(vault, alpha, o);
  const first = listProceduralMemory(vault).find((x) => x.id === alpha)!;

  // Fresh vault, reversed order.
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(join(vault, "Brain", "procedures"), { recursive: true });
  writeFileSync(join(vault, "Brain", "procedures", "alpha.md"), "# Alpha\n\nA reliable runbook.\n");
  reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
  for (const o of ["success", "success", "failure"] as const)
    recordProceduralOutcome(vault, alpha, o);
  const second = listProceduralMemory(vault).find((x) => x.id === alpha)!;

  expect(second.successCount).toBe(first.successCount);
  expect(second.failureCount).toBe(first.failureCount);
});

test("outcome-free usage sidecar stays byte-identical (no outcome keys written)", () => {
  const alpha = idFor("Alpha");
  markProceduralMemoryUsed(vault, alpha);
  const usage = readFileSync(proceduralMemoryUsagePath(vault), "utf8");
  expect(usage).not.toContain("successCount");
  expect(usage).not.toContain("failureCount");
});
