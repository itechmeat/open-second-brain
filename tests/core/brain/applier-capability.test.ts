/**
 * no-dead-ends, task 8: the applier capability table.
 *
 * Three Finding-to-apply pipelines ship in this codebase and each one used
 * to decide privately what it could repair. The table is the published
 * answer - per finding code, mechanical (naming the fixer) or refused
 * (naming the reason) - and this file is the mechanism that stops the
 * table and the appliers from drifting apart.
 *
 * The table module imports nothing, deliberately (see its docblock), so
 * every code in it is a literal. That is only safe because the checks
 * below re-derive the same population from the appliers themselves and
 * fail on any disagreement in either direction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APPLIER_CAPABILITY,
  REPAIR_SURFACE,
  REPAIR_VERDICT,
  RefusedRepairError,
  UnclassifiedRepairCodeError,
  repairCapability,
  requireMechanicalRepair,
  requireRepairCapability,
} from "../../../src/core/brain/applier-capability.ts";
import {
  REPAIR_CODE,
  REPAIR_FIXER_CODES,
  applyRepair,
} from "../../../src/core/brain/diagnostics.ts";
import { LINT_CONSOLIDATE_KIND } from "../../../src/core/brain/lint-consolidate.ts";
import { applyHygienePlan } from "../../../src/core/brain/hygiene/apply.ts";
import { buildHygienePlan } from "../../../src/core/brain/hygiene/plan.ts";
import {
  HYGIENE_PROPOSED_ACTIONS,
  type HygieneFinding,
  type HygieneProposedAction,
  type HygieneScanReport,
} from "../../../src/core/brain/hygiene/types.ts";
import { applyRemediation, planRemediation } from "../../../src/core/brain/health/remediation.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  VaultIdentityMismatchError,
  assertVaultIdentityForWrite,
  resetVaultIdentityPins,
  vaultIdentityPath,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";

/** Codes whose surface is one of the appliers, per the table. */
function codesForSurface(surface: string): string[] {
  return [...APPLIER_CAPABILITY.values()]
    .filter((entry) => entry.surface === surface)
    .map((entry) => entry.code)
    .toSorted();
}

