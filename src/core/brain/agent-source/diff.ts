import { queryAgentSources, type AgentSourceQueryOptions } from "./query.ts";
import type { AgentSourceContribution, AgentSourceContributionKind } from "./types.ts";

export type AgentSourceDiffMode = "browse" | "search" | "diff" | "map";

export interface AgentSourceDiffOptions extends AgentSourceQueryOptions {
  readonly mode?: AgentSourceDiffMode;
}

export interface AgentSourceDiffPerAgent {
  readonly agent: string;
  readonly contribution_count: number;
  readonly topics: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<AgentSourceContributionKind>;
}

export interface AgentSourceDiffTopicMapEntry {
  readonly topic: string;
  readonly agents: ReadonlyArray<string>;
  readonly contribution_count: number;
}

export interface AgentSourceDiffResult {
  readonly mode: "agent-diff";
  readonly diff_mode: AgentSourceDiffMode;
  readonly agents: ReadonlyArray<string>;
  readonly unknown_agents: ReadonlyArray<string>;
  readonly per_agent: ReadonlyArray<AgentSourceDiffPerAgent>;
  readonly shared_topics: ReadonlyArray<string>;
  readonly unique_topics: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly topic_map: ReadonlyArray<AgentSourceDiffTopicMapEntry>;
  readonly total_matched: number;
  readonly returned: number;
  readonly contributions: ReadonlyArray<AgentSourceContribution>;
  readonly summary: string;
}

export function diffAgentSources(
  vault: string,
  opts: AgentSourceDiffOptions = {},
): AgentSourceDiffResult {
  const diffMode = opts.mode ?? (opts.query ? "search" : "browse");
  const query = queryAgentSources(vault, opts);
  const perAgent = buildPerAgent(query.filters.agents, query.contributions);
  const topicMap = buildTopicMap(query.contributions);
  const sharedTopics = buildSharedTopics(query.filters.agents, perAgent);
  const uniqueTopics = buildUniqueTopics(query.filters.agents, perAgent);

  return Object.freeze({
    mode: "agent-diff",
    diff_mode: diffMode,
    agents: query.filters.agents,
    unknown_agents: query.unknown_agents,
    per_agent: Object.freeze(perAgent),
    shared_topics: Object.freeze(sharedTopics),
    unique_topics: Object.freeze(uniqueTopics),
    topic_map: Object.freeze(topicMap),
    total_matched: query.total_matched,
    returned: query.returned,
    contributions: query.contributions,
    summary: summarizeDiff(diffMode, sharedTopics, uniqueTopics),
  });
}

function buildPerAgent(
  agents: ReadonlyArray<string>,
  contributions: ReadonlyArray<AgentSourceContribution>,
): AgentSourceDiffPerAgent[] {
  return agents.map((agent) => {
    const agentContributions = contributions.filter((c) => c.agents.includes(agent));
    const topics = new Set<string>();
    const kinds = new Set<AgentSourceContributionKind>();
    for (const contribution of agentContributions) {
      if (contribution.topic !== undefined) topics.add(contribution.topic);
      kinds.add(contribution.kind);
    }
    return Object.freeze({
      agent,
      contribution_count: agentContributions.length,
      topics: Object.freeze([...topics].toSorted()),
      kinds: Object.freeze([...kinds].toSorted()),
    });
  });
}

function buildTopicMap(
  contributions: ReadonlyArray<AgentSourceContribution>,
): AgentSourceDiffTopicMapEntry[] {
  const byTopic = new Map<string, { agents: Set<string>; contributionCount: number }>();
  for (const contribution of contributions) {
    if (contribution.topic === undefined) continue;
    const current = byTopic.get(contribution.topic) ?? {
      agents: new Set<string>(),
      contributionCount: 0,
    };
    for (const agent of contribution.agents) current.agents.add(agent);
    current.contributionCount++;
    byTopic.set(contribution.topic, current);
  }

  const rows: AgentSourceDiffTopicMapEntry[] = [];
  for (const [topic, row] of byTopic) {
    rows.push(
      Object.freeze({
        topic,
        agents: Object.freeze([...row.agents].toSorted()),
        contribution_count: row.contributionCount,
      }),
    );
  }
  rows.sort((a, b) => a.topic.localeCompare(b.topic));
  return rows;
}

function buildSharedTopics(
  agents: ReadonlyArray<string>,
  perAgent: ReadonlyArray<AgentSourceDiffPerAgent>,
): string[] {
  if (agents.length === 0) return [];
  const topicSets = new Map(perAgent.map((entry) => [entry.agent, new Set(entry.topics)]));
  const first = topicSets.get(agents[0]!) ?? new Set<string>();
  const shared: string[] = [];
  for (const topic of first) {
    if (agents.every((agent) => topicSets.get(agent)?.has(topic) ?? false)) {
      shared.push(topic);
    }
  }
  return shared.toSorted();
}

function buildUniqueTopics(
  agents: ReadonlyArray<string>,
  perAgent: ReadonlyArray<AgentSourceDiffPerAgent>,
): Record<string, ReadonlyArray<string>> {
  const topicSets = new Map(perAgent.map((entry) => [entry.agent, new Set(entry.topics)]));
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const agent of agents) {
    const own = topicSets.get(agent) ?? new Set<string>();
    const unique: string[] = [];
    for (const topic of own) {
      const appearsElsewhere = agents.some(
        (other) => other !== agent && (topicSets.get(other)?.has(topic) ?? false),
      );
      if (!appearsElsewhere) unique.push(topic);
    }
    out[agent] = Object.freeze(unique.toSorted());
  }
  return out;
}

function summarizeDiff(
  mode: AgentSourceDiffMode,
  sharedTopics: ReadonlyArray<string>,
  uniqueTopics: Readonly<Record<string, ReadonlyArray<string>>>,
): string {
  const sharedLabel = `${sharedTopics.length} shared ${sharedTopics.length === 1 ? "topic" : "topics"}`;
  const uniqueCount = Object.values(uniqueTopics).reduce((sum, topics) => sum + topics.length, 0);
  const uniqueLabel = `${uniqueCount} unique ${uniqueCount === 1 ? "topic" : "topics"}`;
  return `${mode}: ${sharedLabel}; ${uniqueLabel}.`;
}
