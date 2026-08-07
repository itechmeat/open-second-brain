/**
 * `o2b brain repair-lane` (G1, t_6832aac6): the deterministic memory-graph
 * repair lane.
 *
 * Dry-run is the default and writes nothing; --apply writes edges and requires
 * the exact confirmation phrase via --confirm. Candidates come from structural
 * signals only (explicit references, session continuity, same-topic evidence);
 * inferred candidates are opt-in behind --include-inferred. Each decision is
 * reported with its identity strength, confidence, and action.
 *
 * ## The holdout gate (what-the-index-already-knew, final unit)
 *
 * The changelog has promised since v1.36.0 that "the paired holdout harness
 * measures graph lift separately from direct recall and fails the gate on any
 * dangling or unhydrated target". The harness (`link-graph/graph-holdout.ts`)
 * was written and tested and reached by nothing, so no operator could meet the
 * gate. This verb is its production caller.
 *
 * It rides on --apply rather than on a flag of its own, because the verb
 * already models the two modes the gate needs: dry-run is the preview and
 * stays byte-identical, --apply is the write path and is what the gate
 * refuses. An apply therefore PLANS first - one dry run, which writes nothing
 * - evaluates the harness over the edges that plan proposes, and only then
 * writes. Fail-closed on the harness's own terms: the refusal is
 * `HoldoutGateResult.passed`, not a second notion of pass derived here.
 *
 * The holdouts are every edge the lane proposes, not only the ones it would
 * write. A candidate the lane skips as `skip-missing-target` still came out of
 * the same structural evidence as the ones it keeps, and a graph whose
 * evidence base points at absent memory is exactly what the harness exists to
 * catch. Restricting the population to accepted writes would also make the
 * dangling half of the gate unreachable by construction, since the lane
 * already existence-checks every endpoint it writes.
 */

import {
  REPAIR_CONFIRM_PHRASE,
  RepairConfirmationError,
  collectRepairCandidates,
  runRepairLane,
  type RepairDecision,
  type RepairReport,
} from "../../../core/brain/link-graph/repair-lane.ts";
import {
  evaluateGraphHoldouts,
  type GraphHoldout,
  type HoldoutGateResult,
} from "../../../core/brain/link-graph/graph-holdout.ts";
import { REPAIR_HOLDOUT_UNRESOLVED_CODE } from "../../../core/brain/diagnostics.ts";
import { NEXT_COMMAND_KEY, requireNextStep } from "../../../core/brain/next-step.ts";
import { brainVerbContext, ok, okJson, parse } from "../helpers.ts";
import { fail } from "../../output.ts";

/**
 * The gate's exit, resolved once at module scope: a registry that stopped
 * carrying this code fails at import rather than inside the refusal it was
 * meant to explain.
 */
const HOLDOUT_GATE_EXIT = requireNextStep(REPAIR_HOLDOUT_UNRESOLVED_CODE);

/** Upper bound on the individual failing edges a refusal names inline. */
const MAX_NAMED_HOLDOUT_FAILURES = 5;

/** Per-edge verdicts the refusal uses to say WHY a target did not qualify. */
const HOLDOUT_FAILURE_LABEL = Object.freeze({
  dangling: "dangling",
  unhydrated: "unhydrated",
} as const);

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

/** Every edge the lane proposes, as an (anchor, target) holdout pair. */
function holdoutsFor(decisions: readonly RepairDecision[]): GraphHoldout[] {
  return decisions.map((decision) => ({ anchor: decision.source, target: decision.target }));
}

function holdoutJson(gate: HoldoutGateResult): Record<string, unknown> {
  return {
    passed: gate.passed,
    total: gate.total,
    resolved: gate.resolvedCount,
    dangling: gate.danglingCount,
    unhydrated: gate.unhydratedCount,
    direct_recall: gate.directRecall,
    graph_lift: gate.graphLift,
  };
}

/** The failing edges, each labelled with the verdict that failed it. */
function failingEdges(gate: HoldoutGateResult): string[] {
  return gate.resolutions
    .filter((resolution) => !resolution.hydrated)
    .map((resolution) => {
      const label = resolution.dangling
        ? HOLDOUT_FAILURE_LABEL.dangling
        : HOLDOUT_FAILURE_LABEL.unhydrated;
      return `${resolution.holdout.anchor} -> ${resolution.holdout.target} (${label})`;
    });
}