describe("applier capability table - shape", () => {
  test("every entry is keyed by its own code", () => {
    for (const [code, entry] of APPLIER_CAPABILITY) expect(entry.code).toBe(code);
    expect(APPLIER_CAPABILITY.size).toBeGreaterThan(0);
  });

  test("every mechanical entry names a fixer and every refusal names a reason", () => {
    for (const entry of APPLIER_CAPABILITY.values()) {
      if (entry.verdict === REPAIR_VERDICT.mechanical) {
        expect(entry.fixer.length).toBeGreaterThan(0);
      } else {
        expect(entry.verdict).toBe(REPAIR_VERDICT.refused);
        // A refusal with an empty reason is the dead end this release
        // exists to remove, so the emptiness check is the point.
        expect(entry.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("a code no applier owns can only be a refusal", () => {
    for (const entry of APPLIER_CAPABILITY.values()) {
      if (entry.surface !== REPAIR_SURFACE.detectorOnly) continue;
      expect(entry.verdict).toBe(REPAIR_VERDICT.refused);
    }
    // The four refusals reconnaissance verified as stated-and-deliberate.
    expect(codesForSurface(REPAIR_SURFACE.detectorOnly)).toEqual([
      "frontmatter-line-dropped",
      "link_integrity",
      "stale-lock",
      "vault-marker-absent",
    ]);
  });

  test("lookup refuses to invent an answer for an unregistered code", () => {
    expect(repairCapability("no-such-code")).toBeNull();
    expect(() => requireRepairCapability("no-such-code")).toThrow(UnclassifiedRepairCodeError);
    expect(() => requireMechanicalRepair("stale-lock")).toThrow(RefusedRepairError);
  });
});

describe("applier capability table - cannot disagree with the fixers", () => {
  test("the diagnostics fixer registry and the table name the same codes", () => {
    expect([...REPAIR_FIXER_CODES].toSorted()).toEqual(codesForSurface(REPAIR_SURFACE.diagnostics));
    for (const code of REPAIR_FIXER_CODES) {
      expect(requireMechanicalRepair(code).code).toBe(code);
    }
    expect(REPAIR_FIXER_CODES.has(REPAIR_CODE.walGap)).toBe(true);
    expect(REPAIR_FIXER_CODES.has(REPAIR_CODE.orphanedReference)).toBe(true);
  });

  test("the remediation planner's classification matches the table verdict", () => {
    const plan = planRemediation(
      {
        driftedSlugs: ["drifted"],
        contradictions: [{ aId: "pref-a", bId: "pref-b" }],
        staleClaims: [{ id: "pref-c" }],
        conceptGaps: [{ term: "concept" }],
        widePermissions: [{ path: "Brain/wide.md", isDir: false, mode: 0o644 }],
      },
      { stepCap: 10 },
    );
    const seen = new Set<string>();
    for (const step of plan.steps) {
      seen.add(step.code);
      const entry = requireRepairCapability(step.code);
      const expected =
        entry.verdict === REPAIR_VERDICT.mechanical ? "auto-safe" : ("needs-review" as const);
      expect(step.classification).toBe(expected);
    }
    // Both directions: nothing in the table claims a remediation code the
    // planner cannot produce.
    expect([...seen].toSorted()).toEqual(codesForSurface(REPAIR_SURFACE.healthRemediation));
  });

  test("the hygiene plan executes exactly the actions the table calls mechanical", () => {
    const mechanical: string[] = [];
    const refused: string[] = [];
    for (const action of HYGIENE_PROPOSED_ACTIONS) {
      const plan = buildHygienePlan(reportWithAction(action));
      if (plan.selected.length === 1) mechanical.push(action);
      else if (plan.excluded_review.length === 1) refused.push(action);
      else throw new Error(`hygiene action '${action}' was neither selected nor excluded`);
    }
    expect(mechanical.toSorted()).toEqual(
      codesForSurface(REPAIR_SURFACE.hygieneApply).filter(
        (code) => APPLIER_CAPABILITY.get(code)!.verdict === REPAIR_VERDICT.mechanical,
      ),
    );
    expect(refused).toEqual(["review"]);
  });

  test("the lint-consolidate fix kinds are the table's lint entries", () => {
    const kinds: string[] = Object.values(LINT_CONSOLIDATE_KIND);
    expect(kinds.toSorted()).toEqual(codesForSurface(REPAIR_SURFACE.lintConsolidate));
  });
});

function reportWithAction(action: HygieneProposedAction): HygieneScanReport {
  const finding: HygieneFinding = {
    id: `probe:${action}`,
    detector: "dedup",
    severity: "action",
    title: `probe for ${action}`,
    targets: ["pref-a", "pref-b"],
    proposed_action: action,
    evidence: {},
  };
  return {
    generated_at: "2026-07-25T00:00:00Z",
    detectors_run: ["dedup"],
    findings: [finding],
    counts: { dedup: 1 },
    errors: [],
  };
}

// ----- Write-guard placement ------------------------------------------------

let vault: string;
let configDir: string;

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-capability-vault-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-capability-cfg-"));
  const configPath = join(configDir, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * Put the resolved root into the ONE state the guard refuses: a marker
 * this process already pinned, replaced by a different one.
 */
function makeVaultIdentityMismatch(): void {
  writeVaultIdentity(vault);
  assertVaultIdentityForWrite(vault);
  atomicWriteFileSync(
    vaultIdentityPath(vault),
    `${JSON.stringify(
      { schema_version: 1, vault_id: "f".repeat(32), created_at: "2026-01-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  );
}

describe("write-guard placement is identical across the three appliers", () => {
  const emptyHygienePlan = Object.freeze({
    selected: Object.freeze([]),
    excluded_review: Object.freeze([]),
    unknown_ids: Object.freeze([]),
  });
  const now = new Date("2026-07-25T00:00:00Z");

  test("a dry run previews against a root the guard would refuse to write", async () => {
    makeVaultIdentityMismatch();

    expect(applyRepair(vault, { dryRun: true }).dryRun).toBe(true);
    expect(
      (await applyHygienePlan(vault, emptyHygienePlan, { dryRun: true, agent: "t", now })).dry_run,
    ).toBe(true);
    expect(
      applyRemediation(vault, planRemediation(NO_FINDINGS, { stepCap: 1 }), { dryRun: true })
        .dryRun,
    ).toBe(true);
  });

  test("a real apply refuses on the same root", async () => {
    makeVaultIdentityMismatch();

    expect(() => applyRepair(vault, { dryRun: false })).toThrow(VaultIdentityMismatchError);
    await expect(
      applyHygienePlan(vault, emptyHygienePlan, { dryRun: false, agent: "t", now }),
    ).rejects.toThrow(VaultIdentityMismatchError);
    expect(() =>
      applyRemediation(vault, planRemediation(NO_FINDINGS, { stepCap: 1 }), { dryRun: false }),
    ).toThrow(VaultIdentityMismatchError);
  });
});

const NO_FINDINGS = Object.freeze({
  driftedSlugs: Object.freeze([]),
  contradictions: Object.freeze([]),
  staleClaims: Object.freeze([]),
  conceptGaps: Object.freeze([]),
});
