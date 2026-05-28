import { vaultAgentSourceProvider } from "./vault-provider.ts";
import type {
  AgentSourceContribution,
  AgentSourceContributionKind,
  AgentSourceProvider,
  AgentSourceSummary,
} from "./types.ts";

export const AGENT_SOURCE_PROVIDERS: ReadonlyArray<AgentSourceProvider> =
  Object.freeze([vaultAgentSourceProvider]);

export function collectAgentSourceContributions(
  vault: string,
): ReadonlyArray<AgentSourceContribution> {
  const contributions: AgentSourceContribution[] = [];
  for (const provider of AGENT_SOURCE_PROVIDERS) {
    contributions.push(...provider.collect(vault));
  }
  contributions.sort(compareContributions);
  return Object.freeze(contributions);
}

export function listAgentSources(
  vault: string,
): ReadonlyArray<AgentSourceSummary> {
  const byAgent = new Map<
    string,
    {
      providerIds: Set<string>;
      kinds: Set<AgentSourceContributionKind>;
      topics: Set<string>;
      contributionCount: number;
    }
  >();

  for (const contribution of collectAgentSourceContributions(vault)) {
    for (const agent of contribution.agents) {
      const current = byAgent.get(agent) ?? {
        providerIds: new Set<string>(),
        kinds: new Set<AgentSourceContributionKind>(),
        topics: new Set<string>(),
        contributionCount: 0,
      };
      current.providerIds.add(contribution.provider_id);
      current.kinds.add(contribution.kind);
      if (contribution.topic !== undefined)
        current.topics.add(contribution.topic);
      current.contributionCount++;
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
        kinds: Object.freeze([...summary.kinds].toSorted()),
        topics: Object.freeze([...summary.topics].toSorted()),
      }),
    );
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze(summaries);
}

function compareContributions(
  a: AgentSourceContribution,
  b: AgentSourceContribution,
): number {
  const byTimestamp = a.timestamp.localeCompare(b.timestamp);
  if (byTimestamp !== 0) return byTimestamp;
  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;
  return a.id.localeCompare(b.id);
}
