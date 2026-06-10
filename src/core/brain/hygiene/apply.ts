/**
 * Hygiene apply - execute an explicit remediation plan
 * (continuity-hygiene-freshness suite; kanban t_698db8f7).
 *
 * Routing by proposed action, every executor an existing primitive:
 *
 *   - `merge`     -> `mergePreferences` (keep = first target);
 *   - `supersede` -> append the resolver-chosen winning claim with
 *                    hygiene provenance (the conflict's slot then
 *                    reads the winner as current truth);
 *   - `recompile` -> the targeted-recompile executor, scoped to the
 *                    finding's page;
 *   - `archive` / `forget` -> move the page into a dated
 *                    `Brain/.snapshots/` directory - never delete.
 *
 * Dry-run previews the routed actions with zero writes. Per-finding
 * fail-soft; one audit record per non-dry run.
 */

import { join } from "node:path";

import { appendAuditRecord } from "../../reliability/audit.ts";
import { mergePreferences } from "../merge.ts";
import { brainDirs } from "../paths.ts";
import { archivePage, executeRecompile, planRecompile } from "../recompile.ts";
import { appendClaimEvent } from "../truth/store.ts";
import type { HygienePlan } from "./plan.ts";
import type { HygieneFinding } from "./types.ts";

export interface HygieneApplyOptions {
  readonly dryRun?: boolean;
  readonly agent: string;
  readonly now: Date;
}

export interface HygieneAppliedAction {
  readonly finding_id: string;
  readonly action: string;
  readonly detail: string;
}

export interface HygieneApplyResult {
  readonly dry_run: boolean;
  /** Dry-run preview of what would execute. */
  readonly planned: ReadonlyArray<HygieneAppliedAction>;
  readonly applied: ReadonlyArray<HygieneAppliedAction>;
  readonly errors: ReadonlyArray<{ finding_id: string; message: string }>;
}

function plannedAction(finding: HygieneFinding): HygieneAppliedAction {
  return Object.freeze({
    finding_id: finding.id,
    action: finding.proposed_action,
    detail: finding.targets.join(", "),
  });
}

async function executeFinding(
  vault: string,
  finding: HygieneFinding,
  opts: HygieneApplyOptions,
): Promise<HygieneAppliedAction> {
  switch (finding.proposed_action) {
    case "merge": {
      const [keep, drop] = finding.targets;
      if (keep === undefined || drop === undefined) {
        throw new Error("merge finding must carry exactly two targets");
      }
      const plan = mergePreferences(vault, keep, drop, {
        now: opts.now,
        agentName: opts.agent,
      });
      return Object.freeze({
        finding_id: finding.id,
        action: "merge",
        detail: `kept ${plan.keep_id}, retired ${plan.drop_id}`,
      });
    }
    case "supersede": {
      const resolver = finding.evidence["resolver"] as { winner_value?: unknown } | undefined;
      const winner = resolver !== undefined ? resolver.winner_value : undefined;
      const slot = finding.targets[0] ?? "";
      const separator = slot.indexOf("#");
      if (typeof winner !== "string" || winner.length === 0 || separator <= 0) {
        throw new Error("supersede finding lacks a resolver winner or a valid entity#aspect slot");
      }
      appendClaimEvent(vault, {
        ts: opts.now.toISOString(),
        agent: opts.agent,
        entity: slot.slice(0, separator),
        aspect: slot.slice(separator + 1),
        value: winner,
        source: "[[hygiene-resolver]]",
      });
      return Object.freeze({
        finding_id: finding.id,
        action: "supersede",
        detail: `${slot} -> ${winner}`,
      });
    }
    case "recompile": {
      const page = finding.targets[0];
      const plan = planRecompile(vault);
      const scoped = Object.freeze({
        entries: Object.freeze(plan.entries.filter((entry) => entry.page === page)),
      });
      const result = await executeRecompile(vault, scoped, {
        agent: opts.agent,
        now: opts.now,
      });
      if (result.errors.length > 0) throw new Error(result.errors[0]!.message);
      return Object.freeze({
        finding_id: finding.id,
        action: "recompile",
        detail: `rederived ${result.rederived.length}, archived ${result.archived.length}, manual ${result.manual.length}`,
      });
    }
    case "archive":
    case "forget": {
      const page = finding.targets[0];
      if (page === undefined) throw new Error("archive finding carries no target page");
      const target = archivePage(vault, page, opts.now);
      return Object.freeze({
        finding_id: finding.id,
        action: finding.proposed_action,
        detail: `archived to ${target}`,
      });
    }
    default:
      throw new Error(`no executor for action '${finding.proposed_action}'`);
  }
}

export async function applyHygienePlan(
  vault: string,
  plan: HygienePlan,
  opts: HygieneApplyOptions,
): Promise<HygieneApplyResult> {
  const dryRun = opts.dryRun === true;
  if (dryRun) {
    return Object.freeze({
      dry_run: true,
      planned: Object.freeze(plan.selected.map(plannedAction)),
      applied: Object.freeze([]),
      errors: Object.freeze([]),
    });
  }

  const applied: HygieneAppliedAction[] = [];
  const errors: { finding_id: string; message: string }[] = [];
  for (const finding of plan.selected) {
    try {
      applied.push(await executeFinding(vault, finding, opts));
    } catch (error) {
      errors.push({
        finding_id: finding.id,
        message: error instanceof Error ? error.message : "apply failed",
      });
    }
  }

  if (applied.length > 0 || errors.length > 0) {
    appendAuditRecord(join(brainDirs(vault).log, "hygiene"), {
      timestamp: opts.now.toISOString(),
      actor: opts.agent,
      action: "hygiene_apply",
      target: "Brain",
      ok: errors.length === 0,
      details: {
        applied: applied.length,
        errors: errors.length,
        actions: applied.map((action) => `${action.action}:${action.finding_id}`),
      },
    });
  }

  return Object.freeze({
    dry_run: false,
    planned: Object.freeze([]),
    applied: Object.freeze(applied),
    errors: Object.freeze(errors),
  });
}
