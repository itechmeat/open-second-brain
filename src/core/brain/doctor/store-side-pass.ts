/**
 * The doctor pass of a machine with no vault and a readable brain store,
 * and of a store-only machine whose vault holds no `Brain/` (design D14,
 * task 2.10).
 *
 * There is no legacy tree to check, so the vault pass's record, log and
 * link checks have nothing to read. What still holds is the store side:
 * the store itself (`store-check.ts`: root, partitions, write failures,
 * trust), the human view writer (`view-writer-check.ts`) and this
 * machine's device-local state (`device-state-check.ts`). Those checks
 * take a {@link StoreSideCheckContext}, which carries no vault, and run
 * here exactly as they run in the vault pass.
 */

import { computeTrustVerdict } from "../trust/compute-trust-verdict.ts";
import type { TrustVerdict } from "../types.ts";
import type { DoctorFindings, StoreSideDoctorCheck } from "./check.ts";
import { adoptConflictsCheck } from "./adopt-conflicts-check.ts";
import { deviceStateCheck } from "./device-state-check.ts";
import type { RunDoctorOptions, RunDoctorResult } from "./report.ts";
import { storeCheck } from "./store-check.ts";
import { viewWriterCheck } from "./view-writer-check.ts";

/** The store-side checks, in the order the vault pass runs them. */
export const STORE_SIDE_CHECKS: ReadonlyArray<StoreSideDoctorCheck> = Object.freeze([
  storeCheck,
  viewWriterCheck,
  deviceStateCheck,
  adoptConflictsCheck,
]);

/**
 * Run the store-side checks and report them as a doctor result: with no
 * vault, or for a vault with no `Brain/` on a store-only machine, where
 * the store is the brain and the vault pass has nothing to read.
 */
export function runStoreSideDoctor(
  opts: RunDoctorOptions = {},
  vault: string | null = null,
): RunDoctorResult {
  const findings: DoctorFindings = { issues: [], uncertain: [] };
  const ctx = {
    vault,
    now: opts.now ?? new Date(),
    dbPath: opts.dbPath,
    configPath: opts.configPath,
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    ...(opts.reach !== undefined ? { reach: opts.reach } : {}),
  };
  for (const check of STORE_SIDE_CHECKS) {
    if (!check.failSoft) {
      check.run(ctx, findings);
      continue;
    }
    try {
      check.run(ctx, findings);
    } catch {
      /* doctor never throws */
    }
  }
  const warnings = findings.issues.filter((i) => i.severity === "warning");
  const errors = findings.issues.filter((i) => i.severity === "error");
  const trustVerdict: TrustVerdict = computeTrustVerdict({
    doctorWarnings: warnings,
    doctorErrors: errors,
    dreamWarnings: [],
    verification: { confirmed: 0, drift: 0, regression: 0, missing_evidence: 0 },
  });
  return Object.freeze({
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
    trust_verdict: trustVerdict,
    instruction_file_warnings: Object.freeze([]),
    ...(findings.uncertain.length > 0 ? { uncertain: Object.freeze(findings.uncertain) } : {}),
  });
}
