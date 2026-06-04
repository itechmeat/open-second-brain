/**
 * Truth fold (Entity Truth & Self-Improving Dream Suite, t_d6849b56):
 * claim events project into per-(entity, aspect) slots holding the
 * current value plus superseded history with provenance lineage. The
 * fold is deterministic and order-insensitive; an empty event stream
 * folds to an empty state (bit-identical neutral default).
 */

import { describe, expect, test } from "bun:test";

import { computeTruthState, SLOT_HISTORY_CAP } from "../../../../src/core/brain/truth/fold.ts";
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

describe("computeTruthState", () => {
  test("empty events fold to the empty state", () => {
    const state = computeTruthState([]);
    expect(state.version).toBe(1);
    expect(state.events).toBe(0);
    expect(state.updatedAt).toBeNull();
    expect(state.slots).toEqual([]);
    expect(state.conflicts).toEqual([]);
  });

  test("one slot per (entity, aspect); current is the latest value with history preserved", () => {
    const state = computeTruthState([
      claim(),
      claim({ ts: "2026-06-03T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" }),
      claim({ entity: "bob hale", value: "Acme", source: "[[Brain/notes/bob.md]]" }),
    ]);
    expect(state.slots).toHaveLength(2);
    const alice = state.slots.find((s) => s.entity === "alice mason")!;
    expect(alice.aspect).toBe("employer");
    expect(alice.current.value).toBe("Meta");
    expect(alice.current.source).toBe("[[Brain/notes/later.md]]");
    expect(alice.history).toHaveLength(1);
    expect(alice.history[0]!.value).toBe("Google");
    expect(alice.history[0]!.source).toBe("[[Brain/notes/standup.md]]");
  });

  test("the fold is order-insensitive", () => {
    const events = [
      claim(),
      claim({ ts: "2026-06-03T10:00:00Z", value: "Meta" }),
      claim({ ts: "2026-06-02T10:00:00Z", value: "Anthropic", agent: "other-agent" }),
    ];
    const forward = computeTruthState(events);
    const reversed = computeTruthState(events.toReversed());
    expect(reversed).toEqual(forward);
  });

  test("re-asserting the identical value refreshes the current version, not history", () => {
    const state = computeTruthState([
      claim(),
      claim({ ts: "2026-06-05T10:00:00Z", value: "Google", source: "[[Brain/notes/again.md]]" }),
    ]);
    const slot = state.slots[0]!;
    expect(slot.current.value).toBe("Google");
    expect(slot.current.ts).toBe("2026-06-05T10:00:00Z");
    expect(slot.history).toHaveLength(0);
    expect(slot.current.assertCount).toBe(2);
  });

  test("value identity is normalized (case and whitespace insensitive)", () => {
    const state = computeTruthState([
      claim(),
      claim({ ts: "2026-06-05T10:00:00Z", value: "  google " }),
    ]);
    expect(state.slots[0]!.history).toHaveLength(0);
  });

  test("history is bounded to the cap, newest first", () => {
    const events: ClaimEvent[] = [];
    for (let i = 0; i < SLOT_HISTORY_CAP + 5; i++) {
      events.push(
        claim({
          ts: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:0${i % 6}:00Z`,
          value: `employer-${i}`,
        }),
      );
    }
    const slot = computeTruthState(events).slots[0]!;
    expect(slot.history.length).toBeLessThanOrEqual(SLOT_HISTORY_CAP);
  });

  test("slots sort deterministically by entity then aspect", () => {
    const state = computeTruthState([
      claim({ entity: "zoe", aspect: "role" }),
      claim({ entity: "alice mason", aspect: "location", value: "Berlin" }),
      claim({ entity: "alice mason", aspect: "employer" }),
    ]);
    expect(state.slots.map((s) => `${s.entity}/${s.aspect}`)).toEqual([
      "alice mason/employer",
      "alice mason/location",
      "zoe/role",
    ]);
  });

  test("quantity versions carry the quantity payload through the fold", () => {
    const state = computeTruthState([
      claim({
        aspect: "spent total",
        value: "120",
        valueKind: "quantity",
        quantity: { value: 120, unit: "usd", action: "spent" },
      }),
    ]);
    expect(state.slots[0]!.current.quantity).toEqual({ value: 120, unit: "usd", action: "spent" });
  });

  test("updatedAt is the max event ts", () => {
    const state = computeTruthState([claim({ ts: "2026-06-03T10:00:00Z" }), claim()]);
    expect(state.updatedAt).toBe("2026-06-03T10:00:00Z");
  });
});
