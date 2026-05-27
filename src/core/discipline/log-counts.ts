import { readLogDay } from "../brain/log-jsonl.ts";

export interface AgentCounts {
  readonly feedback: number;
  readonly apply_evidence: number;
  /** §32B (v0.10.8): narrative-milestone events written by `brain_note`. */
  readonly note: number;
  readonly other: number;
  readonly total: number;
}

export interface BrainEventCounts {
  readonly byAgent: Readonly<Record<string, AgentCounts>>;
  readonly unknownAgents: ReadonlyArray<{ agent: string; counts: AgentCounts }>;
  readonly total: number;
}

function zero(): AgentCounts {
  return { feedback: 0, apply_evidence: 0, note: 0, other: 0, total: 0 };
}

function bump(c: AgentCounts, kind: string): AgentCounts {
  if (kind === "feedback") return { ...c, feedback: c.feedback + 1, total: c.total + 1 };
  if (kind === "apply-evidence")
    return { ...c, apply_evidence: c.apply_evidence + 1, total: c.total + 1 };
  if (kind === "note") return { ...c, note: c.note + 1, total: c.total + 1 };
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
  // §23 (v0.10.8): read through the JSONL-preferred reader. Historical
  // markdown-only days are served by the reader's fallback path so
  // discipline-report stays correct across the v0.10.8 boundary.
  const { entries } = readLogDay(vault, date);
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
