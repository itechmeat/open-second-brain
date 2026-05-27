/**
 * Task 2: `buildTimelineIndex(vault, opts)`.
 *
 * The index builder scans Brain/log/<date>.jsonl (via the public
 * `readLogDay` reader) for every date file in the requested window,
 * normalizes every log entry to a `TemporalEvent`, and returns a
 * frozen `TimelineIndex` grouped by kind / prefId / topic.
 *
 * Assertions:
 *   - empty vault returns a frozen empty envelope.
 *   - all events come back in chronological order, with deterministic
 *     ties broken by source-path + line.
 *   - window inputs accept ISO date and full ISO timestamp; `since`
 *     is inclusive, `until` is exclusive.
 *   - `prefId` / `topic` / `result` / `artifact` slots come out
 *     populated where the source body carries them.
 *   - kind groups, prefId groups, topic groups stay in chronological
 *     order within each bucket.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-idx-"));
  mkdirSync(join(dir, "Brain"), { recursive: true });
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
});

describe("buildTimelineIndex", () => {
  test("empty vault returns frozen empty envelope", () => {
    const idx = buildTimelineIndex(VAULT, {
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-25T00:00:00Z",
    });
    expect(idx.events.length).toBe(0);
    expect(idx.eventsByKind.size).toBe(0);
    expect(idx.eventsByPrefId.size).toBe(0);
    expect(idx.eventsByTopic.size).toBe(0);
    expect(idx.window.since).toBe("2026-05-01T00:00:00Z");
    expect(idx.window.until).toBe("2026-05-25T00:00:00Z");
    expect(Object.isFrozen(idx)).toBe(true);
  });

  test("apply-evidence row populates prefId, topic-less, result, artifact", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|Principle title]]",
          artifact: "[[src/cli/main.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    expect(idx.events.length).toBe(1);
    const ev = idx.events[0]!;
    expect(ev.kind).toBe("apply-evidence");
    expect(ev.at).toBe("2026-05-20T10:00:00Z");
    expect(ev.prefId).toBe("pref-foo");
    expect(ev.result).toBe("applied");
    expect(ev.artifact).toContain("src/cli/main.ts");
    expect(idx.eventsByKind.get("apply-evidence")?.length).toBe(1);
    expect(idx.eventsByPrefId.get("pref-foo")?.length).toBe(1);
  });

  test("feedback row populates topic + signal prefId", () => {
    writeJsonlDay(VAULT, "2026-05-21", [
      {
        timestamp: "2026-05-21T09:30:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-21-bar]]",
          topic: "bar",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    expect(idx.events.length).toBe(1);
    const ev = idx.events[0]!;
    expect(ev.kind).toBe("feedback");
    expect(ev.topic).toBe("bar");
    // signal wikilink is the feedback event's lifecycle anchor.
    expect(ev.prefId).toBe("sig-2026-05-21-bar");
    expect(idx.eventsByTopic.get("bar")?.length).toBe(1);
  });

  test("note row populates text and no prefId", () => {
    writeJsonlDay(VAULT, "2026-05-22", [
      {
        timestamp: "2026-05-22T12:00:00Z",
        kind: "note",
        body: {
          text: "Release v0.10.18 shipped",
          agent: "claude",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    expect(idx.events.length).toBe(1);
    const ev = idx.events[0]!;
    expect(ev.kind).toBe("note");
    expect(ev.text).toBe("Release v0.10.18 shipped");
    expect(ev.prefId).toBeUndefined();
  });

  test("signal-suppressed row populates topic + prefId from signal wikilink + reason", () => {
    writeJsonlDay(VAULT, "2026-05-23", [
      {
        timestamp: "2026-05-23T08:00:00Z",
        kind: "signal-suppressed",
        body: {
          signal: "[[sig-2026-05-23-foo]]",
          retired: "[[ret-foo]]",
          topic: "foo",
          reason: "rejected by operator",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const ev = idx.events[0]!;
    expect(ev.kind).toBe("signal-suppressed");
    expect(ev.topic).toBe("foo");
    expect(ev.reason).toBe("rejected by operator");
    // signal-suppressed gets its prefId from the retired wikilink (ret-*).
    expect(ev.prefId).toBe("ret-foo");
  });

  test("multiple days combine with chronological ordering across files", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T15:00:00Z",
        kind: "note",
        body: { text: "afternoon-20", agent: "claude" },
      },
    ]);
    writeJsonlDay(VAULT, "2026-05-21", [
      {
        timestamp: "2026-05-21T08:00:00Z",
        kind: "note",
        body: { text: "morning-21", agent: "claude" },
      },
    ]);
    writeJsonlDay(VAULT, "2026-05-19", [
      {
        timestamp: "2026-05-19T12:00:00Z",
        kind: "note",
        body: { text: "noon-19", agent: "claude" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    expect(idx.events.map((e) => e.text)).toEqual(["noon-19", "afternoon-20", "morning-21"]);
  });

  test("window since/until: inclusive lower, exclusive upper", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T00:00:00Z",
        kind: "note",
        body: { text: "lower-boundary", agent: "claude" },
      },
      {
        timestamp: "2026-05-20T12:00:00Z",
        kind: "note",
        body: { text: "inside", agent: "claude" },
      },
      {
        timestamp: "2026-05-21T00:00:00Z",
        kind: "note",
        body: { text: "upper-boundary", agent: "claude" },
      },
    ]);
    writeJsonlDay(VAULT, "2026-05-21", [
      {
        timestamp: "2026-05-21T00:00:00Z",
        kind: "note",
        body: { text: "upper-boundary", agent: "claude" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {
      since: "2026-05-20T00:00:00Z",
      until: "2026-05-21T00:00:00Z",
    });
    // lower-boundary included, upper-boundary excluded.
    expect(idx.events.map((e) => e.text)).toEqual(["lower-boundary", "inside"]);
  });

  test("window since/until accept bare ISO date (interpreted as T00:00:00Z)", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T11:00:00Z",
        kind: "note",
        body: { text: "inside-day", agent: "claude" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {
      since: "2026-05-20",
      until: "2026-05-21",
    });
    expect(idx.events.length).toBe(1);
    expect(idx.events[0]!.text).toBe("inside-day");
  });

  test("groups by prefId and topic are in chronological order", () => {
    writeJsonlDay(VAULT, "2026-05-25", [
      {
        timestamp: "2026-05-25T08:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|first]]",
          artifact: "[[a]]",
          agent: "c",
          result: "applied",
        },
      },
      {
        timestamp: "2026-05-25T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|second]]",
          artifact: "[[b]]",
          agent: "c",
          result: "violated",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const fooEvents = idx.eventsByPrefId.get("pref-foo");
    expect(fooEvents?.length).toBe(2);
    expect(fooEvents?.[0]!.at).toBe("2026-05-25T08:00:00Z");
    expect(fooEvents?.[1]!.at).toBe("2026-05-25T10:00:00Z");
  });

  test("retired/ frontmatter contributes ret-* events at retired_at", () => {
    writeFileSync(
      join(VAULT, "Brain", "retired", "ret-baz.md"),
      `---\nid: ret-baz\nprinciple: Do not bar\ntopic: baz\nretired_at: 2026-05-15T09:00:00Z\nreason: superseded\nstatus: retired\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const baz = idx.eventsByPrefId.get("ret-baz");
    expect(baz?.length).toBe(1);
    const ev = baz![0]!;
    expect(ev.kind).toBe("retire");
    expect(ev.topic).toBe("baz");
    expect(ev.reason).toBe("superseded");
    expect(ev.at).toBe("2026-05-15T09:00:00Z");
  });
});
