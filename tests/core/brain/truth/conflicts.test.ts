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
