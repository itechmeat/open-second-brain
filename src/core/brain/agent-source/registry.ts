import { isConfiguredAgentName } from "../../config.ts";
import { vaultAgentSourceProvider } from "./vault-provider.ts";
import type {
  AgentSourceContribution,
  AgentSourceContributionKind,
  AgentSourceProvider,
  AgentSourceSummary,
} from "./types.ts";
import { deepFreeze } from "./freeze.ts";

export const AGENT_SOURCE_PROVIDERS: ReadonlyArray<AgentSourceProvider> = Object.freeze([
  vaultAgentSourceProvider,
]);

export function collectAgentSourceContributions(
  vault: string,
): ReadonlyArray<AgentSourceContribution> {
  const contributions: AgentSourceContribution[] = [];
  for (const provider of AGENT_SOURCE_PROVIDERS) {
    contributions.push(...provider.collect(vault));
  }
  contributions.sort(compareContributions);
  return deepFreeze(contributions);
}

export function listAgentSources(vault: string): ReadonlyArray<AgentSourceSummary> {
  return summarizeAgentSources(collectAgentSourceContributions(vault));
}

/**
 * Fold a contribution set into the per-agent roster.
 *
 * Takes the set rather than the vault so a caller that has already
 * filtered - `queryAgentSources` under an owner scope - summarizes what
 * it may actually see. Building the roster from the vault independently
 * of the filter published the withheld contributions' topics verbatim and
 * counted them (context-integrity-gates, A5), which is the existence leak
 * the ownership boundary exists to prevent.
 */
export function summarizeAgentSources(
  contributions: ReadonlyArray<AgentSourceContribution>,
): ReadonlyArray<AgentSourceSummary> {
  const byAgent = new Map<
    string,
    {
      providerIds: Set<string>;
      kinds: Set<AgentSourceContributionKind>;
      topics: Set<string>;
      contributionCount: number;
      lastActivity: string;
    }
  >();

  for (const contribution of contributions) {
    for (const agent of contribution.agents) {
      const current = byAgent.get(agent) ?? {
        providerIds: new Set<string>(),
        kinds: new Set<AgentSourceContributionKind>(),
        topics: new Set<string>(),
        contributionCount: 0,
        lastActivity: contribution.timestamp,
      };
      current.providerIds.add(contribution.provider_id);
      current.kinds.add(contribution.kind);
      if (contribution.topic !== undefined) current.topics.add(contribution.topic);
      current.contributionCount++;
      // Folded rather than read off the last element: the caller may hand
      // in a filtered set, and an owner-scoped filter can remove exactly
      // the newest contribution.
      if (contribution.timestamp.localeCompare(current.lastActivity) > 0) {
        current.lastActivity = contribution.timestamp;
      }
      byAgent.set(agent, current);
    }
  }

  const summaries: AgentSourceSummary[] = [];
  for (const [id, summary] of byAgent) {
    summaries.push(
      Object.freeze({
        id,
        provider_ids: Object.freeze([...summary.providerIds].toSorted()),
        contribution_count: summary.contributionCount,
        last_activity: summary.lastActivity,
        identity_configured: isConfiguredAgentName(id),
        kinds: Object.freeze([...summary.kinds].toSorted()),
        topics: Object.freeze([...summary.topics].toSorted()),
      }),
    );
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return deepFreeze(summaries);
}

function compareContributions(a: AgentSourceContribution, b: AgentSourceContribution): number {
  const byTimestamp = a.timestamp.localeCompare(b.timestamp);
  if (byTimestamp !== 0) return byTimestamp;
  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;
  return a.id.localeCompare(b.id);
}
