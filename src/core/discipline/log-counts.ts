import { parseLogDay } from "../brain/log.ts";

export interface AgentCounts {
  readonly feedback: number;
  readonly apply_evidence: number;
  readonly other: number;
  readonly total: number;
}

export interface BrainEventCounts {
  readonly byAgent: Readonly<Record<string, AgentCounts>>;
  readonly unknownAgents: ReadonlyArray<{ agent: string; counts: AgentCounts }>;
  readonly total: number;
}

function zero(): AgentCounts {
  return { feedback: 0, apply_evidence: 0, other: 0, total: 0 };
}

function bump(c: AgentCounts, kind: string): AgentCounts {
  if (kind === "feedback") return { ...c, feedback: c.feedback + 1, total: c.total + 1 };
  if (kind === "apply-evidence") return { ...c, apply_evidence: c.apply_evidence + 1, total: c.total + 1 };
  return { ...c, other: c.other + 1, total: c.total + 1 };
}

export function countBrainEvents(
  vault: string,
  date: string,
  knownAgents: ReadonlyArray<string>,
): BrainEventCounts {
  const byAgent: Record<string, AgentCounts> = {};
  for (const a of knownAgents) byAgent[a] = zero();

  const unknown: Record<string, AgentCounts> = {};
  const { entries } = parseLogDay(vault, date);
  let total = 0;
  for (const e of entries) {
    const agentField = e.body["agent"];
    if (!agentField || typeof agentField !== "string") continue;
    const target = knownAgents.includes(agentField) ? byAgent : unknown;
    target[agentField] = bump(target[agentField] ?? zero(), e.eventType);
    total += 1;
  }

  return {
    byAgent,
    unknownAgents: Object.entries(unknown).map(([agent, counts]) => ({ agent, counts })),
    total,
  };
}
