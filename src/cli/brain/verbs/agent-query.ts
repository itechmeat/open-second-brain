import {
  queryAgentSources,
  type AgentSourceQueryResult,
} from "../../../core/brain/agent-source/query.ts";
import type { AgentSourceContributionKind } from "../../../core/brain/agent-source/types.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

export async function cmdBrainAgentQuery(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string-array" },
    topic: { type: "string" },
    query: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const { value: kind, error: kindError } = parseKind(flags["kind"] as string | undefined);
  if (kindError) return fail(kindError);
  const { value: limit, error: limitError } = parseLimit(flags["limit"] as string | undefined);
  if (limitError) return fail(limitError);

  const result = queryAgentSources(vault, {
    agents: (flags["agent"] as string[] | undefined) ?? [],
    ...(typeof flags["topic"] === "string" ? { topic: flags["topic"] } : {}),
    ...(typeof flags["query"] === "string" ? { query: flags["query"] } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    renderAgentQueryText(result);
  }
  return 0;
}

function renderAgentQueryText(result: AgentSourceQueryResult): void {
  process.stdout.write(`agent query:\n`);
  process.stdout.write(`summary: ${result.summary}\n`);
  process.stdout.write(`matched: ${result.total_matched}\n`);
  process.stdout.write(`returned: ${result.returned}\n`);
  process.stdout.write(`agents: ${result.filters.agents.join(", ") || "(none)"}\n`);
  if (result.unknown_agents.length > 0) {
    process.stdout.write(`unknown agents: ${result.unknown_agents.join(", ")}\n`);
  }
  for (const contribution of result.contributions) {
    const topic = contribution.topic ? ` ${contribution.topic}` : "";
    process.stdout.write(
      `- [${contribution.kind}] ${contribution.id} (${contribution.agents.join(", ")})${topic}\n`,
    );
  }
}

function parseKind(raw: string | undefined): {
  readonly value?: AgentSourceContributionKind;
  readonly error?: string;
} {
  if (raw === undefined) return {};
  if (raw === "signal" || raw === "preference" || raw === "log") return { value: raw };
  return { error: "--kind must be one of signal|preference|log" };
}

function parseLimit(raw: string | undefined): {
  readonly value?: number;
  readonly error?: string;
} {
  if (raw === undefined) return {};
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw || value < 1) {
    return { error: "--limit must be a positive integer" };
  }
  return { value };
}
