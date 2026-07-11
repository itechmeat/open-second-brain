/**
 * Hygiene surface: scan / apply / refresh over the findings pipeline
 * (continuity-hygiene-freshness suite; kanban t_698db8f7, t_da3f138f,
 * t_db375a60, t_d9624ef6, t_fe490119).
 *
 * One tool, three modes:
 *   - `scan` (default): read-only digest of detector findings, with
 *     resolver verdicts attached when the operator configured
 *     `hygiene.resolver_cmd` in `_brain.yaml`;
 *   - `apply`: execute an explicit plan selected by finding ids -
 *     ids are REQUIRED, a bare apply never runs everything blindly;
 *   - `refresh`: the targeted-recompile path for stale derived pages
 *     (`dry_run` previews with zero writes).
 *
 * The resolver command comes exclusively from operator config - it is
 * never accepted as a tool argument, so an MCP caller cannot make this
 * server execute an arbitrary command.
 */

import { resolveAgentName } from "../../core/config.ts";
import { loadBrainConfig } from "../../core/brain/policy.ts";
import { applyHygienePlan } from "../../core/brain/hygiene/apply.ts";
import { buildHygienePlan } from "../../core/brain/hygiene/plan.ts";
import { resolveConflictFindings } from "../../core/brain/hygiene/resolve-conflicts.ts";
import { runHygieneScan } from "../../core/brain/hygiene/scan.ts";
import {
  isHygieneDetectorId,
  type HygieneDetectorId,
  type HygieneFinding,
  type HygieneScanReport,
} from "../../core/brain/hygiene/types.ts";
import { executeRecompile, planRecompile } from "../../core/brain/recompile.ts";
import { coerceBool } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { enforceCountGuard, readCountGuardArgs, vaultRelativeSafe } from "./shared.ts";

function coerceStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) {
    throw new MCPError(INVALID_PARAMS, `'${key}' must be an array of strings`);
  }
  return raw;
}

function resolverCmdFromConfig(vault: string): string | undefined {
  try {
    return loadBrainConfig(vault).hygiene?.resolver_cmd;
  } catch {
    return undefined; // a broken config never blocks a read-only scan
  }
}

function scanWithResolver(
  vault: string,
  detectors: HygieneDetectorId[] | undefined,
  now: Date,
): HygieneScanReport {
  const report = runHygieneScan(vault, {
    ...(detectors !== undefined && detectors.length > 0 ? { detectors } : {}),
    now,
  });
  const resolverCmd = resolverCmdFromConfig(vault);
  if (resolverCmd === undefined) return report;
  return Object.freeze({
    ...report,
    findings: resolveConflictFindings(vault, report.findings, { resolverCmd }),
  });
}

function findingView(vault: string, finding: HygieneFinding): Record<string, unknown> {
  return {
    id: finding.id,
    detector: finding.detector,
    severity: finding.severity,
    title: finding.title,
    targets: finding.targets.map((target) =>
      target.startsWith("/") ? vaultRelativeSafe(vault, target) : target,
    ),
    proposed_action: finding.proposed_action,
    evidence: finding.evidence,
  };
}

async function toolBrainHygiene(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = args["mode"] ?? "scan";
  if (mode !== "scan" && mode !== "apply" && mode !== "refresh") {
    throw new MCPError(INVALID_PARAMS, "'mode' must be one of: scan, apply, refresh");
  }
  const now = new Date();
  const dryRun = coerceBool(args, "dry_run") === true;

  if (mode === "refresh") {
    const plan = planRecompile(ctx.vault);
    const result = await executeRecompile(ctx.vault, plan, {
      dryRun,
      agent: resolveAgentName(ctx.configPath ?? undefined),
      now,
    });
    return {
      mode,
      dry_run: result.dry_run,
      plan: plan.entries.map((entry) => ({
        kind: entry.kind,
        page: vaultRelativeSafe(ctx.vault, entry.page),
        reason: entry.reason,
      })),
      rederived: result.rederived.map((page) => vaultRelativeSafe(ctx.vault, page)),
      archived: result.archived.map((page) => vaultRelativeSafe(ctx.vault, page)),
      manual: result.manual.map((page) => vaultRelativeSafe(ctx.vault, page)),
      errors: result.errors,
    };
  }

  const detectorsRaw = coerceStringArray(args, "detectors");
  const detectors = detectorsRaw?.filter(isHygieneDetectorId);
  if (detectorsRaw !== undefined && detectors!.length !== detectorsRaw.length) {
    throw new MCPError(
      INVALID_PARAMS,
      "'detectors' entries must be: conflicts, dedup, freshness, usefulness",
    );
  }
  const report = scanWithResolver(ctx.vault, detectors, now);

  if (mode === "scan") {
    return {
      mode,
      generated_at: report.generated_at,
      detectors_run: report.detectors_run,
      counts: report.counts,
      findings: report.findings.map((finding) => findingView(ctx.vault, finding)),
      errors: report.errors,
    };
  }

  const ids = coerceStringArray(args, "ids");
  if (ids === undefined || ids.length === 0) {
    throw new MCPError(INVALID_PARAMS, "apply requires explicit finding 'ids' from a prior scan");
  }
  const plan = buildHygienePlan(report, { ids });
  const { expect, strict } = readCountGuardArgs(args);
  // Guard on the selected findings BEFORE applying so an unexpected blast
  // radius aborts without touching the vault.
  enforceCountGuard({
    matched: plan.selected.length,
    expect,
    strict,
    willMutate: !dryRun,
    matchList: plan.selected.map((finding) => finding.id),
  });
  const result = await applyHygienePlan(ctx.vault, plan, {
    dryRun,
    agent: resolveAgentName(ctx.configPath ?? undefined),
    now,
  });
  return {
    mode,
    dry_run: result.dry_run,
    selected: plan.selected.map((finding) => finding.id),
    excluded_review: plan.excluded_review,
    unknown_ids: plan.unknown_ids,
    planned: result.planned,
    applied: result.applied,
    // Honest matched-vs-changed: findings selected vs. findings actually applied.
    matched: plan.selected.length,
    changed: result.applied.length,
    errors: result.errors,
  };
}

export const HYGIENE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_hygiene",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Memory hygiene pipeline. `scan`: read-only digest of contested truth slots, near-duplicate preferences, stale/orphaned pages, low-usefulness candidates. `apply`: execute selected finding ids (review findings never execute). `refresh`: targeted recompile of stale pages with dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["scan", "apply", "refresh"],
          description: "Pipeline stage. Default `scan` (read-only).",
        },
        detectors: {
          type: "array",
          items: { type: "string", enum: ["conflicts", "dedup", "freshness", "usefulness"] },
          description: "Detector subset for scan/apply. Default: all detectors.",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Finding ids to execute (apply mode; required there).",
        },
        dry_run: {
          type: "boolean",
          description: "Preview apply/refresh with zero writes.",
        },
        expect: {
          type: "integer",
          minimum: 0,
          description:
            "Count guard (apply mode): assert exactly N findings will be applied. On mismatch the apply aborts without writing.",
        },
        strict: {
          type: "boolean",
          description: "Refuse a guardless apply (no `expect`). Default false.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainHygiene,
  },
]);
