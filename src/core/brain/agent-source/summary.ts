import type { AgentSourceContribution } from "./types.ts";

export function summarizeAgentContributions(
  contributions: ReadonlyArray<AgentSourceContribution>,
  agents: ReadonlyArray<string>,
): string {
  if (contributions.length === 0) {
    return "No contributions matched the selected filters.";
  }

  const lines: string[] = [];
  for (const agent of agents) {
    const agentContributions = contributions.filter((c) => c.agents.includes(agent));
    if (agentContributions.length === 0) continue;
    const topics = new Set<string>();
    const kinds = new Set<string>();
    for (const contribution of agentContributions) {
      if (contribution.topic !== undefined) topics.add(contribution.topic);
      kinds.add(contribution.kind);
    }
    const topicPart = `${topics.size} ${topics.size === 1 ? "topic" : "topics"}`;
    lines.push(
      `${agent}: ${agentContributions.length} contributions across ${topicPart} (${[...kinds].toSorted().join(", ")}).`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "No contributions matched the selected filters.";
}
