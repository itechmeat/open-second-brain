/**
 * External conflict resolution
 * (continuity-hygiene-freshness suite; kanban t_db375a60).
 *
 * The Brain core stays deterministic: conflict DETECTION is the truth
 * layer's temporal-structural rule, and this module only consults an
 * optional external resolver command - through the shared
 * `runJsonCommandBridge` - for an advisory verdict per conflict
 * finding. The contract is fail-open at every step: no resolver
 * configured, resolver error, malformed output, unknown finding id,
 * or an action outside the allowed vocabulary all leave the finding
 * at `review` for the operator.
 *
 * Wire protocol: the resolver receives
 * `{ "conflicts": [<conflict findings>] }` on stdin and answers
 * `{ "verdicts": { "<finding-id>": { "action": "supersede" | "merge"
 * | "flag", "winner_value"?, "rationale"? } } }` on stdout.
 */

import { runJsonCommandBridge } from "../../reliability/command-bridge.ts";
import type { HygieneFinding, HygieneProposedAction } from "./types.ts";

export interface ResolveConflictOptions {
  /** External resolver command (`hygiene.resolver_cmd`). Absent = flag-for-review. */
  readonly resolverCmd?: string;
  readonly timeoutMs?: number;
}

interface ResolverVerdict {
  readonly action: "supersede" | "merge" | "flag";
  readonly winner_value?: string;
  readonly rationale?: string;
}

function parseVerdict(raw: unknown): ResolverVerdict | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as { action?: unknown; winner_value?: unknown; rationale?: unknown };
  if (
    candidate.action !== "supersede" &&
    candidate.action !== "merge" &&
    candidate.action !== "flag"
  ) {
    return null;
  }
  return {
    action: candidate.action,
    ...(typeof candidate.winner_value === "string" ? { winner_value: candidate.winner_value } : {}),
    ...(typeof candidate.rationale === "string" ? { rationale: candidate.rationale } : {}),
  };
}

function withResolverEvidence(
  finding: HygieneFinding,
  action: HygieneProposedAction,
  extra: Readonly<Record<string, unknown>>,
): HygieneFinding {
  return Object.freeze({
    ...finding,
    proposed_action: action,
    evidence: Object.freeze({ ...finding.evidence, ...extra }),
  });
}

/**
 * Attach resolver verdicts to conflict findings. Non-conflict findings
 * pass through by reference; conflicts without a usable verdict stay
 * `review`. Never throws.
 */
export function resolveConflictFindings(
  _vault: string,
  findings: ReadonlyArray<HygieneFinding>,
  opts: ResolveConflictOptions,
): ReadonlyArray<HygieneFinding> {
  const conflicts = findings.filter((finding) => finding.detector === "conflicts");
  if (conflicts.length === 0 || opts.resolverCmd === undefined || opts.resolverCmd.trim() === "") {
    return findings;
  }

  const result = runJsonCommandBridge(
    opts.resolverCmd,
    { conflicts },
    {
      label: "hygiene resolver",
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );

  if (result.status === "skipped") return findings;
  if (result.status === "error") {
    return Object.freeze(
      findings.map((finding) =>
        finding.detector === "conflicts"
          ? withResolverEvidence(finding, "review", { resolver_error: result.detail })
          : finding,
      ),
    );
  }

  const verdictsRaw =
    result.output !== null && typeof result.output === "object"
      ? ((result.output as { verdicts?: unknown }).verdicts ?? {})
      : {};
  const verdicts =
    verdictsRaw !== null && typeof verdictsRaw === "object"
      ? (verdictsRaw as Record<string, unknown>)
      : {};

  return Object.freeze(
    findings.map((finding) => {
      if (finding.detector !== "conflicts") return finding;
      const verdict = parseVerdict(verdicts[finding.id]);
      if (verdict === null || verdict.action === "flag") {
        return withResolverEvidence(finding, "review", {
          ...(verdict !== null
            ? {
                resolver: {
                  action: "flag",
                  ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
                },
              }
            : {}),
        });
      }
      return withResolverEvidence(finding, verdict.action, {
        resolver: {
          action: verdict.action,
          ...(verdict.winner_value !== undefined ? { winner_value: verdict.winner_value } : {}),
          ...(verdict.rationale !== undefined ? { rationale: verdict.rationale } : {}),
        },
      });
    }),
  );
}
