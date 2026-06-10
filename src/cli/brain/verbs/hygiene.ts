/**
 * `o2b brain hygiene` - scan / apply over the hygiene findings
 * pipeline (continuity-hygiene-freshness suite).
 *
 *   o2b brain hygiene scan  [--detectors a,b] [--json]
 *   o2b brain hygiene apply --ids id1,id2 [--dry-run] [--json]
 *
 * Scan is read-only; apply executes only explicitly selected finding
 * ids, and review findings never execute. The conflict resolver
 * command comes from `_brain.yaml` (`hygiene.resolver_cmd`) only.
 */

import { applyHygienePlan } from "../../../core/brain/hygiene/apply.ts";
import { buildHygienePlan } from "../../../core/brain/hygiene/plan.ts";
import { resolveConflictFindings } from "../../../core/brain/hygiene/resolve-conflicts.ts";
import { runHygieneScan } from "../../../core/brain/hygiene/scan.ts";
import {
  isHygieneDetectorId,
  type HygieneDetectorId,
  type HygieneScanReport,
} from "../../../core/brain/hygiene/types.ts";
import { loadBrainConfig } from "../../../core/brain/policy.ts";
import { brainVerbContext, fail, parse, resolveBrainAgent } from "../helpers.ts";

function parseDetectors(raw: string | undefined): HygieneDetectorId[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parts = raw.split(",").map((part) => part.trim());
  const detectors = parts.filter(isHygieneDetectorId);
  if (detectors.length !== parts.length) {
    throw new Error("--detectors entries must be: conflicts, dedup, freshness, usefulness");
  }
  return detectors;
}

function scanReport(vault: string, detectors: HygieneDetectorId[] | undefined): HygieneScanReport {
  const report = runHygieneScan(vault, {
    ...(detectors !== undefined && detectors.length > 0 ? { detectors } : {}),
    now: new Date(),
  });
  let resolverCmd: string | undefined;
  try {
    resolverCmd = loadBrainConfig(vault).hygiene?.resolver_cmd;
  } catch {
    resolverCmd = undefined;
  }
  if (resolverCmd === undefined) return report;
  return Object.freeze({
    ...report,
    findings: resolveConflictFindings(vault, report.findings, { resolverCmd }),
  });
}

export async function cmdBrainHygiene(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub !== "scan" && sub !== "apply") {
    return fail("usage: o2b brain hygiene <scan|apply> [options]");
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    agent: { type: "string" },
    detectors: { type: "string" },
    ids: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  let detectors: HygieneDetectorId[] | undefined;
  try {
    detectors = parseDetectors(flags["detectors"] as string | undefined);
  } catch (exc) {
    return fail((exc as Error).message);
  }

  let report: HygieneScanReport;
  try {
    report = scanReport(vault, detectors);
  } catch (exc) {
    return fail(`hygiene scan failed: ${(exc as Error).message ?? exc}`);
  }

  if (sub === "scan") {
    if (flags["json"]) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(`Hygiene scan @ ${report.generated_at}\n`);
    for (const [detector, count] of Object.entries(report.counts)) {
      process.stdout.write(`  ${detector}: ${count} finding(s)\n`);
    }
    for (const finding of report.findings) {
      process.stdout.write(
        `- [${finding.detector}] ${finding.id} -> ${finding.proposed_action}\n    ${finding.title}\n`,
      );
    }
    for (const error of report.errors) {
      process.stdout.write(`! ${error.detector}: ${error.message}\n`);
    }
    return 0;
  }

  const idsRaw = flags["ids"] as string | undefined;
  const ids = idsRaw
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids === undefined || ids.length === 0) {
    return fail("apply requires --ids <finding-id,...> from a prior scan");
  }
  const plan = buildHygienePlan(report, { ids });
  let result;
  try {
    result = await applyHygienePlan(vault, plan, {
      dryRun: Boolean(flags["dry-run"]),
      agent: resolveBrainAgent(flags, config),
      now: new Date(),
    });
  } catch (exc) {
    return fail(`hygiene apply failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ plan, result }, null, 2) + "\n");
    return result.errors.length === 0 ? 0 : 1;
  }
  for (const action of result.planned) {
    process.stdout.write(`would ${action.action}: ${action.detail} (${action.finding_id})\n`);
  }
  for (const action of result.applied) {
    process.stdout.write(`${action.action}: ${action.detail} (${action.finding_id})\n`);
  }
  for (const id of plan.excluded_review) {
    process.stdout.write(`skipped review-only finding ${id}\n`);
  }
  for (const id of plan.unknown_ids) {
    process.stdout.write(`unknown finding id ${id}\n`);
  }
  for (const error of result.errors) {
    process.stdout.write(`error on ${error.finding_id}: ${error.message}\n`);
  }
  return result.errors.length === 0 ? 0 : 1;
}
