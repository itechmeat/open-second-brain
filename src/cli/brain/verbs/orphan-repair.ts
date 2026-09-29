/**
 * `o2b brain orphan-repair` (t_6cc80627): detach dangling `session_ref`
 * values from observation signals, keeping the observations.
 *
 * The only door to the detach repair. Dry-run is the default and writes
 * nothing; --apply requires the exact confirmation phrase via --confirm,
 * checked before anything is scanned so that a refused apply leaves
 * stdout a pure error envelope under --json. A hard per-run write cap
 * bounds the run; a rescan after apply converges to zero writes. The
 * doctor pass reports orphans and names this verb on the issue's `fix`
 * field - it never runs it.
 */

import {
  ORPHAN_REPAIR_CONFIRM_PHRASE,
  OrphanRepairConfirmationError,
  runOrphanRepair,
  type OrphanRepairReport,
} from "../../../core/brain/link-graph/orphan-repair.ts";
import { brainVerbContext, ok, okJson, parse } from "../helpers.ts";
import { fail } from "../../output.ts";

function reportJson(report: OrphanRepairReport): Record<string, unknown> {
  return {
    mode: report.mode,
    detached: report.detached,
    decisions: report.decisions.map((decision) => ({
      path: decision.path,
      session_ref: decision.session_ref,
      action: decision.action,
    })),
  };
}

function renderReport(report: OrphanRepairReport, applied: boolean): void {
  ok(
    `orphan-repair (${report.mode}): ${report.decisions.length} orphan(s) found, ` +
      `${report.detached} reference(s) detached, observation(s) kept`,
  );
  for (const decision of report.decisions) {
    ok(`  [${decision.action}] ${decision.path} (${decision.session_ref})`);
  }
  if (!applied && report.detached > 0) {
    ok(`  re-run with --apply --confirm ${JSON.stringify(ORPHAN_REPAIR_CONFIRM_PHRASE)} to detach`);
  }
}

export async function cmdBrainOrphanRepair(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    confirm: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const asJson = flags["json"] === true;
  const apply = flags["apply"] === true;

  const refuse = (message: string): number => {
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  };

  // The confirmation phrase is a precondition of the invocation, checked
  // before anything is scanned so that a refused apply never even reads
  // the store. `runOrphanRepair` re-checks it below; this is the same
  // typed error, not a second rule.
  if (apply && flags["confirm"] !== ORPHAN_REPAIR_CONFIRM_PHRASE) {
    const message = `${new OrphanRepairConfirmationError().message} (pass --confirm ${JSON.stringify(ORPHAN_REPAIR_CONFIRM_PHRASE)})`;
    return refuse(message);
  }

  let report;
  try {
    report = runOrphanRepair(vault, { apply, confirm: ORPHAN_REPAIR_CONFIRM_PHRASE });
  } catch (exc) {
    return refuse(`orphan repair failed: ${(exc as Error).message ?? String(exc)}`);
  }
  if (asJson) okJson(reportJson(report));
  else renderReport(report, apply);
  return 0;
}
