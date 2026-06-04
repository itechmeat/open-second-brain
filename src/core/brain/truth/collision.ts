/**
 * Cross-agent collision detection (t_f2b225b1): two agents that
 * independently logged claims about one entity within the recent
 * window - citing different sources - have converging knowledge
 * neither knows about. The detector folds recent ledger events into
 * bounded findings; `collisionCandidates` turns findings into trigger
 * candidates so the standing trigger queue (Kernel B) delivers them
 * push-mode with cooldown dedup, instead of waiting for an operator
 * to run a pull-mode agent diff.
 */

import type { InsightCandidate } from "../triggers/types.ts";
import type { ClaimEvent } from "./types.ts";

/** Claims older than this many days never participate. */
export const COLLISION_WINDOW_DAYS = 14;
/** Cap on findings per detection pass. */
export const COLLISION_FINDINGS_CAP = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentCollisionFinding {
  readonly entity: string;
  /** Distinct agents involved, sorted. */
  readonly agents: ReadonlyArray<string>;
  /** Distinct aspects touched, sorted. */
  readonly aspects: ReadonlyArray<string>;
  /** Distinct sources cited, sorted. */
  readonly sources: ReadonlyArray<string>;
  /** Participating claim count. */
  readonly claims: number;
  /** Timestamp of the newest participating claim. */
  readonly detectedAt: string;
}

export interface DetectCollisionOptions {
  readonly now: Date;
  readonly windowDays?: number;
  readonly cap?: number;
}

/**
 * Group recent claims by entity; an entity claimed by 2+ distinct
 * agents citing 2+ distinct sources is a collision. Findings sort by
 * recency (newest first) and are bounded by the cap.
 */
export function detectAgentCollisions(
  events: ReadonlyArray<ClaimEvent>,
  opts: DetectCollisionOptions,
): ReadonlyArray<AgentCollisionFinding> {
  const windowDays = opts.windowDays ?? COLLISION_WINDOW_DAYS;
  const cap = opts.cap ?? COLLISION_FINDINGS_CAP;
  const cutoff = opts.now.getTime() - windowDays * DAY_MS;

  const byEntity = new Map<string, ClaimEvent[]>();
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const list = byEntity.get(e.entity) ?? [];
    list.push(e);
    byEntity.set(e.entity, list);
  }

  const findings: AgentCollisionFinding[] = [];
  for (const entity of [...byEntity.keys()].toSorted()) {
    const claims = byEntity.get(entity)!;
    const agents = [...new Set(claims.map((c) => c.agent))].toSorted();
    if (agents.length < 2) continue;
    const sources = [...new Set(claims.map((c) => c.source))].toSorted();
    if (sources.length < 2) continue;
    const aspects = [...new Set(claims.map((c) => c.aspect))].toSorted();
    const detectedAt = claims
      .map((c) => c.ts)
      .toSorted()
      .at(-1)!;
    findings.push(
      Object.freeze({
        entity,
        agents: Object.freeze(agents),
        aspects: Object.freeze(aspects),
        sources: Object.freeze(sources),
        claims: claims.length,
        detectedAt,
      }),
    );
  }

  findings.sort((a, b) => {
    if (a.detectedAt !== b.detectedAt) return a.detectedAt < b.detectedAt ? 1 : -1;
    return a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0;
  });
  return Object.freeze(findings.slice(0, cap));
}

/** Findings as trigger candidates for the standing queue. */
export function collisionCandidates(
  findings: ReadonlyArray<AgentCollisionFinding>,
  windowDays: number = COLLISION_WINDOW_DAYS,
): ReadonlyArray<InsightCandidate> {
  return Object.freeze(
    findings.map((f) =>
      Object.freeze({
        kind: "agent_collision" as const,
        urgency: "medium" as const,
        reason:
          `${f.agents.join(" and ")} independently logged ${f.claims} claim(s) about ` +
          `${f.entity} within ${windowDays}d (aspects: ${f.aspects.join(", ")})`,
        suggestedAction: "Cross-reference the converging claims and connect or reconcile them",
        sourceArtifacts: Object.freeze([...f.sources]),
        contextSnippets: Object.freeze([`entity: ${f.entity}`, `agents: ${f.agents.join(", ")}`]),
        cooldownKey: `agent_collision:${f.entity}:${f.agents.join("+")}`,
      }),
    ),
  );
}
