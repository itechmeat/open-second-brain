/**
 * ATOF/ATIF trajectory export (Memory Observability Suite, t_51959aeb).
 *
 * Golden-shape tests over the continuity read-model: ATOF JSONL events
 * (scope pairs for duration-bearing recalls, marks for the rest) and
 * one ATIF trajectory per session. Mapping decisions live in
 * docs/brainstorm/memory-observability-suite/atof-atif-mapping.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
} from "../../../src/core/brain/continuity/store.ts";
import { loadNormalizedContinuityRecords } from "../../../src/core/brain/continuity/read-model.ts";
import { ATOF_VERSION, renderAtofEvents } from "../../../src/core/brain/continuity/export-atof.ts";
import {
  ATIF_SCHEMA_VERSION,
  renderAtifTrajectories,
} from "../../../src/core/brain/continuity/export-atif.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-continuity-export-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedRecords(): void {
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: "2026-06-03T10:00:00.000Z",
    payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "find the index notes" },
  });
  appendContinuityRecord(vault, {
    kind: "gate_telemetry",
    createdAt: "2026-06-03T10:00:01.000Z",
    payload: {
      host: "mcp",
      session_id: "s-1",
      decision: "retrieve",
      reason: "question_shape",
      prompt_hash: "abcdef0123456789",
      prompt_chars: 20,
    },
  });
  appendContinuityRecord(vault, {
    kind: "recall_telemetry",
    createdAt: "2026-06-03T10:00:02.500Z",
    payload: {
      host: "mcp",
      session_id: "s-1",
      mode: "search",
      status: "ok",
      duration_ms: 1500,
      result_count: 2,
      top_artifacts: [],
      gaps: [],
    },
  });
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: "2026-06-03T10:00:03.000Z",
    payload: { session_id: "s-1", turn_id: "t-2", role: "assistant", text: "found two notes" },
  });
}

describe("renderAtofEvents", () => {
  test("recall telemetry becomes a retriever scope pair with one shared uuid", () => {
    seedRecords();
    const records = loadNormalizedContinuityRecords(vault);
    const lines = renderAtofEvents(records);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    // Every event carries the required ATOF fields.
    for (const event of events) {
      expect(event["atof_version"]).toBe(ATOF_VERSION);
      expect(typeof event["uuid"]).toBe("string");
      expect(typeof event["timestamp"]).toBe("string");
      expect(typeof event["name"]).toBe("string");
      const kind = event["kind"];
      expect(kind === "scope" || kind === "mark").toBe(true);
    }

    const scopes = events.filter((event) => event["kind"] === "scope");
    expect(scopes).toHaveLength(2);
    expect(scopes[0]!["scope_category"]).toBe("start");
    expect(scopes[1]!["scope_category"]).toBe("end");
    expect(scopes[0]!["uuid"]).toBe(scopes[1]!["uuid"]);
    expect(scopes[0]!["category"]).toBe("retriever");
    // The synthesized start sits duration_ms before the recorded end.
    expect(scopes[0]!["timestamp"]).toBe("2026-06-03T10:00:01.000Z");
    expect(scopes[1]!["timestamp"]).toBe("2026-06-03T10:00:02.500Z");
    const attrs = scopes[0]!["attributes"];
    expect(Array.isArray(attrs)).toBe(true);
    expect(attrs as string[]).toContain("o2b.synthetic_start");

    // Marks: gate decision is a guardrail, turns are custom with subtype.
    const gate = events.find((event) => (event["name"] as string).includes("gate"));
    expect(gate!["kind"]).toBe("mark");
    expect(gate!["category"]).toBe("guardrail");
    const turn = events.find((event) => (event["name"] as string).includes("session_turn"));
    expect(turn!["category"]).toBe("custom");
    expect((turn!["category_profile"] as Record<string, unknown>)["subtype"]).toBe(
      "o2b.session_turn",
    );
  });

  test("the export is deterministic: same records, same lines", () => {
    seedRecords();
    const records = loadNormalizedContinuityRecords(vault);
    expect(renderAtofEvents(records)).toEqual(renderAtofEvents(records));
  });
});

describe("renderAtifTrajectories", () => {
  test("one trajectory per session with renumbered steps and llm_call_count 0 system steps", () => {
    seedRecords();
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-03T11:00:00.000Z",
      payload: { session_id: "s-2", turn_id: "t-1", role: "user", text: "other session" },
    });
    const records = loadNormalizedContinuityRecords(vault);
    const trajectories = renderAtifTrajectories(records, { agentVersion: "0.39.0" });
    expect(trajectories).toHaveLength(2);

    const first = trajectories.find((t) => t.session_id === "s-1")!;
    expect(first.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(first.agent).toEqual({ name: "open-second-brain", version: "0.39.0" });
    const steps = first.steps;
    expect(steps.map((s) => s.step_id)).toEqual([1, 2, 3, 4]);
    expect(steps[0]!.source).toBe("user");
    expect(steps[0]!.message).toBe("find the index notes");
    // Memory-layer events are deterministic system steps.
    const gateStep = steps.find((s) => s.source === "system")!;
    expect(gateStep.llm_call_count).toBe(0);
    expect((gateStep.extra as Record<string, unknown>)["o2b"]).toBeDefined();
    // Assistant turns map to agent steps.
    expect(steps[3]!.source).toBe("agent");
  });

  test("records without a session id are skipped and counted", () => {
    appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-06-03T10:00:00.000Z",
      source: { id: "note-x" },
      reason: "drift",
    });
    const records = loadNormalizedContinuityRecords(vault);
    const trajectories = renderAtifTrajectories(records, { agentVersion: "0.39.0" });
    expect(trajectories).toHaveLength(0);
  });
});
