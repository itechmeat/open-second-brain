/**
 * `o2b brain dream [run] [--dry-run] [--step S] [--gate N=V] | stage |
 * validate <run-id> | apply <run-id> | discard <run-id> | list` - the
 * learning pass plus the staged lifecycle (t_ae8a8ec0). `run` (the
 * default, kept positional-free for back-compat) promotes inline;
 * `stage` persists a reviewable proposal bundle; `validate` proves the
 * vault has not drifted; `apply` re-validates and runs the same engine
 * live; `discard` drops the bundle.
 *
 * `--step` and `--gate` (no-dead-ends, Unit E - operator surface) are
 * the shell reach for the two capabilities that previously existed only
 * as TypeScript arguments: `runDreamStep` and `DreamOptions.gates`.
 * Both belong to the default `run` action and both refuse by name -
 * `--step` through `DreamStepNotRunnableError`, which carries the
 * specific reason and the runnable set, and `--gate` through
 * `DreamGateOverrideError`. Neither writes anything back to
 * `Brain/_brain.yaml`; with both absent the verb is byte-identical.
 *
 * Exit codes: 0 on success, 1 on operational failure (including a
 * failed validation - scripts gate on it), 2 on usage errors, which is
 * where a refused step or gate lands: the request was understood and
 * declined, not attempted and broken.
 */

import { resolveAgentName } from "../../../core/config.ts";
import { dream, type DreamGateOverrides } from "../../../core/brain/dream.ts";
import { CountGuardError, assertExpectedCount } from "../../../core/brain/count-guard.ts";
import {
  DREAM_GATE_NAMES,
  DreamGateOverrideError,
  parseDreamGateOverrides,
} from "../../../core/brain/dream-gates.ts";
import {
  DREAM_STEP_RUNNABLE,
  DreamStepNotRunnableError,
  runDreamStep,
  type DreamStepResult,
} from "../../../core/brain/dream-step.ts";
import {
  applyDreamBundle,
  discardDreamBundle,
  listDreamBundles,
  stageDream,
  validateDreamBundle,
} from "../../../core/brain/dream-stage.ts";
import {
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SafeguardTimeoutError,
} from "../../../core/brain/safeguard.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import { brainVerbContext, fail, ok, okJson, parse, parseOptionalIsoDate } from "../helpers.ts";

// The runnable set is read from the step registry, never retyped: a
// usage line that advertises a step the pass refuses is its own dead end.
const USAGE =
  `usage: o2b brain dream [run] [--dry-run] [--step <${DREAM_STEP_RUNNABLE.join("|")}>] ` +
  `[--gate <${DREAM_GATE_NAMES.join("|")}>=<true|false>] | ` +
  "stage | validate <run-id> | apply <run-id> | discard <run-id> | list  " +
  "[--now ISO] [--agent A] [--vault <path>] [--json]";

const ACTIONS = new Set(["run", "stage", "validate", "apply", "discard", "list"]);

/**
 * Refuse a request this verb understood and declined. Exit 2, with the
 * reason on stderr for a human and as a payload for a machine - never a
 * stray line on a stream a caller parses.
 */
