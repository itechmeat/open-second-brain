/**
 * Task 3: `selectEvents(index, filters)` pure projection.
 *
 * Asserts that every supported filter (`prefId`, `topic`, `kind`,
 * `since`, `until`) narrows the index's events by the AND of all
 * predicates and that the result is frozen.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { selectEvents } from "../../../../src/core/brain/temporal/select-events.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-select-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(dir, "Brain", "retired"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonlDay(vault: string, date: string, events: ReadonlyArray<FixtureEvent>): void {
  const lines = events
    .map((e) => JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }))
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
  writeJsonlDay(VAULT, "2026-05-20", [
    {
      timestamp: "2026-05-20T08:00:00Z",
      kind: "feedback",
      body: {
        signal: "[[sig-2026-05-20-foo]]",
        topic: "foo",
        sign: "positive",
        agent: "claude",
      },
    },
    {
      timestamp: "2026-05-20T10:00:00Z",
      kind: "apply-evidence",
      body: {
        preference: "[[pref-foo|Principle]]",
        artifact: "[[src/cli/main.ts]]",
        agent: "claude",
        result: "applied",
      },
    },
    {
      timestamp: "2026-05-20T12:00:00Z",
      kind: "apply-evidence",
      body: {
        preference: "[[pref-bar|Other]]",
        artifact: "[[src/cli/other.ts]]",
        agent: "claude",
        result: "violated",
      },
    },
  ]);
  writeJsonlDay(VAULT, "2026-05-21", [
    {
      timestamp: "2026-05-21T09:00:00Z",
      kind: "note",
      body: {
        text: "Release shipped",
        agent: "claude",
      },
    },
    {
      timestamp: "2026-05-21T11:00:00Z",
      kind: "apply-evidence",
      body: {
        preference: "[[pref-foo|Principle]]",
        artifact: "[[src/cli/again.ts]]",
        agent: "claude",
        result: "applied",
      },
    },
  ]);
});

describe("selectEvents", () => {
  test("no filter returns full event list frozen", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, {});
    expect(got.length).toBe(5);
    expect(Object.isFrozen(got)).toBe(true);
  });

  test("filter by prefId returns only events for that preference", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { prefId: "pref-foo" });
    expect(got.length).toBe(2);
    expect(got.every((e) => e.prefId === "pref-foo")).toBe(true);
  });

  test("filter by topic returns only events for that topic", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { topic: "foo" });
    expect(got.length).toBe(1);
    expect(got[0]!.kind).toBe("feedback");
  });

  test("filter by kind returns only events of that kind", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { kind: "apply-evidence" });
    expect(got.length).toBe(3);
    expect(got.every((e) => e.kind === "apply-evidence")).toBe(true);
  });

  test("filter by since narrows lower bound (inclusive)", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { since: "2026-05-21T00:00:00Z" });
    expect(got.length).toBe(2);
    expect(got[0]!.at).toBe("2026-05-21T09:00:00Z");
  });

  test("filter by until narrows upper bound (exclusive)", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { until: "2026-05-21T00:00:00Z" });
    expect(got.length).toBe(3);
    expect(got.every((e) => e.at < "2026-05-21T00:00:00Z")).toBe(true);
  });

  test("multiple filters combine with AND", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, {
      prefId: "pref-foo",
      kind: "apply-evidence",
      since: "2026-05-21T00:00:00Z",
    });
    expect(got.length).toBe(1);
    expect(got[0]!.at).toBe("2026-05-21T11:00:00Z");
  });

  test("filter with no matches returns empty frozen list", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { prefId: "pref-nonexistent" });
    expect(got.length).toBe(0);
    expect(Object.isFrozen(got)).toBe(true);
  });
});

describe("selectEvents bi-temporal frontmatter atoms", () => {
  test("retired event with valid_from/valid_until/recorded_at surfaces those slots", () => {
    writeFileSync(
      join(VAULT, "Brain", "retired", "ret-temporal.md"),
      `---\nid: ret-temporal\nprinciple: keep-fresh\ntopic: temporal\nretired_at: 2026-05-18T09:00:00Z\nreason: superseded\nstatus: retired\nvalid_from: 2026-01-01T00:00:00Z\nvalid_until: 2026-05-18T09:00:00Z\nrecorded_at: 2026-05-18T09:30:00Z\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { prefId: "ret-temporal" });
    expect(got.length).toBe(1);
    expect(got[0]!.validFrom).toBe("2026-01-01T00:00:00Z");
    expect(got[0]!.validUntil).toBe("2026-05-18T09:00:00Z");
    expect(got[0]!.recordedAt).toBe("2026-05-18T09:30:00Z");
  });

  test("retired event without the new slots leaves them undefined", () => {
    writeFileSync(
      join(VAULT, "Brain", "retired", "ret-legacy.md"),
      `---\nid: ret-legacy\nprinciple: old-rule\ntopic: legacy\nretired_at: 2026-05-19T09:00:00Z\nreason: stale-no-evidence\nstatus: retired\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const got = selectEvents(idx, { prefId: "ret-legacy" });
    expect(got.length).toBe(1);
    expect(got[0]!.validFrom).toBeUndefined();
    expect(got[0]!.validUntil).toBeUndefined();
    expect(got[0]!.recordedAt).toBeUndefined();
  });
});
