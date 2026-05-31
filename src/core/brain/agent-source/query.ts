import { collectAgentSourceContributions, listAgentSources } from "./registry.ts";
import { summarizeAgentContributions } from "./summary.ts";
import type {
  AgentSourceContribution,
  AgentSourceContributionKind,
  AgentSourceSummary,
} from "./types.ts";

export interface AgentSourceQueryOptions {
  readonly agents?: ReadonlyArray<string>;
  readonly topic?: string;
  readonly query?: string;
  readonly kind?: AgentSourceContributionKind;
  readonly limit?: number;
}

export interface AgentSourceQueryFilters {
  readonly agents: ReadonlyArray<string>;
  readonly topic: string | null;
  readonly query: string | null;
  readonly kind: AgentSourceContributionKind | null;
  readonly limit: number;
}

export interface AgentSourceQueryResult {
  readonly mode: "agent-query";
  readonly filters: AgentSourceQueryFilters;
  readonly available_agents: ReadonlyArray<AgentSourceSummary>;
  readonly unknown_agents: ReadonlyArray<string>;
  readonly total_matched: number;
  readonly returned: number;
  readonly contributions: ReadonlyArray<AgentSourceContribution>;
  readonly summary: string;
}

const DEFAULT_LIMIT = 50;

export function queryAgentSources(
  vault: string,
  opts: AgentSourceQueryOptions = {},
): AgentSourceQueryResult {
  const availableAgents = listAgentSources(vault);
  const availableIds = new Set(availableAgents.map((a) => a.id));
  const selectedAgents = normalizeAgents(
    opts.agents,
    availableAgents.map((a) => a.id),
  );
  const selectedSet = new Set(selectedAgents);
  const unknownAgents = selectedAgents.filter((agent) => !availableIds.has(agent));
  const topic = normalizeTextFilter(opts.topic);
  const query = normalizeTextFilter(opts.query);
  const limit = normalizeLimit(opts.limit);

  const matched = collectAgentSourceContributions(vault).filter((contribution) => {
    if (!contribution.agents.some((agent) => selectedSet.has(agent))) return false;
    if (opts.kind !== undefined && contribution.kind !== opts.kind) return false;
    if (topic !== null && contribution.topic !== topic) return false;
    if (query !== null && !matchesText(contribution, query)) return false;
    return true;
  });
  const returned = Object.freeze(matched.slice(0, limit));

  return Object.freeze({
    mode: "agent-query",
    filters: Object.freeze({
      agents: Object.freeze(selectedAgents),
      topic,
      query,
      kind: opts.kind ?? null,
      limit,
    }),
    available_agents: availableAgents,
    unknown_agents: Object.freeze(unknownAgents),
    total_matched: matched.length,
    returned: returned.length,
    contributions: returned,
    summary: summarizeAgentContributions(returned, selectedAgents),
  });
}

function normalizeAgents(
  agents: ReadonlyArray<string> | undefined,
  fallbackAgents: ReadonlyArray<string>,
): string[] {
  const raw = agents === undefined || agents.length === 0 ? fallbackAgents : agents;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const agent = value.trim();
    if (!agent || seen.has(agent)) continue;
    seen.add(agent);
    out.push(agent);
  }
  return out;
}

function normalizeTextFilter(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("agent-source query limit must be a positive integer");
  }
  return value;
}

function matchesText(contribution: AgentSourceContribution, query: string): boolean {
  const needle = query.toLowerCase();
  const fields = [
    contribution.id,
    contribution.title,
    contribution.text,
    contribution.topic ?? "",
    contribution.scope ?? "",
    contribution.agents.join(" "),
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
}
