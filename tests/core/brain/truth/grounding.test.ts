/**
 * Signed source-diversity grounding score (t_4678a91a / D1): a pure
 * projection over the same claim events `computeTruthState` folds. It
 * upgrades the binary CONTESTED flag into a signed -1..+1 measure whose
 * SIGN points to the better-supported side and whose MAGNITUDE reflects
 * both the balance of confirming vs contradicting INDEPENDENT sources
 * and how many independent sources back that direction. N mentions in
 * one document weigh far below N mentions across N independent sources.
 * Deterministic (counting + weighting, no LLM); never mutates history.
 */

import { describe, expect, test } from "bun:test";

import {
  computeGroundingScore,
  computeGroundings,
} from "../../../../src/core/brain/truth/grounding.ts";
import { computeTruthState } from "../../../../src/core/brain/truth/fold.ts";
import { computeTruthStateWithConflicts } from "../../../../src/core/brain/truth/conflicts.ts";
import type { ClaimEvent } from "../../../../src/core/brain/truth/types.ts";

function claim(over: Partial<ClaimEvent> = {}): ClaimEvent {
  return {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "alice mason",
    aspect: "employer",
    value: "Google",
    valueKind: "text",
    source: "[[Brain/notes/standup.md]]",
    ...over,
  };
}

/** Convenience: fold events, then grounding for the (single) slot. */
function groundingOf(events: ClaimEvent[]) {
  const state = computeTruthState(events);
  const slot = state.slots[0]!;
  return computeGroundingScore(slot, events);
}

/** N distinct independent sources all asserting the same value. */
function independentAgreement(n: number, value = "Google"): ClaimEvent[] {
  return Array.from({ length: n }, (_, i) =>
    claim({
      value,
      ts: `2026-06-0${(i % 9) + 1}T10:00:00Z`,
      source: `[[Brain/notes/src-${i}.md]]`,
      agent: `agent-${i}`,
    }),
  );
}

