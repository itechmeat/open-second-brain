import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  attachTracesToEvent,
  extractEventCorrelation,
  resolveLogEventTraces,
} from "../../../src/core/brain/event-trace.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-event-trace-"));
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const DATE = "2026-06-15";

function logSessionEvent(session: string, at: string): void {
  appendLogEvent(vault, {
    timestamp: `${DATE}T${at}Z`,
    eventType: BRAIN_LOG_EVENT_KIND.writeSession,
    agent: "tester",
    body: { session_id: session, kind: "note", status: "committed", target: "Brain/x.md" },
  });
}

function recallTelemetry(session: string, at: string): string {
  return appendContinuityRecord(vault, {
    kind: "recall_telemetry",
    createdAt: `${DATE}T${at}Z`,
    sourceRefs: [],
    payload: { session_id: session, mode: "context_pack", status: "ok" },
  }).id;
}

describe("extractEventCorrelation", () => {
  test("lifts session_id, turn_id, and artifact wikilinks/paths", () => {
    const corr = extractEventCorrelation({
      timestamp: `${DATE}T10:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        session_id: "sess-1",
        turn_id: "turn-9",
        preference: "[[pref-keep-short]]",
        artifact: "Brain/notes/foo.md",
      },
    });
    expect(corr.sessionId).toBe("sess-1");
    expect(corr.turnId).toBe("turn-9");
    // wikilink target + bare path + their basenames are all join candidates
    expect(corr.artifacts).toContain("pref-keep-short");
    expect(corr.artifacts).toContain("Brain/notes/foo.md");
    expect(corr.artifacts).toContain("foo");
  });

  test("returns no artifacts and no ids for a bare note event", () => {
    const corr = extractEventCorrelation({
      timestamp: `${DATE}T10:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.note,
      body: { text: "shipped v1", agent: "tester" },
    });
    expect(corr.sessionId).toBeUndefined();
    expect(corr.artifacts).toEqual([]);
  });
});

describe("attachTracesToEvent", () => {
  test("joins by session and reports the reason", () => {
    const records = [
      {
        schema: "o2b.continuity.v1",
        legacy: false,
        id: "ctn_a",
        kind: "recall_telemetry",
        createdAt: `${DATE}T10:00:00Z`,
        sourceRefs: [],
        payload: {},
        private: false,
        redacted: false,
        sessionId: "sess-1",
      },
      {
        schema: "o2b.continuity.v1",
        legacy: false,
        id: "ctn_b",
        kind: "recall_telemetry",
        createdAt: `${DATE}T10:01:00Z`,
        sourceRefs: [],
        payload: {},
        private: false,
        redacted: false,
        sessionId: "other",
      },
    ] as const;
    const attached = attachTracesToEvent(records, { sessionId: "sess-1", artifacts: [] });
    expect(attached.map((t) => t.id)).toEqual(["ctn_a"]);
    expect(attached[0]!.joinedBy).toEqual(["session"]);
  });

  test("joins by artifact via sourceRefs id and path", () => {
    const records = [
      {
        schema: "o2b.continuity.v1",
        legacy: false,
        id: "ctn_c",
        kind: "context_receipt",
        createdAt: `${DATE}T10:00:00Z`,
        sourceRefs: [{ id: "pref-keep-short", path: "Brain/preferences/pref-keep-short.md" }],
        payload: {},
        private: false,
        redacted: false,
      },
    ] as const;
    const attached = attachTracesToEvent(records, { artifacts: ["pref-keep-short"] });
    expect(attached).toHaveLength(1);
    expect(attached[0]!.joinedBy).toEqual(["artifact"]);
  });
});

describe("resolveLogEventTraces", () => {
  test("attaches session-correlated continuity records to a logged event", () => {
    logSessionEvent("sess-1", "10:00:00");
    const want = recallTelemetry("sess-1", "10:00:05");
    recallTelemetry("sess-other", "10:00:06");

    const result = resolveLogEventTraces(vault, { date: DATE });
    expect(result).toHaveLength(1);
    expect(result[0]!.event.sessionId).toBe("sess-1");
    expect(result[0]!.traceCount).toBe(1);
    expect(result[0]!.traces[0]!.id).toBe(want);
    expect(result[0]!.traces[0]!.joinedBy).toEqual(["session"]);
  });

  test("limit caps the number of events; limit 0 yields an empty list", () => {
    logSessionEvent("sess-1", "10:00:00");
    logSessionEvent("sess-2", "11:00:00");
    logSessionEvent("sess-3", "12:00:00");

    // The cap is the count returned, evaluated before each push: limit 0 is
    // an empty list (not one event), limit 2 returns exactly two.
    expect(resolveLogEventTraces(vault, { date: DATE, limit: 0 })).toEqual([]);
    expect(resolveLogEventTraces(vault, { date: DATE, limit: 2 })).toHaveLength(2);
    expect(resolveLogEventTraces(vault, { date: DATE })).toHaveLength(3);
  });

  test("--at pins a single event by HH:MM:SS", () => {
    logSessionEvent("sess-1", "10:00:00");
    logSessionEvent("sess-2", "11:00:00");
    recallTelemetry("sess-2", "11:00:01");

    const result = resolveLogEventTraces(vault, { date: DATE, at: "11:00:00" });
    expect(result).toHaveLength(1);
    expect(result[0]!.event.sessionId).toBe("sess-2");
    expect(result[0]!.traceCount).toBe(1);
  });

  test("--session-id filters events; --kind filters by event kind", () => {
    logSessionEvent("sess-1", "10:00:00");
    logSessionEvent("sess-2", "11:00:00");

    const bySession = resolveLogEventTraces(vault, { date: DATE, sessionId: "sess-2" });
    expect(bySession.map((r) => r.event.sessionId)).toEqual(["sess-2"]);

    const byKind = resolveLogEventTraces(vault, {
      date: DATE,
      kind: BRAIN_LOG_EVENT_KIND.note,
    });
    expect(byKind).toEqual([]);
  });

  test("events with no attached context still surface with an empty trace list", () => {
    appendLogEvent(vault, {
      timestamp: `${DATE}T10:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.note,
      body: { text: "no correlation here", agent: "tester" },
    });
    const result = resolveLogEventTraces(vault, { date: DATE });
    expect(result).toHaveLength(1);
    expect(result[0]!.traceCount).toBe(0);
    expect(result[0]!.traces).toEqual([]);
  });

  test("private continuity records are dropped unless keepPrivate is set", () => {
    logSessionEvent("sess-1", "10:00:00");
    appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: `${DATE}T10:00:05Z`,
      sourceRefs: [],
      payload: { session_id: "sess-1", note: "<private>secret</private>" },
    });

    const dropped = resolveLogEventTraces(vault, { date: DATE });
    expect(dropped[0]!.traceCount).toBe(0);

    const kept = resolveLogEventTraces(vault, { date: DATE, keepPrivate: true });
    expect(kept[0]!.traceCount).toBe(1);
    expect(kept[0]!.traces[0]!.private).toBe(true);
  });

  test("rejects a malformed --at", () => {
    expect(() => resolveLogEventTraces(vault, { date: DATE, at: "10am" })).toThrow(/HH:MM:SS/);
  });
});
