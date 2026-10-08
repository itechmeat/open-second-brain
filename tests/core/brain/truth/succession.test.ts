/**
 * Succession channel (truth-correctable-time-aware, contract item 1):
 * two same-slot claims with present, non-intersecting validity windows
 * classify as succession, never as conflict. Everything else - any
 * windowless claim, intersecting windows - keeps the assertion-time
 * contest rule verbatim. Pure functions only.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyClaimSuccessions,
  isSuccessionPair,
  valuesSuccessionSeparated,
} from "../../../../src/core/brain/truth/succession.ts";
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

describe("isSuccessionPair", () => {
  test("present non-overlapping windows classify as succession", () => {
    const a = claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" });
    const b = claim({
      ts: "2026-06-10T10:00:00Z",
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    expect(isSuccessionPair(a, b)).toBe(true);
    expect(isSuccessionPair(b, a)).toBe(true);
  });

  test("adjacent bare-date windows sharing a boundary day are succession", () => {
    // Half-open [from, until): a bare-date until is the exclusive day
    // start, so back-to-back bare-date windows (`until: 2026-06-01`,
    // `from: 2026-06-01`) are disjoint and classify as succession - the
    // canonical hand-written hand-over shape - never a conflict.
    const a = claim({ validFrom: "2025-06-01", validUntil: "2026-06-01" });
    const b = claim({
      ts: "2026-06-10T10:00:00Z",
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-06-01",
    });
    expect(isSuccessionPair(a, b)).toBe(true);
    expect(isSuccessionPair(b, a)).toBe(true);
  });

  test("any windowless claim keeps the contest rule (never succession)", () => {
    const windowed = claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" });
    expect(isSuccessionPair(claim(), windowed)).toBe(false);
    expect(isSuccessionPair(windowed, claim())).toBe(false);
  });

  test("intersecting windows never classify as succession", () => {
    const a = claim({ validFrom: "2025-01-01", validUntil: "2026-06-01" });
    const b = claim({
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    expect(isSuccessionPair(a, b)).toBe(false);
  });

  test("an expired window still qualifies when the pair is disjoint", () => {
    // Expiry is irrelevant to the axis rule: presence plus
    // non-intersection decides.
    const expired = claim({ validFrom: "2020-01-01", validUntil: "2021-01-01" });
    const current = claim({
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    expect(isSuccessionPair(expired, current)).toBe(true);
  });

  test("re-assertions of one value are never succession", () => {
    const a = claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" });
    const b = claim({ validFrom: "2026-01-01" });
    expect(isSuccessionPair(a, b)).toBe(false);
  });
});

describe("valuesSuccessionSeparated", () => {
  test("two value groups whose every cross-pair is disjoint are separated", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        ts: "2026-06-10T10:00:00Z",
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    expect(valuesSuccessionSeparated(events, "Google", "Meta")).toBe(true);
    // Value comparison is the fold's normalized identity.
    expect(valuesSuccessionSeparated(events, "google", "META")).toBe(true);
  });

  test("one windowless event in a group keeps the values contestable", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      // A re-assertion of Google without a window poisons the group.
      claim({ ts: "2026-06-02T10:00:00Z" }),
      claim({
        ts: "2026-06-10T10:00:00Z",
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    expect(valuesSuccessionSeparated(events, "Google", "Meta")).toBe(false);
  });

  test("an intersecting cross-pair keeps the values contestable", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2026-06-01" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    expect(valuesSuccessionSeparated(events, "Google", "Meta")).toBe(false);
  });
});

describe("classifyClaimSuccessions", () => {
  test("one disjoint windowed pair yields one succession, ordered by window end", () => {
    const predecessor = claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" });
    const successor = claim({
      ts: "2026-06-10T10:00:00Z",
      value: "Meta",
      agent: "codex-agent",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    const successions = classifyClaimSuccessions([successor, predecessor]);
    expect(successions).toHaveLength(1);
    const s = successions[0]!;
    expect(s.entity).toBe("alice mason");
    expect(s.aspect).toBe("employer");
    expect(s.predecessor.value).toBe("Google");
    expect(s.successor.value).toBe("Meta");
    expect(s.detectedAt).toBe("2026-06-10T10:00:00Z");
  });

  test("successor ordering follows window end, not assertion order", () => {
    // The later-asserted claim holds the EARLIER window: it is the
    // predecessor (a backdated correction), the other the successor.
    const backdated = claim({
      ts: "2026-06-10T10:00:00Z",
      value: "Google",
      validFrom: "2025-01-01",
      validUntil: "2025-12-31",
    });
    const live = claim({
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    const successions = classifyClaimSuccessions([backdated, live]);
    expect(successions).toHaveLength(1);
    expect(successions[0]!.predecessor.value).toBe("Google");
    expect(successions[0]!.successor.value).toBe("Meta");
  });

  test("windowless and intersecting pairs yield nothing", () => {
    expect(
      classifyClaimSuccessions([
        claim(),
        claim({
          value: "Meta",
          source: "[[Brain/notes/later.md]]",
        }),
      ]),
    ).toHaveLength(0);
    expect(
      classifyClaimSuccessions([
        claim({ validFrom: "2025-01-01", validUntil: "2026-06-01" }),
        claim({ value: "Meta", source: "[[Brain/notes/later.md]]", validFrom: "2026-01-01" }),
      ]),
    ).toHaveLength(0);
  });

  test("successions group per slot and sort by entity then aspect", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
      claim({
        entity: "bob hale",
        aspect: "role",
        value: "dev",
        source: "[[Brain/notes/bob.md]]",
        validFrom: "2024-01-01",
        validUntil: "2024-12-31",
      }),
      claim({
        entity: "bob hale",
        aspect: "role",
        ts: "2026-07-01T10:00:00Z",
        value: "ops",
        source: "[[Brain/notes/bob2.md]]",
        validFrom: "2025-01-01",
      }),
    ];
    const successions = classifyClaimSuccessions(events);
    expect(successions).toHaveLength(2);
    expect(successions.map((s) => `${s.entity}/${s.aspect}`)).toEqual([
      "alice mason/employer",
      "bob hale/role",
    ]);
  });

  test("other-entity events never leak into a slot's classification", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        entity: "bob hale",
        value: "Meta",
        source: "[[Brain/notes/bob.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    expect(classifyClaimSuccessions(events)).toHaveLength(0);
  });

  test("classification is deterministic and empty-safe", () => {
    const events = [
      claim({ validFrom: "2025-01-01", validUntil: "2025-12-31" }),
      claim({
        value: "Meta",
        source: "[[Brain/notes/later.md]]",
        validFrom: "2026-01-01",
      }),
    ];
    expect(classifyClaimSuccessions(events)).toEqual(
      classifyClaimSuccessions([...events].toReversed()),
    );
    expect(classifyClaimSuccessions([])).toHaveLength(0);
  });
});
