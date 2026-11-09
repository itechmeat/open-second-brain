/**
 * `signalDeliveryRel` and `memoryPageRelIn` name the same page on an
 * unswitched and on a store-only machine: the folder that holds a signal
 * in its current state, the preferences or retired folder of a rule, and
 * the fallback for an id no folder holds.
 */
import { describe, expect, test } from "bun:test";

import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../../src/core/brain/path-constants.ts";
import { memoryPageRelIn, signalDeliveryRel } from "../../src/mcp/brain/reach-events.ts";
import { FIXTURE, mintedId, withMemoryFixture } from "../core/brain/fixtures/memory-twins.ts";

const RULE_DIRS = [BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL];

function answers(mode: "legacy" | "switched") {
  return withMemoryFixture(mode, (env) => ({
    // A switched machine mints its ids with its device tag (`mintedId`).
    active: signalDeliveryRel(env.vault, mintedId(env.vault, FIXTURE.activeSignals[0]!)),
    consumed: signalDeliveryRel(env.vault, mintedId(env.vault, FIXTURE.consumedSignal)),
    unknown: signalDeliveryRel(env.vault, "sig-2026-01-01-none"),
    confirmed: memoryPageRelIn(env.vault, FIXTURE.confirmed, RULE_DIRS),
    missing: memoryPageRelIn(env.vault, "pref-none", RULE_DIRS),
  }));
}

describe("memory page rels", () => {
  test("agree on both sides of the switch", () => {
    const legacy = answers("legacy");
    expect(answers("switched")).toEqual(legacy);
    expect(legacy.active).toBe(`Brain/inbox/${FIXTURE.activeSignals[0]}.md`);
    expect(legacy.consumed).not.toBe(`Brain/inbox/${FIXTURE.consumedSignal}.md`);
    expect(legacy.unknown).toBe("Brain/inbox/sig-2026-01-01-none.md");
    expect(legacy.confirmed).toBe(`${BRAIN_PREFERENCES_REL}/${FIXTURE.confirmed}.md`);
    expect(legacy.missing).toBeNull();
  });
});
