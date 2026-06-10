/**
 * Freshness detector (continuity-hygiene-freshness suite; kanban
 * t_d9624ef6): wraps the source-freshness substrate as a hygiene
 * detector. Stale pages propose `recompile` (the targeted-recompile
 * executor picks them up); orphaned pages propose `review` - deleting
 * a page because its sources vanished is an operator call.
 */

import { scanFreshness } from "../../freshness.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

export function detectFreshness(vault: string): ReadonlyArray<HygieneFinding> {
  const report = scanFreshness(vault);
  const findings: HygieneFinding[] = [];
  for (const stale of report.stale) {
    findings.push(
      Object.freeze({
        id: hygieneFindingId("freshness", [stale.page]),
        detector: "freshness" as const,
        severity: "action" as const,
        title: `Derived page is stale: ${stale.changed_sources.length} changed, ${stale.missing_sources.length} missing source(s)`,
        targets: Object.freeze([stale.page]),
        proposed_action: "recompile" as const,
        evidence: Object.freeze({
          changed_sources: stale.changed_sources,
          missing_sources: stale.missing_sources,
        }),
      }),
    );
  }
  for (const orphan of report.orphaned) {
    findings.push(
      Object.freeze({
        id: hygieneFindingId("freshness", [orphan]),
        detector: "freshness" as const,
        severity: "warning" as const,
        title: "Derived page is orphaned: every recorded source is gone",
        targets: Object.freeze([orphan]),
        proposed_action: "review" as const,
        evidence: Object.freeze({}),
      }),
    );
  }
  for (const invalid of report.invalid_contract) {
    findings.push(
      Object.freeze({
        id: hygieneFindingId("freshness", [invalid]),
        detector: "freshness" as const,
        severity: "info" as const,
        title: "Source-freshness contract is malformed on this page",
        targets: Object.freeze([invalid]),
        proposed_action: "review" as const,
        evidence: Object.freeze({}),
      }),
    );
  }
  return Object.freeze(findings);
}