function refuse(message: string, asJson: boolean, payload: Record<string, unknown> = {}): number {
  if (asJson) {
    okJson({ ok: false, ...payload, message });
    return 2;
  }
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

/** Render one partial step result as the verb's human line format. */
function printStepResult(result: DreamStepResult): void {
  ok(`step: ${result.step}`);
  if (result.step === "scan") {
    ok(`active_signals: ${result.active_signals}`);
    ok(`processed_signals: ${result.processed_signals}`);
    ok(`preferences: ${result.preferences}`);
    ok(`retired: ${result.retired}`);
    if (result.corrupted.length > 0) ok(`corrupted: ${result.corrupted.join(", ")}`);
    return;
  }
  ok(`scanned: ${result.scanned}`);
  ok(`enriched: ${result.enriched}`);
  if (result.pages.length > 0) ok(`pages: ${result.pages.join(", ")}`);
}

export async function cmdBrainDream(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    now: { type: "string" },
    agent: { type: "string" },
    expect: { type: "string" },
    strict: { type: "boolean" },
    step: { type: "string" },
    gate: { type: "string-array" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const action = positional[0] ?? "run";
  if (!ACTIONS.has(action)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const needsRunId = action === "validate" || action === "apply" || action === "discard";
  if (needsRunId ? positional.length !== 2 : positional.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  // --- Operator-surface argument checks (no-dead-ends, Unit E) --------
  // Both live on the default `run` action and each is refused by name
  // where it would otherwise be accepted and quietly ignored.
  const stepRequest = flags["step"];
  const gateEntries = (flags["gate"] as string[] | undefined) ?? [];
  const wantsStep = typeof stepRequest === "string";
  if ((wantsStep || gateEntries.length > 0) && action !== "run") {
    return refuse(
      `brain dream: --step and --gate steer the default 'run' action; ` +
        `'${action}' drives the staged lifecycle, which has neither a single step nor a gate to override`,
      asJson,
      { action },
    );
  }
  if (wantsStep) {
    // Every flag below configures work a single step does not do, so
    // accepting one alongside --step would silently drop it.
    const conflict =
      gateEntries.length > 0
        ? {
            flag: "--gate",
            reason:
              "a gate steers a full pass; the 'heal-enrich' step IS the opt-in and the 'scan' step reads no gate, so an override would have nothing to apply to",
          }
        : flags["dry-run"] === true
          ? {
              flag: "--dry-run",
              reason:
                "runDreamStep has no preview path - 'scan' already writes nothing and 'heal-enrich' has no plan-only mode, so a dry run would be either a no-op dressed as a preview or a write",
            }
          : flags["expect"] !== undefined
            ? {
                flag: "--expect",
                reason:
                  "the count guard asserts over the preferences a full pass creates, confirms, retires or moves, and a single step produces none of those counters",
              }
            : flags["strict"] === true
              ? {
                  flag: "--strict",
                  reason:
                    "it demands a count guard over the preferences a full pass changes, and a single step changes none of them",
                }
              : null;
    if (conflict !== null) {
      return refuse(
        `brain dream: --step cannot be combined with ${conflict.flag}: ${conflict.reason}`,
        asJson,
        { step: stepRequest, conflicting_flag: conflict.flag },
      );
    }
  }

  let gates: DreamGateOverrides | null = null;
  if (gateEntries.length > 0) {
    try {
      gates = parseDreamGateOverrides(gateEntries);
    } catch (exc) {
      if (exc instanceof DreamGateOverrideError) {
        return refuse(`brain dream: ${exc.message}`, asJson, {
          entry: exc.entry,
          known_gates: [...exc.known],
        });
      }
      throw exc;
    }
  }

  const { config, vault } = brainVerbContext(flags);

  const agentFlag = flags["agent"];
  let agent: string;
  if (typeof agentFlag === "string") {
    const trimmed = agentFlag.trim();
    if (trimmed.length === 0) {
      return fail("brain dream: --agent must be a non-empty string when provided");
    }
    agent = trimmed;
  } else {
    agent = resolveAgentName(config);
  }

  const { value: now, error: nowErr } = parseOptionalIsoDate(flags, "now");
  if (nowErr) return fail(nowErr);

  const guard = () =>
    createSafeguard({
      operation: "dream",
      timeoutMs: resolveSafeguardTimeoutMs("dream", config ?? undefined),
    });

  if (wantsStep) {
    let result: DreamStepResult;
    try {
      result = runDreamStep(vault, stepRequest);
    } catch (exc) {
      if (exc instanceof DreamStepNotRunnableError) {
        return refuse(exc.message, asJson, {
          step: exc.requested,
          runnable: [...exc.runnable],
          reason: exc.reason,
        });
      }
      const message = `dream step ${stepRequest} failed: ${(exc as Error).message ?? exc}`;
      if (asJson) {
        okJson({ ok: false, step: stepRequest, message });
        return 1;
      }
      return fail(message);
    }
    if (asJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    printStepResult(result);
    return 0;
  }

  try {
    if (action === "stage") {
      const bundle = stageDream(vault, {
        now: now ?? new Date(),
        safeguard: guard(),
        ...(agent ? { agentName: agent } : {}),
      });
      if (asJson) {
        okJson({
          run_id: bundle.runId,
          plan: bundle.plan,
          sources: bundle.sources.length,
          dir: `Brain/dream/staged/${bundle.runId}`,
        });
      } else {
        ok(`staged: ${bundle.runId} -> Brain/dream/staged/${bundle.runId}/`);
        ok(`planned changes: ${bundle.plan.changed ? "yes" : "none"}`);
      }
      return 0;
    }

    if (action === "validate" || action === "apply") {
      const runId = positional[1]!;
      const stageOpts = {
        now: now ?? new Date(),
        safeguard: guard(),
        ...(agent ? { agentName: agent } : {}),
      };
      if (action === "validate") {
        const verdict = validateDreamBundle(vault, runId, stageOpts);
        if (asJson) okJson({ run_id: runId, valid: verdict.valid, drift: verdict.drift });
        else if (verdict.valid) ok(`validate ${runId}: clean`);
        else {
          ok(`validate ${runId}: DRIFT`);
          for (const line of verdict.drift) ok(`  ${line}`);
        }
        return verdict.valid ? 0 : 1;
      }
      const outcome = applyDreamBundle(vault, runId, stageOpts);
      if (asJson) {
        okJson({
          run_id: runId,
          applied: outcome.applied,
          drift: outcome.validation.drift,
          ...(outcome.summary !== undefined
            ? {
                changed: outcome.summary.changed,
                new_unconfirmed: outcome.summary.new_unconfirmed,
                confirmed: outcome.summary.confirmed,
              }
            : {}),
        });
      } else if (outcome.applied) {
        ok(`apply ${runId}: done (changed: ${outcome.summary!.changed})`);
      } else {
        ok(`apply ${runId}: ABORTED - bundle drifted, re-stage first`);
        for (const line of outcome.validation.drift) ok(`  ${line}`);
      }
      return outcome.applied ? 0 : 1;
    }

    if (action === "discard") {
      const runId = positional[1]!;
      const removed = discardDreamBundle(vault, runId);
      if (asJson) okJson({ run_id: runId, removed });
      else ok(removed ? `discarded ${runId}` : `no staged bundle named ${runId}`);
      return 0;
    }

    if (action === "list") {
      const bundles = listDreamBundles(vault);
      if (asJson) {
        okJson({
          bundles: bundles.map((b) => ({
            run_id: b.runId,
            status: b.status,
            staged_at: b.stagedAt,
            proposals: b.proposals,
            sources: b.sources,
          })),
          ...(bundles.length === 0 ? nextCommandField("dream-bundles-absent") : {}),
        });
      } else if (bundles.length === 0) {
        ok("no dream bundles");
        // no-dead-ends, phase 3: this pointer was hand-written beside
        // the rail. One mechanism, one line format.
        emitNextStep("dream-bundles-absent", { command: "brain", argv, jsonRequested: asJson });
      } else {
        for (const b of bundles) {
          ok(`${b.runId}  ${b.status}  staged ${b.stagedAt}  ${b.proposals} proposal(s)`);
        }
      }
      return 0;
    }
  } catch (exc) {
    const timedOut = exc instanceof SafeguardTimeoutError;
    if (asJson) {
      okJson({
        ok: false,
        message: `dream ${action} failed: ${(exc as Error).message ?? exc}`,
        ...(timedOut ? { timed_out: true } : {}),
      });
      return 1;
    }
    return fail(`dream ${action} failed: ${(exc as Error).message ?? exc}`);
  }

  // action === "run": the legacy inline pass.
  const expectRaw = flags["expect"] as string | undefined;
  let expect: number | null = null;
  if (expectRaw !== undefined) {
    const n = Number(expectRaw);
    if (!Number.isInteger(n) || n < 0) return fail("--expect must be a non-negative integer");
    expect = n;
  }
  const strict = flags["strict"] === true;
  // Only pay for a preview pass when a guard is requested.
  if (expect !== null || strict) {
    try {
      const preview = dream(vault, {
        ...(now !== null ? { now } : {}),
        dryRun: true,
        ...(agent ? { agentName: agent } : {}),
        // The guard must preview the run it is guarding, overrides and
        // all, or it asserts a count for a pass that will not happen.
        ...(gates !== null ? { gates } : {}),
      });
      const matchList = [
        ...preview.new_unconfirmed,
        ...preview.confirmed,
        ...preview.retired.map((r) => r.id),
        ...preview.moved_to_processed,
      ];
      assertExpectedCount({
        matched: matchList.length,
        expect,
        strict,
        willMutate: !flags["dry-run"],
        matchList,
      });
    } catch (exc) {
      if (exc instanceof CountGuardError) return fail(exc.message);
      return fail(`dream preview failed: ${(exc as Error).message ?? exc}`);
    }
  }

  let summary;
  try {
    summary = dream(vault, {
      ...(now !== null ? { now } : {}),
      dryRun: Boolean(flags["dry-run"]),
      ...(agent ? { agentName: agent } : {}),
      safeguard: guard(),
      ...(gates !== null ? { gates } : {}),
    });
  } catch (exc) {
    if (exc instanceof SafeguardTimeoutError && asJson) {
      okJson({ ok: false, timed_out: true, message: exc.message });
      return 1;
    }
    return fail(`dream failed: ${(exc as Error).message ?? exc}`);
  }

  for (const w of summary.warnings ?? []) {
    process.stderr.write(`warning: ${w.code}: ${w.message}\n`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  ok(`run_id: ${summary.run_id}`);
  ok(`changed: ${summary.changed}`);
  if (summary.new_unconfirmed.length > 0)
    ok(`new_unconfirmed: ${summary.new_unconfirmed.join(", ")}`);
  if (summary.confirmed.length > 0) ok(`confirmed: ${summary.confirmed.join(", ")}`);
  if (summary.retired.length > 0)
    ok(`retired: ${summary.retired.map((r) => `${r.id} (${r.reason})`).join(", ")}`);
  if (summary.contradictions.length > 0) ok(`contradictions: ${summary.contradictions.join(", ")}`);
  if (summary.moved_to_processed.length > 0)
    ok(`moved_to_processed: ${summary.moved_to_processed.length}`);
  return 0;
}
