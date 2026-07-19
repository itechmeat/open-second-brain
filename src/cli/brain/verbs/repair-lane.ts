/**
 * `o2b brain repair-lane` (G1, t_6832aac6): the deterministic memory-graph
 * repair lane.
 *
 * Dry-run is the default and writes nothing; --apply writes edges and requires
 * the exact confirmation phrase via --confirm. Candidates come from structural
 * signals only (explicit references, session continuity, same-topic evidence);
 * inferred candidates are opt-in behind --include-inferred. Each decision is
 * reported with its identity strength, confidence, and action.
 */

import {
  REPAIR_CONFIRM_PHRASE,
  RepairConfirmationError,
  collectRepairCandidates,
  runRepairLane,
  type RepairDecision,
  type RepairReport,
} from "../../../core/brain/link-graph/repair-lane.ts";
import { brainVerbContext, ok, okJson, parse } from "../helpers.ts";
import { fail } from "../../output.ts";

function decisionJson(decision: RepairDecision): Record<string, unknown> {
  return {
    source: decision.source,
    target: decision.target,
    strength: decision.strength,
    confidence: decision.confidence,
    action: decision.action,
    reason: decision.reason,
  };
}

function reportJson(report: RepairReport): Record<string, unknown> {
  return {
    mode: report.mode,
    written: report.written,
    decisions: report.decisions.map(decisionJson),
  };
}

export async function cmdBrainRepairLane(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    confirm: { type: "string" },
    "include-inferred": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const candidates = collectRepairCandidates(vault);
  let report: RepairReport;
  try {
    report = runRepairLane(vault, candidates, {
      apply: flags["apply"] === true,
      ...(typeof flags["confirm"] === "string" ? { confirm: flags["confirm"] } : {}),
      includeInferred: flags["include-inferred"] === true,
    });
  } catch (error) {
    if (error instanceof RepairConfirmationError) {
      const message = `${error.message} (pass --confirm ${JSON.stringify(REPAIR_CONFIRM_PHRASE)})`;
      if (flags["json"] === true) {
        okJson({ ok: false, message });
        return 1;
      }
      return fail(message);
    }
    throw error;
  }

  if (flags["json"] === true) {
    okJson(reportJson(report));
    return 0;
  }

  ok(
    `repair-lane (${report.mode}): ${report.decisions.length} candidate(s), ${report.written} edge(s) written`,
  );
  for (const decision of report.decisions) {
    ok(
      `  [${decision.strength} ${decision.confidence.toFixed(2)}] ${decision.action}: ${decision.source} -> ${decision.target}`,
    );
  }
  if (!flags["apply"] && report.written > 0) {
    ok(`  re-run with --apply --confirm ${JSON.stringify(REPAIR_CONFIRM_PHRASE)} to write`);
  }
  return 0;
}
