import { defaultConfigPath } from "../../../core/config.ts";
import {
  diffAgentSources,
  type AgentSourceDiffMode,
  type AgentSourceDiffResult,
} from "../../../core/brain/agent-source/diff.ts";
import type { AgentSourceContributionKind } from "../../../core/brain/agent-source/types.ts";
import { parse, fail, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainAgentDiff(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    mode: { type: "string" },
    agent: { type: "string-array" },
    topic: { type: "string" },
    query: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const { value: mode, error: modeError } = parseMode(
    flags["mode"] as string | undefined,
  );
  if (modeError) return fail(modeError);
  const { value: kind, error: kindError } = parseKind(
    flags["kind"] as string | undefined,
  );
  if (kindError) return fail(kindError);
  const { value: limit, error: limitError } = parseLimit(
    flags["limit"] as string | undefined,
  );
  if (limitError) return fail(limitError);

  const result = diffAgentSources(vault, {
    ...(mode !== undefined ? { mode } : {}),
    agents: (flags["agent"] as string[] | undefined) ?? [],
    ...(typeof flags["topic"] === "string" ? { topic: flags["topic"] } : {}),
    ...(typeof flags["query"] === "string" ? { query: flags["query"] } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    renderAgentDiffText(result);
  }
  return 0;
}

function renderAgentDiffText(result: AgentSourceDiffResult): void {
  process.stdout.write(`agent diff: ${result.diff_mode}\n`);
  process.stdout.write(`summary: ${result.summary}\n`);
  process.stdout.write(`agents: ${result.agents.join(", ") || "(none)"}\n`);
  if (result.unknown_agents.length > 0) {
    process.stdout.write(
      `unknown agents: ${result.unknown_agents.join(", ")}\n`,
    );
  }
  process.stdout.write(
    `shared topics: ${result.shared_topics.join(", ") || "(none)"}\n`,
  );
  for (const agent of result.agents) {
    const topics = result.unique_topics[agent] ?? [];
    process.stdout.write(`${agent} unique: ${topics.join(", ") || "(none)"}\n`);
  }
  process.stdout.write("topic map:\n");
  for (const row of result.topic_map) {
    process.stdout.write(
      `- ${row.topic}: ${row.agents.join(", ")} (${row.contribution_count})\n`,
    );
  }
}

function parseMode(raw: string | undefined): {
  readonly value?: AgentSourceDiffMode;
  readonly error?: string;
} {
  if (raw === undefined) return {};
  if (raw === "browse" || raw === "search" || raw === "diff" || raw === "map") {
    return { value: raw };
  }
  return { error: "--mode must be one of browse|search|diff|map" };
}

function parseKind(raw: string | undefined): {
  readonly value?: AgentSourceContributionKind;
  readonly error?: string;
} {
  if (raw === undefined) return {};
  if (raw === "signal" || raw === "preference" || raw === "log")
    return { value: raw };
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
