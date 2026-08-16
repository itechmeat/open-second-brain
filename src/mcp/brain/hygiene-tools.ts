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
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
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
import { resolveSearchConfig } from "../../core/search/index.ts";
import {
  DANGLING_LINK_DEFINITION,
  measureFromIndex,
  type LinkRatchetMeasurement,
} from "../../core/search/link-ratchet.ts";
import { coerceBool } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
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

/**
 * The artifacts one finding would disclose, as the owner-scope view
 * spells references: an absolute path rendered vault-relative, anything
 * else left as the Brain artifact id it already is.
 */
function findingRefs(vault: string, finding: HygieneFinding): ReadonlyArray<string> {
  return finding.targets.map((target) =>
    target.startsWith("/") ? vaultRelativeSafe(vault, target) : target,
  );
}

function findingView(vault: string, finding: HygieneFinding): Record<string, unknown> {
  return {
    id: finding.id,
    detector: finding.detector,
    severity: finding.severity,
    title: finding.title,
    targets: findingRefs(vault, finding),
    proposed_action: finding.proposed_action,
    evidence: finding.evidence,
  };
}

/**
 * Vault-wide link integrity, reported beside the detector findings
 * (context-integrity-gates, unit G).
 *
 * An ADDITIVE top-level key, not a fifth detector: `HYGIENE_DETECTOR_IDS`
 * is a closed tuple validated in three places including this tool's own
 * input-schema enum, so extending it would change the tool contract.
 *
 * `dangling` counts the link rows the READ-TIME resolution ladder
 * leaves unresolved - broken as the reader of this vault experiences
 * it, not as the raw `target_document_id` column reports it. The
 * `definition` key names the rule that produced the number.
 *
 * Read-only over the index the operator's searches already use, and
 * refused unless that index records a full resolution pass - so
 * `measured: false` with a reason is a real outcome here, never
 * flattened into a zero.
 */
async function linkIntegrityView(ctx: ServerContext): Promise<Record<string, unknown>> {
  let measurement: LinkRatchetMeasurement;
  try {
    measurement = await measureFromIndex(
      resolveSearchConfig({
        vault: ctx.vault,
        ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
      }),
    );
  } catch (e) {
    // A read-only scan is never failed by the reporting layer.
    return {
      definition: DANGLING_LINK_DEFINITION,
      measured: false,
      reason: "index-unreadable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (!measurement.measurable) {
    return {
      definition: measurement.definition,
      measured: false,
      reason: measurement.reason,
      detail: measurement.detail,
    };
  }
  return {
    definition: measurement.definition,
    measured: true,
    dangling: measurement.dangling,
    links: measurement.links,
    documents: measurement.documents,
  };
}

/**
 * Per-detector counts over the findings actually returned.
 *
 * Every detector that RAN keeps a key, so a detector with nothing to say
 * is still reported as having run with zero - the distinction between
 * "not run" and "found nothing" that `detectors_run` and `counts`
 * together carry.
 */
function countByDetector(
  detectorsRun: ReadonlyArray<HygieneDetectorId>,
  findings: ReadonlyArray<HygieneFinding>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detector of detectorsRun) counts[detector] = 0;
  for (const finding of findings) {
    counts[finding.detector] = (counts[finding.detector] ?? 0) + 1;
  }
  return counts;
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
  const scanned = scanWithResolver(ctx.vault, detectors, now);

  // The owner boundary is applied to the REPORT, once, before EITHER mode
  // reads it. `findings[].targets` are artifact ids (or absolute paths
  // rendered vault-relative) and the `title` spells the same artifact out
  // in prose (a-label-is-not-a-boundary, U3, recon C2).
  //
  // Hoisted out of the `scan` branch on purpose. While it lived there,
  // `apply` planned against the UNFILTERED report, so a caller scoped to
  // one owner whose scan correctly returned nothing could still hand a
  // finding id to `apply` and merge, retire or archive another owner's
  // preference - and read both hidden ids back out of the applier's
  // `detail`. Finding ids are derivable rather than secret
  // (`hygiene/detectors/id.ts` hashes the sorted target list), so
  // withholding them from the scan was never the boundary; this is.
  //
  // Filtering the report rather than the plan is also what makes a hidden
  // finding IDENTICAL TO ABSENT: `buildHygienePlan` indexes what it is
  // given, so an id it cannot see lands in `unknown_ids` exactly as an id
  // nobody ever issued does. A separate "withheld" bucket - or a hidden
  // id landing in `excluded_review` while a nonexistent one lands in
  // `unknown_ids` - would be an existence oracle over the same
  // population the scan just refused to enumerate
  // (`preferences-collect.ts` states the convention).
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const findings = view.keep(scanned.findings, (f) => findingRefs(ctx.vault, f));
  const report: HygieneScanReport = Object.freeze({ ...scanned, findings });

  if (mode === "scan") {
    // `counts` is recomputed from the visible findings: a count over the
    // unfiltered set would report how many findings were withheld.
    return {
      mode,
      generated_at: report.generated_at,
      detectors_run: report.detectors_run,
      counts: countByDetector(report.detectors_run, findings),
      findings: findings.map((finding) => findingView(ctx.vault, finding)),
      errors: report.errors,
      link_integrity: await linkIntegrityView(ctx),
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
