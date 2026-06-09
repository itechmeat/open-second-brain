/**
 * `o2b brain dream [run] [--dry-run] | stage | validate <run-id> |
 * apply <run-id> | discard <run-id> | list` - the learning pass plus
 * the staged lifecycle (t_ae8a8ec0). `run` (the default, kept
 * positional-free for back-compat) promotes inline; `stage` persists
 * a reviewable proposal bundle; `validate` proves the vault has not
 * drifted; `apply` re-validates and runs the same engine live;
 * `discard` drops the bundle.
 *
 * Exit codes: 0 on success, 1 on operational failure (including a
 * failed validation - scripts gate on it), 2 on usage errors.
 */

import { resolveAgentName } from "../../../core/config.ts";
import { dream } from "../../../core/brain/dream.ts";
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
import { brainVerbContext, fail, ok, okJson, parse, parseOptionalIsoDate } from "../helpers.ts";

const USAGE =
  "usage: o2b brain dream [run] [--dry-run] | stage | validate <run-id> | " +
  "apply <run-id> | discard <run-id> | list  [--now ISO] [--agent A] [--vault <path>] [--json]";

const ACTIONS = new Set(["run", "stage", "validate", "apply", "discard", "list"]);

export async function cmdBrainDream(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    now: { type: "string" },
    agent: { type: "string" },
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
        });
      } else if (bundles.length === 0) {
        ok("no dream bundles - run: o2b brain dream stage");
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
  let summary;
  try {
    summary = dream(vault, {
      ...(now !== null ? { now } : {}),
      dryRun: Boolean(flags["dry-run"]),
      ...(agent ? { agentName: agent } : {}),
      safeguard: guard(),
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
