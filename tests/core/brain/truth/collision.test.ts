/**
 * Cross-agent collision detection (t_f2b225b1): when two agents
 * independently wrote claims about one entity within the recent
 * window - citing different sources, neither aware of the other -
 * the knowledge must not stay trapped where it was learned. Findings
 * surface push-mode through the standing trigger queue with cooldown
 * dedup, not through an operator-invoked diff.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COLLISION_WINDOW_DAYS,
  collisionCandidates,
  detectAgentCollisions,
} from "../../../../src/core/brain/truth/collision.ts";
import { appendClaimEvent } from "../../../../src/core/brain/truth/store.ts";
import { listTriggers } from "../../../../src/core/brain/triggers/store.ts";
import { scanTriggers } from "../../../../src/core/brain/triggers/scan.ts";
import type { ClaimEvent } from "../../../../src/core/brain/truth/types.ts";

const NOW = new Date("2026-06-04T12:00:00Z");

function claim(over: Partial<ClaimEvent> = {}): ClaimEvent {
  return {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "project atlas",
    aspect: "pricing page",
    value: "customers find it confusing",
    valueKind: "text",
    source: "[[Brain/notes/support-call.md]]",
    ...over,
  };
}

describe("detectAgentCollisions (pure)", () => {
  test("two agents, distinct sources, one entity, recent window -> one finding", () => {
    const findings = detectAgentCollisions(
      [
        claim(),
        claim({
          ts: "2026-06-02T10:00:00Z",
          agent: "sales-agent",
          aspect: "pricing deal",
          value: "deal stalled over pricing",
          source: "[[Brain/notes/deal-review.md]]",
        }),
      ],
      { now: NOW },
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.entity).toBe("project atlas");
    expect(f.agents).toEqual(["claude-dev-agent", "sales-agent"]);
    expect(f.aspects).toEqual(["pricing deal", "pricing page"]);
    expect(f.claims).toBe(2);
    expect(f.detectedAt).toBe("2026-06-02T10:00:00Z");
  });

  test("a single agent never collides with itself", () => {
    const findings = detectAgentCollisions(
      [claim(), claim({ ts: "2026-06-02T10:00:00Z", aspect: "pricing deal" })],
      { now: NOW },
    );
    expect(findings).toHaveLength(0);
  });

  test("two agents citing the same source are not independent", () => {
    const findings = detectAgentCollisions(
      [claim(), claim({ ts: "2026-06-02T10:00:00Z", agent: "sales-agent" })],
      { now: NOW },
    );
    expect(findings).toHaveLength(0);
  });

  test("claims outside the window never participate", () => {
    const findings = detectAgentCollisions(
      [
        claim({ ts: "2026-01-01T10:00:00Z" }),
        claim({
          ts: "2026-06-02T10:00:00Z",
          agent: "sales-agent",
          source: "[[Brain/notes/deal-review.md]]",
        }),
      ],
      { now: NOW },
    );
    expect(findings).toHaveLength(0);
    expect(COLLISION_WINDOW_DAYS).toBe(14);
  });

  test("findings are bounded by the cap, most recent first", () => {
    const events: ClaimEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const entity = `entity-${String(i).padStart(2, "0")}`;
      events.push(
        claim({ entity, ts: `2026-06-0${(i % 3) + 1}T10:00:00Z` }),
        claim({
          entity,
          ts: `2026-06-0${(i % 3) + 2}T10:00:00Z`,
          agent: "sales-agent",
          source: "[[Brain/notes/other.md]]",
        }),
      );
    }
    const findings = detectAgentCollisions(events, { now: NOW, cap: 5 });
    expect(findings).toHaveLength(5);
  });

  test("empty events detect nothing", () => {
    expect(detectAgentCollisions([], { now: NOW })).toEqual([]);
  });
});

describe("collisionCandidates", () => {
  test("findings become agent_collision trigger candidates with stable cooldown keys", () => {
    const findings = detectAgentCollisions(
      [
        claim(),
        claim({
          ts: "2026-06-02T10:00:00Z",
          agent: "sales-agent",
          source: "[[Brain/notes/deal-review.md]]",
        }),
      ],
      { now: NOW },
    );
    const candidates = collisionCandidates(findings);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.kind).toBe("agent_collision");
    expect(c.urgency).toBe("medium");
    expect(c.reason).toContain("claude-dev-agent");
    expect(c.reason).toContain("sales-agent");
    expect(c.reason).toContain("project atlas");
    expect(c.cooldownKey).toBe("agent_collision:project atlas:claude-dev-agent+sales-agent");
    expect(c.sourceArtifacts).toContain("[[Brain/notes/support-call.md]]");
    expect(c.sourceArtifacts).toContain("[[Brain/notes/deal-review.md]]");
  });
});

describe("scanTriggers push-mode wiring", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-collision-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("a collision in the ledger lands as a pending trigger; cooldown blocks repeats", () => {
    appendClaimEvent(vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "claude-dev-agent",
      entity: "Project Atlas",
      aspect: "pricing page",
      value: "customers find it confusing",
      source: "[[Brain/notes/support-call.md]]",
    });
    appendClaimEvent(vault, {
      ts: "2026-06-02T10:00:00Z",
      agent: "sales-agent",
      entity: "Project Atlas",
      aspect: "pricing deal",
      value: "deal stalled over pricing",
      source: "[[Brain/notes/deal-review.md]]",
    });

    const first = scanTriggers(vault, { now: NOW });
    const collisions = listTriggers(vault, { now: NOW }).filter(
      (t) => t.kind === "agent_collision",
    );
    expect(collisions).toHaveLength(1);
    expect(first.created.length).toBeGreaterThanOrEqual(1);

    const second = scanTriggers(vault, { now: NOW });
    const after = listTriggers(vault, { now: NOW }).filter((t) => t.kind === "agent_collision");
    expect(after).toHaveLength(1);
    expect(
      second.skipped.some(
        (s) => s.cooldownKey.startsWith("agent_collision:") && s.reason === "active",
      ),
    ).toBe(true);
  });

  test("an empty ledger contributes no collision candidates", () => {
    scanTriggers(vault, { now: NOW });
    expect(listTriggers(vault, { now: NOW }).filter((t) => t.kind === "agent_collision")).toEqual(
      [],
    );
  });
});