function holdoutRefusalMessage(gate: HoldoutGateResult): string {
  const failures = failingEdges(gate);
  const named = failures.slice(0, MAX_NAMED_HOLDOUT_FAILURES);
  const hidden = failures.length - named.length;
  const more = hidden > 0 ? ` and ${hidden} more` : "";
  return (
    `repair-lane holdout gate refused the apply: of ${gate.total} proposed edge(s), ` +
    `${gate.danglingCount} target(s) resolve to no durable memory and ` +
    `${gate.unhydratedCount} hydrate into no evidence ` +
    `(graph lift ${gate.graphLift}, direct recall ${gate.directRecall}). ` +
    `No edge was written. Unresolved: ${named.join("; ")}${more}. ` +
    `Run ${HOLDOUT_GATE_EXIT.nextCommand} to find the absent or empty notes behind them, ` +
    `then re-run the apply.`
  );
}

/**
 * The report payload. `gate` is null on the dry-run path, where the gate is
 * not evaluated at all and the payload must stay byte-identical.
 */
function reportJson(report: RepairReport, gate: HoldoutGateResult | null): Record<string, unknown> {
  return {
    mode: report.mode,
    written: report.written,
    decisions: report.decisions.map(decisionJson),
    ...(gate === null ? {} : { holdout: holdoutJson(gate) }),
  };
}

function renderReport(
  report: RepairReport,
  gate: HoldoutGateResult | null,
  applied: boolean,
): void {
  ok(
    `repair-lane (${report.mode}): ${report.decisions.length} candidate(s), ${report.written} edge(s) written`,
  );
  for (const decision of report.decisions) {
    ok(
      `  [${decision.strength} ${decision.confidence.toFixed(2)}] ${decision.action}: ${decision.source} -> ${decision.target}`,
    );
  }
  if (gate !== null) {
    ok(
      `  holdout gate: ${gate.total} edge(s) verified, graph lift ${gate.graphLift}, direct recall ${gate.directRecall}`,
    );
  }
  if (!applied && report.written > 0) {
    ok(`  re-run with --apply --confirm ${JSON.stringify(REPAIR_CONFIRM_PHRASE)} to write`);
  }
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
  const asJson = flags["json"] === true;
  const apply = flags["apply"] === true;
  const laneOptions = { includeInferred: flags["include-inferred"] === true };

  const refuse = (message: string, payload: Record<string, unknown> = {}): number => {
    if (asJson) {
      okJson({ ok: false, message, ...payload });
      return 1;
    }
    return fail(message);
  };

  // The confirmation phrase is a precondition of the invocation, checked
  // before anything is collected or planned so that a refused apply leaves
  // stdout a pure error envelope under --json. `runRepairLane` re-checks it
  // below; this is the same typed error, not a second rule.
  if (apply && flags["confirm"] !== REPAIR_CONFIRM_PHRASE) {
    const message = `${new RepairConfirmationError().message} (pass --confirm ${JSON.stringify(REPAIR_CONFIRM_PHRASE)})`;
    return refuse(message);
  }

  const candidates = collectRepairCandidates(vault);

  // Plan first, always as a dry run: the gate must see the proposed edges
  // before any of them reaches disk.
  const plan = runRepairLane(vault, candidates, { apply: false, ...laneOptions });
  if (!apply) {
    if (asJson) okJson(reportJson(plan, null));
    else renderReport(plan, null, false);
    return 0;
  }

  const gate = evaluateGraphHoldouts(vault, holdoutsFor(plan.decisions));
  if (!gate.passed) {
    return refuse(holdoutRefusalMessage(gate), {
      holdout: holdoutJson(gate),
      [NEXT_COMMAND_KEY]: HOLDOUT_GATE_EXIT.nextCommand,
    });
  }

  const report = runRepairLane(vault, candidates, {
    apply: true,
    confirm: REPAIR_CONFIRM_PHRASE,
    ...laneOptions,
  });
  if (asJson) okJson(reportJson(report, gate));
  else renderReport(report, gate, true);
  return 0;
}
