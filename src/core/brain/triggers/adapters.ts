/**
 * Report-to-candidate adapters (Workspace Insight Suite, t_cd1fee79).
 *
 * Trigger generation is pull, not push: these adapters READ the
 * existing deterministic report shapes (semantic health, retention
 * review) and normalize findings into {@link InsightCandidate}s. No
 * report generator gains a write path, and every candidate is
 * grounded in artifacts the report already names.
 */

import type { SemanticHealthReport } from "../health/reconcile.ts";
import type { RetentionReviewReport } from "../retention.ts";
import type { InsightCandidate } from "./types.ts";

/** Contradictory preference pairs and stale claims from semantic health. */
export function candidatesFromHealth(
  report: SemanticHealthReport,
): ReadonlyArray<InsightCandidate> {
  const out: InsightCandidate[] = [];
  for (const finding of report.contradictions) {
    const [a, b] = [finding.aId, finding.bId].toSorted();
    out.push(
      Object.freeze({
        kind: "contradiction" as const,
        urgency: "high" as const,
        reason:
          `${finding.aId} (${finding.aSign}) contradicts ${finding.bId} (${finding.bSign})` +
          `${finding.scope !== null ? ` in scope '${finding.scope}'` : ""} ` +
          `(principle similarity ${finding.jaccard.toFixed(2)})`,
        suggestedAction: "Review the pair and retire, merge, or rescope one of the rules",
        sourceArtifacts: Object.freeze([`[[${finding.aId}]]`, `[[${finding.bId}]]`]),
        contextSnippets: Object.freeze([
          `signs: ${finding.aId}=${finding.aSign}, ${finding.bId}=${finding.bSign}`,
        ]),
        cooldownKey: `contradiction:${a}:${b}`,
      }),
    );
  }
  for (const finding of report.staleClaims) {
    out.push(
      Object.freeze({
        kind: "stale_claim" as const,
        urgency: "medium" as const,
        reason: `${finding.id} has had no fresh evidence for ${finding.ageDays} days (last: ${finding.lastEvidenceAt})`,
        suggestedAction: "Re-evidence the preference or let the dream pass retire it",
        sourceArtifacts: Object.freeze([`[[${finding.id}]]`]),
        contextSnippets: Object.freeze([`last_evidence_at: ${finding.lastEvidenceAt}`]),
        cooldownKey: `stale_claim:${finding.id}`,
      }),
    );
  }
  return Object.freeze(out);
}

/** Park/prune recommendations from the retention review. */
export function candidatesFromRetention(
  report: RetentionReviewReport,
): ReadonlyArray<InsightCandidate> {
  const out: InsightCandidate[] = [];
  for (const rec of report.recommendations) {
    if (rec.action !== "park" && rec.action !== "prune") continue;
    out.push(
      Object.freeze({
        kind: "retention_action" as const,
        urgency: rec.action === "prune" ? ("medium" as const) : ("low" as const),
        reason: `retention recommends '${rec.action}' for ${rec.id}: ${rec.reason}`,
        suggestedAction:
          rec.action === "prune"
            ? "Prune the artifact (it no longer earns its keep)"
            : "Park the artifact out of the active set",
        sourceArtifacts: Object.freeze([`[[${rec.id}]]`]),
        contextSnippets: Object.freeze([`path: ${rec.path}`]),
        cooldownKey: `retention_action:${rec.id}:${rec.action}`,
      }),
    );
  }
  return Object.freeze(out);
}