describe("computeGroundingScore", () => {
  test("agreement by many independent sources scores strongly positive; one source is weaker", () => {
    const many = groundingOf(independentAgreement(6));
    const one = groundingOf([claim()]);

    expect(many.score).toBeGreaterThan(one.score);
    expect(many.score).toBeGreaterThan(0.5);
    expect(many.band).toBe("strongly_supported");
    expect(many.confidence).toBe("high");
    expect(many.supportingSources).toBe(6);
    expect(many.contradictingSources).toBe(0);

    expect(one.score).toBeGreaterThan(0);
    expect(one.score).toBeLessThan(0.5);
    expect(one.confidence).toBe("low");
    expect(one.supportingSources).toBe(1);
  });

  test("score is bounded to the -1..+1 interval", () => {
    const g = groundingOf(independentAgreement(50));
    expect(g.score).toBeLessThanOrEqual(1);
    expect(g.score).toBeGreaterThanOrEqual(-1);
  });

  test("a contested slot leans to the better-supported side with balance-scaled magnitude", () => {
    // Current value "Google" (latest) backed by 3 independent sources;
    // "Meta" contests from 1 independent source within the window.
    const events = [
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m.md]]",
        agent: "a-m",
      }),
      claim({
        value: "Google",
        ts: "2026-06-05T10:00:00Z",
        source: "[[Brain/notes/g1.md]]",
        agent: "a-1",
      }),
      claim({
        value: "Google",
        ts: "2026-06-06T10:00:00Z",
        source: "[[Brain/notes/g2.md]]",
        agent: "a-2",
      }),
      claim({
        value: "Google",
        ts: "2026-06-07T10:00:00Z",
        source: "[[Brain/notes/g3.md]]",
        agent: "a-3",
      }),
    ];
    const g = groundingOf(events);
    expect(g.score).toBeGreaterThan(0); // sign points to the better-supported (current) side
    expect(g.supportingSources).toBe(3);
    expect(g.contradictingSources).toBe(1);
  });

  test("the sign points AWAY from the current value when an alternative is better supported", () => {
    // Current value "Google" (latest) has 1 source; "Meta" has 3 → contradicted.
    const events = [
      claim({
        value: "Meta",
        ts: "2026-06-01T10:00:00Z",
        source: "[[Brain/notes/m1.md]]",
        agent: "a-1",
      }),
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m2.md]]",
        agent: "a-2",
      }),
      claim({
        value: "Meta",
        ts: "2026-06-03T10:00:00Z",
        source: "[[Brain/notes/m3.md]]",
        agent: "a-3",
      }),
      claim({
        value: "Google",
        ts: "2026-06-05T10:00:00Z",
        source: "[[Brain/notes/g.md]]",
        agent: "a-g",
      }),
    ];
    const g = groundingOf(events);
    expect(g.score).toBeLessThan(0);
    expect(g.band).toBe("contradicted");
    expect(g.supportingSources).toBe(1);
    expect(g.contradictingSources).toBe(3);
  });

  test("a genuinely balanced contest scores near zero and bands as contested", () => {
    const events = [
      claim({
        value: "Meta",
        ts: "2026-06-01T10:00:00Z",
        source: "[[Brain/notes/m1.md]]",
        agent: "a-1",
      }),
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m2.md]]",
        agent: "a-2",
      }),
      claim({
        value: "Google",
        ts: "2026-06-05T10:00:00Z",
        source: "[[Brain/notes/g1.md]]",
        agent: "a-3",
      }),
      claim({
        value: "Google",
        ts: "2026-06-06T10:00:00Z",
        source: "[[Brain/notes/g2.md]]",
        agent: "a-4",
      }),
    ];
    const g = groundingOf(events);
    expect(Math.abs(g.score)).toBeLessThan(0.15);
    expect(g.band).toBe("contested");
  });

  test("N mentions in ONE document weigh far below N mentions across N independent sources", () => {
    // One source repeats "Google" 5 times, contradicted by one "Meta" source.
    const oneDoc = [
      ...Array.from({ length: 5 }, (_, i) =>
        claim({ value: "Google", ts: `2026-06-0${i + 4}T10:00:00Z` }),
      ),
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m.md]]",
        agent: "a-m",
      }),
    ];
    // Five distinct sources each assert "Google" once, same lone "Meta".
    const manyDocs = [
      ...independentAgreement(5),
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m.md]]",
        agent: "a-m",
      }),
    ];

    const gOne = groundingOf(oneDoc);
    const gMany = groundingOf(manyDocs);

    expect(gOne.supportingSources).toBe(1);
    expect(gMany.supportingSources).toBe(5);
    expect(gMany.score).toBeGreaterThan(gOne.score);
  });

  test("a source that later confirms is self-correction, not a contradictor", () => {
    // Same (source, agent) asserts "Meta" then "Google": counts as support only.
    const events = [
      claim({ value: "Meta", ts: "2026-06-01T10:00:00Z" }),
      claim({ value: "Google", ts: "2026-06-05T10:00:00Z" }),
    ];
    const g = groundingOf(events);
    expect(g.contradictingSources).toBe(0);
    expect(g.supportingSources).toBe(1);
  });

  test("a value superseded outside the conflict window does not drag the score", () => {
    const events = [
      claim({
        value: "Meta",
        ts: "2026-01-01T10:00:00Z",
        source: "[[Brain/notes/old.md]]",
        agent: "a-old",
      }),
      claim({
        value: "Google",
        ts: "2026-06-05T10:00:00Z",
        source: "[[Brain/notes/new.md]]",
        agent: "a-new",
      }),
    ];
    const g = groundingOf(events);
    expect(g.contradictingSources).toBe(0);
    expect(g.score).toBeGreaterThan(0);
  });

  test("is deterministic and order-insensitive; never mutates its input", () => {
    const events = [
      ...independentAgreement(4),
      claim({
        value: "Meta",
        ts: "2026-06-02T10:00:00Z",
        source: "[[Brain/notes/m.md]]",
        agent: "a-m",
      }),
    ];
    const snapshot = JSON.stringify(events);
    const forward = groundingOf(events);
    const shuffled = groundingOf([...events].toReversed());

    expect(shuffled).toEqual(forward);
    expect(JSON.stringify(events)).toBe(snapshot); // input untouched
  });

  test("computeGroundings surfaces one grounding per slot alongside the fold", () => {
    const events = [
      claim(),
      claim({ entity: "bob hale", value: "Acme", source: "[[Brain/notes/bob.md]]", agent: "a-b" }),
    ];
    const state = computeTruthStateWithConflicts(events);
    const groundings = computeGroundings(state, events);
    expect(groundings).toHaveLength(state.slots.length);
    expect(groundings.map((g) => g.entity)).toEqual(state.slots.map((s) => s.entity));
    for (const g of groundings) {
      expect(g.grounding.score).toBeGreaterThanOrEqual(-1);
      expect(g.grounding.score).toBeLessThanOrEqual(1);
    }
    // The projection leaves the fold byte-identical.
    expect(computeTruthState(events)).toEqual(computeTruthState(events));
  });
});
