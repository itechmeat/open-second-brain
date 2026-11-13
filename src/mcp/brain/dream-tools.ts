/**
 * `brain_dream` (task 3.19): the dream pass and its dry-run preview,
 * with the gate overrides, the reach-scoped rows and the change list the
 * answer renders. Runs at local reach only. Split from
 * `feedback-tools.ts`; registration happens through that module's
 * registry, which preserves the public FEEDBACK_TOOLS surface.
 */

import { resolveAgentName, resolveNearDuplicateRetireSiblingsEnabled } from "../../core/config.ts";
import { dream, type DreamGateOverrides } from "../../core/brain/dream.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import {
  DREAM_GATE_NAMES,
  DreamGateOverrideError,
  validateDreamGateOverrides,
} from "../../core/brain/dream-gates.ts";
import { DreamStepNotRunnableError, runDreamStep } from "../../core/brain/dream-step.ts";
import {
  applyDreamBundle,
  discardDreamBundle,
  DreamRetriageError,
  listDreamBundles,
  retriageDreamBundle,
  stageDream,
  validateDreamBundle,
  type DreamRetriageEntry,
} from "../../core/brain/dream-stage.ts";
import { gatedOwnerScopeView, type OwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { brainArtifactSlug } from "../../core/brain/wikilink.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextVault, type ServerContext } from "../tool-contract.ts";
import { coerceStr, coerceBool, coerceIsoDate, unknownOperationError } from "../coerce.ts";
import { enforceCountGuard, readCountGuardArgs, toolSafeguard } from "./shared.ts";
import { toolPath } from "./device-path.ts";
import { OPERATION } from "../../core/brain/safeguard.ts";
import { readableAtContextReach, readableAtContextReachOrUndefined } from "./reach-readable.ts";

// ----- brain_dream ---------------------------------------------------------

/** The set of preference ids a dream summary would create/confirm/retire/move. */
export function dreamChangeList(summary: {
  readonly new_unconfirmed: ReadonlyArray<string>;
  readonly confirmed: ReadonlyArray<string>;
  readonly retired: ReadonlyArray<{ readonly id: string }>;
  readonly moved_to_processed: ReadonlyArray<string>;
}): string[] {
  return [
    ...summary.new_unconfirmed,
    ...summary.confirmed,
    ...summary.retired.map((r) => r.id),
    ...summary.moved_to_processed,
  ];
}

/**
 * Read the optional `gates` argument (no-dead-ends, Unit E - operator
 * surface). JSON-RPC carries real objects and booleans, so the MCP form
 * is the override record itself rather than the CLI's `name=value`
 * strings; both go through the same validator in `dream-gates.ts`, so
 * the accepted gate names cannot diverge between the two surfaces.
 */
export function readDreamGates(args: Record<string, unknown>): DreamGateOverrides | undefined {
  const raw = args["gates"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_dream: gates must be an object of <gate>: <boolean>; known gates: ${DREAM_GATE_NAMES.join(", ")}`,
    );
  }
  try {
    return validateDreamGateOverrides(raw as Record<string, unknown>);
  } catch (exc) {
    if (exc instanceof DreamGateOverrideError) {
      throw new MCPError(INVALID_PARAMS, `brain_dream: ${exc.message}`);
    }
    throw exc;
  }
}

/**
 * The rows of a dream plan or run summary the caller may see
 * (a-label-is-not-a-boundary, U3).
 *
 * Every list here names a preference or a signal by id, and the pass
 * that produced them is vault-wide by construction: consolidation reads
 * every topic, and clustering only half a vault would produce different
 * preferences for every caller. So the PASS stays unscoped and the
 * REPORT is filtered - a caller is told what it did to the artifacts
 * that caller may see, and nothing about the rest.
 *
 * `contradictions`, `quarantined` and `intent_reviews` are absent from
 * the fold on purpose: their subject is a TOPIC over inbox signals, and
 * a signal carries no `owner:` anywhere in this product, so there is no
 * ownership claim on disk to read.
 */
export function scopedDreamRows<R extends string>(
  view: OwnerScopeView,
  plan: {
    readonly new_unconfirmed: ReadonlyArray<string>;
    readonly confirmed: ReadonlyArray<string>;
    readonly retired: ReadonlyArray<{ readonly id: string; readonly reason: R }>;
    readonly moved_to_processed: ReadonlyArray<string>;
    readonly suppressed: ReadonlyArray<string>;
  },
): {
  new_unconfirmed: ReadonlyArray<string>;
  confirmed: ReadonlyArray<string>;
  retired: ReadonlyArray<{ id: string; reason: R }>;
  moved_to_processed: ReadonlyArray<string>;
  suppressed: ReadonlyArray<string>;
} {
  const ids = (list: ReadonlyArray<string>): ReadonlyArray<string> => view.keep(list, (id) => [id]);
  return {
    new_unconfirmed: ids(plan.new_unconfirmed),
    confirmed: ids(plan.confirmed),
    // A retire names the preference by BOTH spellings across the move:
    // `ret-<slug>` after the pass, `pref-<slug>` before it.
    retired: view
      .keep(plan.retired, (r) => [r.id, `pref-${brainArtifactSlug(r.id)}`])
      .map((r) => ({ id: r.id, reason: r.reason })),
    moved_to_processed: ids(plan.moved_to_processed),
    suppressed: ids(plan.suppressed),
  };
}

/** The one answer a caller below local reach gets for anything but a dry run. */
export const DREAM_LOCAL_REACH_ONLY =
  "brain_dream: below local reach only action=run with dry_run is served; a real pass, a step and the staged lifecycle run at local reach only";

export async function toolBrainDream(
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  // `null` on a server with no vault: the inline pass runs over the store
  // alone (D14); a step and the staged lifecycle read `ctx.vault`, which
  // refuses with `vault_required` there.
  const vault = contextVault(ctx);
  const action = args["action"] ?? "run";
  if (
    action !== "run" &&
    action !== "stage" &&
    action !== "validate" &&
    action !== "apply" &&
    action !== "retriage" &&
    action !== "discard" &&
    action !== "list"
  ) {
    throw unknownOperationError(
      "brain_dream: action must be run|stage|validate|apply|retriage|discard|list",
    );
  }
  const dryRun = coerceBool(args, "dry_run");
  const nowDate = coerceIsoDate(args, "now");
  const agentArg = coerceStr(args, "agent", false);
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
  const gates = readDreamGates(args);
  const stepArg = coerceStr(args, "step", false);
  // One view for the whole call: every branch below reports preference
  // and signal ids, and the staged lifecycle reports them twice.
  const dreamView = gatedOwnerScopeView(vault, ctx.agentName);
  // The rollup step's link candidates leave out a page the caller may not
  // read at its reach, exactly as an absent page.
  const readable = readableAtContextReach(ctx);
  // Below local reach only a dry run is served, planned over the records
  // the caller may read as if the others were absent. A real pass, a
  // single step and the staged lifecycle move, rewrite or report records
  // the caller may not read, so they are refused with one fixed answer
  // before anything is read or written, whatever the vault holds.
  const previewReadable = readableAtContextReachOrUndefined(ctx);
  if (previewReadable !== undefined && (action !== "run" || !dryRun || stepArg)) {
    throw new MCPError(INVALID_PARAMS, DREAM_LOCAL_REACH_ONLY);
  }
  const previewScope = previewReadable !== undefined ? { previewReadable } : {};

  // Single-step requests (no-dead-ends, Unit E - operator surface).
  // Deliberately checked before any environment work: a step the pass
  // cannot honour is refused by name, carrying the specific reason and
  // the runnable set, and nothing is read or written on that path.
  if (stepArg) {
    if (action !== "run") {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_dream: step applies to action=run; action=${action} drives the staged lifecycle, which has no single step`,
      );
    }
    const conflicting = dryRun
      ? "dry_run"
      : gates !== undefined
        ? "gates"
        : "expect" in args || "strict" in args
          ? "expect/strict"
          : null;
    if (conflicting !== null) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_dream: step cannot be combined with ${conflicting} - a single step has no preview path, reads no gate, and produces none of the preference counters the guard asserts over`,
      );
    }
    try {
      // Bounded and observed on the same terms as every sibling branch.
      // This one had neither: it was the row `docs/mcp.md` marked
      // **none**, and `dream()` being synchronous is exactly why that
      // mattered - an unbounded step holds the server's event loop for
      // its whole duration and the client cannot even time out and
      // reissue. The budget is `dream`'s, because a step IS part of a
      // dream pass; the sink is the caller's, dropped here until now.
      return {
        ...runDreamStep(ctx.vault, stepArg, {
          safeguard: toolSafeguard(ctx, OPERATION.dream),
          ...(onProgress ? { onProgress } : {}),
        }),
      };
    } catch (exc) {
      if (exc instanceof DreamStepNotRunnableError) {
        throw new MCPError(INVALID_PARAMS, exc.message);
      }
      throw exc;
    }
  }

  if (action !== "run") {
    if (gates !== undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_dream: gates apply to action=run; action=${action} drives the staged lifecycle, whose bundle records the gates its own run resolved`,
      );
    }
    // Staged lifecycle (t_ae8a8ec0): stage -> validate -> apply over a
    // persisted bundle; dream() stays the only promotion engine.
    const runIdArg = coerceStr(args, "run_id", false);
    if (action !== "list" && action !== "stage" && !runIdArg) {
      throw new MCPError(INVALID_PARAMS, `brain_dream action=${action}: run_id is required`);
    }
    const now = nowDate ?? new Date();
    // The staged lifecycle runs the same consolidation pass `action=run`
    // does - `stage` previews it, `apply` promotes from it - so it is
    // bounded and reported on the same terms. Without the sink a client
    // that sent a progressToken for `action: "stage"` would be told
    // nothing and see nothing for the whole pass.
    const stageOpts = {
      now,
      safeguard: toolSafeguard(ctx, OPERATION.dream),
      readable,
      ...(agent ? { agentName: agent } : {}),
      ...(onProgress ? { onProgress } : {}),
    };
    switch (action) {
      case "stage": {
        const bundle = stageDream(ctx.vault, stageOpts);
        return {
          action,
          run_id: bundle.runId,
          plan: { ...bundle.plan, ...scopedDreamRows(dreamView, bundle.plan) },
          sources: bundle.sources.length,
          dir: `Brain/dream/staged/${bundle.runId}`,
        };
      }
      case "validate": {
        const verdict = validateDreamBundle(ctx.vault, runIdArg!, stageOpts);
        return { action, run_id: runIdArg, valid: verdict.valid, drift: [...verdict.drift] };
      }
      case "apply": {
        const outcome = applyDreamBundle(ctx.vault, runIdArg!, stageOpts);
        return {
          action,
          run_id: runIdArg,
          applied: outcome.applied,
          drift: [...outcome.validation.drift],
          ...(outcome.summary !== undefined
            ? { changed: outcome.summary.changed, ...scopedDreamRows(dreamView, outcome.summary) }
            : {}),
        };
      }
      case "retriage": {
        // Read-only: it re-runs the salience gate against the current
        // threshold and reports what would move. The bundle is not
        // rewritten, so a caller that likes the new partition re-stages.
        let outcome;
        try {
          outcome = retriageDreamBundle(ctx.vault, runIdArg!, stageOpts);
        } catch (exc) {
          if (exc instanceof DreamRetriageError) {
            throw new MCPError(INVALID_PARAMS, `brain_dream: ${exc.message}`);
          }
          throw exc;
        }
        const scopedDelta = (
          entries: ReadonlyArray<DreamRetriageEntry>,
        ): Array<Record<string, unknown>> =>
          dreamView
            .keep(entries, (entry) => [entry.pref_id, entry.path])
            .map((entry) => ({
              pref_id: entry.pref_id,
              path: entry.path,
              score: entry.score,
              staged_score: entry.staged_score,
            }));
        return {
          action,
          run_id: runIdArg,
          staged_threshold: outcome.stagedThreshold,
          current_threshold: outcome.currentThreshold,
          changed: outcome.changed,
          considered: outcome.considered,
          admitted: outcome.admitted,
          // Counts before the owner filter, names after it: a scoped
          // caller is still told HOW MANY facts moved, and only the
          // identities it may not see are withheld.
          newly_admitted_count: outcome.newlyAdmitted.length,
          newly_excluded_count: outcome.newlyExcluded.length,
          newly_admitted: scopedDelta(outcome.newlyAdmitted),
          newly_excluded: scopedDelta(outcome.newlyExcluded),
          notes: [...outcome.notes],
        };
      }
      case "discard": {
        return { action, run_id: runIdArg, removed: discardDreamBundle(ctx.vault, runIdArg!) };
      }
      default: {
        return {
          action,
          bundles: listDreamBundles(ctx.vault).map((b) => ({
            run_id: b.runId,
            status: b.status,
            staged_at: b.stagedAt,
            proposals: b.proposals,
            sources: b.sources,
          })),
        };
      }
    }
  }

  const { expect, strict } = readCountGuardArgs(args);
  // One deadline for the whole tool call, not one per pass. `dream()` is
  // synchronous, so an unbounded call blocks the server's event loop for
  // its entire duration and the client cannot even time out and reissue;
  // what has to be bounded is therefore the call, and a guarded run is
  // two passes over the same tree. Sharing the guard means a slow preview
  // spends the run's budget - which is the honest reading of a budget the
  // operator set for this operation.
  const safeguard = toolSafeguard(ctx, OPERATION.dream);
  // The retire-siblings key honours the server's own config file, as
  // `brain_review_candidates` does.
  const retireSiblingsEnabled = resolveNearDuplicateRetireSiblingsEnabled(
    ctx.configPath ?? undefined,
  );
  // Only pay for a preview pass when a guard is actually requested; otherwise
  // the run is byte-identical to before.
  if (expect !== null || strict) {
    const preview = dream(vault, {
      dryRun: true,
      safeguard,
      readable,
      retireSiblingsEnabled,
      ...previewScope,
      ...(nowDate ? { now: nowDate } : {}),
      ...(agent ? { agentName: agent } : {}),
      // Preview the run being guarded, overrides and all.
      ...(gates !== undefined ? { gates } : {}),
    });
    const previewList = dreamChangeList(preview);
    enforceCountGuard({
      matched: previewList.length,
      expect,
      strict,
      willMutate: !dryRun,
      matchList: previewList,
    });
  }

  // The count-guard preview above is deliberately NOT reported on: it is
  // a dry run whose only purpose is to decide whether the run below may
  // happen at all, and a client that saw the same five stages twice
  // would read the second pass as a restart. Progress describes the run
  // the caller asked for.
  const summary = dream(vault, {
    dryRun,
    safeguard,
    readable,
    retireSiblingsEnabled,
    ...previewScope,
    ...(nowDate ? { now: nowDate } : {}),
    ...(agent ? { agentName: agent } : {}),
    ...(gates !== undefined ? { gates } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  const changeList = dreamChangeList(summary);
  // A retire-sibling pair names two preferences; it is kept only when the
  // caller may see both, each in both spellings (`ret-<slug>` after the
  // pass, `pref-<slug>` before it).
  const bothSpellings = (id: string): ReadonlyArray<string> => {
    const slug = brainArtifactSlug(id);
    return [`pref-${slug}`, `ret-${slug}`];
  };
  const retireSiblings = dreamView.keep(summary.retire_siblings ?? [], (p) => [
    ...bothSpellings(p.retiring_id),
    ...bothSpellings(p.sibling_id),
  ]);

  // The summary is already a Plain Old Frozen Object — JSON-serialise
  // verbatim. We surface `snapshot_path` / `log_path` as vault-relative
  // for caller convenience while preserving the absolute path as well.
  return {
    run_id: summary.run_id,
    changed: summary.changed,
    // Honest matched-vs-changed: `matched` is what the pass would touch;
    // `changed_count` is what it actually wrote (0 on a dry run).
    matched: changeList.length,
    changed_count: dryRun ? 0 : changeList.length,
    dry_run: dryRun,
    ...scopedDreamRows(dreamView, summary),
    ...(retireSiblings.length > 0
      ? {
          retire_siblings: retireSiblings.map((p) => ({
            retiring_id: p.retiring_id,
            sibling_id: p.sibling_id,
            score: p.score,
            method: p.method,
          })),
        }
      : {}),
    // Inbox archive (issue #195): a count, not the ids. A first pass over a
    // long-lived vault archives thousands of signals; the run's log event
    // names every one of them.
    archived_signals_count: summary.archived_signals?.length ?? 0,
    contradictions: [...summary.contradictions],
    warnings: summary.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    })),
    uncertain: summary.uncertain.map((u) => ({
      code: u.code,
      ...(u.topic !== undefined ? { topic: u.topic } : {}),
      message: u.message,
    })),
    quarantined: summary.quarantined.map((q) => ({
      topic: q.topic,
      signal_count: q.signal_count,
      distinct_agents: q.distinct_agents,
      age_days: q.age_days,
      failed_gates: [...q.failed_gates],
    })),
    // The salience gate over the rollup fold set. `threshold: null` says
    // the gate was absent, and the two counts are reported before the
    // owner filter so a scoped caller still learns how many facts were
    // held back even where it may not see their names.
    salience_gate: {
      threshold: summary.salience_gate.threshold,
      considered: summary.salience_gate.considered,
      admitted: summary.salience_gate.admitted,
      excluded_count: summary.salience_gate.excluded.length,
      excluded: dreamView
        .keep(summary.salience_gate.excluded, (entry) => [entry.pref_id, entry.path])
        .map((entry) => ({
          pref_id: entry.pref_id,
          path: entry.path,
          score: entry.score,
          mass: entry.mass,
          confidence: entry.confidence,
          reuse: entry.reuse,
        })),
    },
    snapshot_path: summary.snapshot_path ? toolPath(ctx, summary.snapshot_path) : null,
    log_path: summary.log_path ? toolPath(ctx, summary.log_path) : null,
  };
}
