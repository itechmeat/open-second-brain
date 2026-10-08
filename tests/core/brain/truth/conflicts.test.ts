/**
 * Conflict detection over the truth fold (t_e9692750): two distinct
 * values for one slot within the conflict window from independent
 * sources materialize a typed conflict with `resolution: ask_user`;
 * a later value outside the window supersedes silently (normal fact
 * evolution). Purely temporal-structural - no semantics guessing.
 */

import { describe, expect, test } from "bun:test";

import {
  computeTruthStateWithConflicts,
  CONFLICT_WINDOW_DAYS,
} from "../../../../src/core/brain/truth/conflicts.ts";
import { computeTruthState } from "../../../../src/core/brain/truth/fold.ts";
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

describe("computeTruthStateWithConflicts", () => {
  test("default window is 30 days", () => {
    expect(CONFLICT_WINDOW_DAYS).toBe(30);
  });

  test("two values within the window from distinct sources conflict", () => {
    const state = computeTruthStateWithConflicts([
      claim(),
      claim({ ts: "2026-06-10T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
    ]);
    expect(state.conflicts).toHaveLength(1);
    const conflict = state.conflicts[0]!;
    expect(conflict.entity).toBe("alice mason");
    expect(conflict.aspect).toBe("employer");
    expect(conflict.kind).toBe("value_conflict");
    expect(conflict.resolution).toBe("ask_user");
    expect(conflict.detectedAt).toBe("2026-06-10T10:00:00Z");
    expect(conflict.values.map((v) => v.value)).toEqual(["Google", "Meta"]);
    expect(state.slots[0]!.contested).toBe(true);
  });

  test("a later value outside the window supersedes silently", () => {
    const state = computeTruthStateWithConflicts([
      claim({ ts: "2026-01-01T10:00:00Z" }),
      claim({ ts: "2026-06-01T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
    ]);
    expect(state.conflicts).toHaveLength(0);
    expect(state.slots[0]!.contested).toBe(false);
    expect(state.slots[0]!.current.value).toBe("Meta");
    expect(state.slots[0]!.history.map((v) => v.value)).toEqual(["Google"]);
  });

  test("the same source changing its value is self-correction, not conflict", () => {
    const state = computeTruthStateWithConflicts([
      claim(),
      claim({ ts: "2026-06-10T10:00:00Z", value: "Meta" }),
    ]);
    expect(state.conflicts).toHaveLength(0);
    expect(state.slots[0]!.contested).toBe(false);
  });

  test("three contesting values raise the priority", () => {
    const base = computeTruthStateWithConflicts([
      claim(),
      claim({ ts: "2026-06-05T10:00:00Z", value: "Meta", source: "[[Brain/notes/b.md]]" }),
    ]);
    const more = computeTruthStateWithConflicts([
      claim(),
      claim({ ts: "2026-06-05T10:00:00Z", value: "Meta", source: "[[Brain/notes/b.md]]" }),
      claim({ ts: "2026-06-10T10:00:00Z", value: "Anthropic", source: "[[Brain/notes/c.md]]" }),
    ]);
    expect(more.conflicts[0]!.priority).toBeGreaterThan(base.conflicts[0]!.priority);
    expect(more.conflicts[0]!.values.map((v) => v.value)).toEqual(["Google", "Meta", "Anthropic"]);
  });

  test("custom window widens or narrows detection", () => {
    const events = [
      claim({ ts: "2026-01-01T10:00:00Z" }),
      claim({ ts: "2026-03-01T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
    ];
    expect(computeTruthStateWithConflicts(events).conflicts).toHaveLength(0);
    expect(computeTruthStateWithConflicts(events, { windowDays: 90 }).conflicts).toHaveLength(1);
  });

  test("without conflicts the state matches the base fold exactly", () => {
    const events = [
      claim(),
      claim({ ts: "2026-08-01T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
      claim({ entity: "bob hale", value: "Acme", source: "[[Brain/notes/bob.md]]" }),
    ];
    expect(computeTruthStateWithConflicts(events)).toEqual(computeTruthState(events));
  });

  test("conflicts sort deterministically by entity then aspect", () => {
    const state = computeTruthStateWithConflicts([
      claim({ entity: "zoe", aspect: "role", value: "dev" }),
      claim({
        entity: "zoe",
        aspect: "role",
        ts: "2026-06-02T10:00:00Z",
        value: "ops",
        source: "[[Brain/notes/z.md]]",
      }),
      claim(),
      claim({ ts: "2026-06-02T10:00:00Z", value: "Meta", source: "[[Brain/notes/b.md]]" }),
    ]);
    expect(state.conflicts.map((c) => c.entity)).toEqual(["alice mason", "zoe"]);
  });

  test("empty events fold to the empty state (bit-identical neutral default)", () => {
    expect(computeTruthStateWithConflicts([])).toEqual(computeTruthState([]));
  });
});

describe("succession channel", () => {
  test("present non-overlapping windows classify as succession, never a conflict", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        ts: "2026-06-10T10:00:00Z",
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    const state = computeTruthStateWithConflicts(events);
    // Five days apart from distinct sources: the assertion-time rule
    // would contest; the disjoint windows make it a succession.
    expect(state.conflicts).toHaveLength(0);
    expect(state.slots[0]!.contested).toBe(false);
    expect(state.successions).toHaveLength(1);
    expect(state.successions![0]!.predecessor.value).toBe("Google");
    expect(state.successions![0]!.successor.value).toBe("Meta");
  });

  test("intersecting windows fall through to the contest rule verbatim", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2026-06-01" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    const state = computeTruthStateWithConflicts(events);
    expect(state.conflicts).toHaveLength(1);
    expect(state.successions).toBeUndefined();
  });

  test("any windowless claim falls through to the contest rule verbatim", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({ value: "Meta", source: "[[Brain/notes/later.md]]" }),
    ];
    const state = computeTruthStateWithConflicts(events);
    expect(state.conflicts).toHaveLength(1);
    expect(state.successions).toBeUndefined();
  });

  test("an expired window never suppresses contestation on its own", () => {
    // The expired window intersects the successor's open window, so the
    // pair keeps the assertion-time contest despite the expiry.
    const events = [
      claim({ validFrom: "2020-01-01", validUntil: "2021-01-01" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2020-06-01",
      }),
    ];
    const state = computeTruthStateWithConflicts(events);
    expect(state.conflicts).toHaveLength(1);
    expect(state.successions).toBeUndefined();
  });

  test("successions appear even when nothing contests", () => {
    const events = [
      claim({ ts: "2026-01-01T10:00:00Z", validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        ts: "2026-06-10T10:00:00Z",
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    // Far apart in assertion time: no contest either way, succession still reported.
    const state = computeTruthStateWithConflicts(events);
    expect(state.conflicts).toHaveLength(0);
    expect(state.successions).toHaveLength(1);
  });

  test("successions are presence-gated: absent, not empty, whenever empty", () => {
    const state = computeTruthStateWithConflicts([
      claim(),
      claim({ ts: "2026-08-01T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
    ]);
    expect("successions" in state).toBe(false);
    expect(state.successions).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("successions");
  });

  test("a present succession serializes by conditional spread", () => {
    const state = computeTruthStateWithConflicts([
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ]);
    const round = JSON.parse(JSON.stringify(state)) as { successions?: unknown[] };
    expect(round.successions).toHaveLength(1);
  });
});
