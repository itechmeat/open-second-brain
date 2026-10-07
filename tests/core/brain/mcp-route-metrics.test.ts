import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitMcpRouteLatency,
  listMcpRouteLatency,
  summarizeMcpRouteLatency,
} from "../../../src/core/brain/mcp-route-metrics.ts";
import type { RouteStageTiming } from "../../../src/core/route-scope.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-route-metrics-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("emitMcpRouteLatency gating", () => {
  test("gate off writes nothing and returns null", () => {
    expect(
      emitMcpRouteLatency(vault, { tool: "brain_search", status: "ok", durationMs: 5 }, false),
    ).toBeNull();
    expect(
      emitMcpRouteLatency(vault, { tool: "brain_search", status: "ok", durationMs: 5 }, undefined),
    ).toBeNull();
    expect(listMcpRouteLatency(vault)).toHaveLength(0);
  });

  test("gate on writes one record", () => {
    const record = emitMcpRouteLatency(
      vault,
      {
        createdAt: "2026-06-01T00:00:00.000Z",
        tool: "brain_search",
        scope: "full",
        status: "ok",
        durationMs: 12.6,
        argKeys: ["query"],
      },
      true,
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("mcp_route_latency");
    expect(record!.payload).toMatchObject({
      tool: "brain_search",
      scope: "full",
      status: "ok",
      duration_ms: 13, // rounded
      arg_keys: ["query"],
    });
  });

  test("fail-open: a bad tool value never throws", () => {
    expect(
      emitMcpRouteLatency(vault, { tool: "" as string, status: "ok", durationMs: 1 }, true),
    ).toBeNull();
    expect(listMcpRouteLatency(vault)).toHaveLength(0);
  });
});

describe("mcp route latency payload safety", () => {
  test("only key names are stored, never argument values", () => {
    emitMcpRouteLatency(
      vault,
      {
        createdAt: "2026-06-01T00:00:00.000Z",
        tool: "brain_feedback",
        status: "ok",
        durationMs: 3,
        // Arg keys are schema property names; values are deliberately absent.
        argKeys: ["principle", "topic", "signal"],
      },
      true,
    );
    const dir = join(vault, "Brain", "log", "continuity");
    const raw = readFileSync(join(dir, "2026-06.jsonl"), "utf8");
    expect(raw).toContain("principle");
    expect(raw).toContain("brain_feedback");
    // The record carries key names only — no free-text value smuggled in.
    const record = JSON.parse(raw.trim());
    expect(record.payload.arg_keys).toEqual(["principle", "signal", "topic"]); // sorted+unique
    expect(record.sourceRefs).toEqual([]);
  });

  test("arg keys are de-duplicated and sorted", () => {
    const record = emitMcpRouteLatency(
      vault,
      {
        tool: "x",
        status: "ok",
        durationMs: 1,
        argKeys: ["b", "a", "b", "a"],
      },
      true,
    );
    expect(record!.payload["arg_keys"]).toEqual(["a", "b"]);
  });
});

describe("listMcpRouteLatency", () => {
  test("newest-first, filterable by tool and status, limited", () => {
    emitMcpRouteLatency(
      vault,
      { createdAt: "2026-06-01T00:00:00.000Z", tool: "a", status: "ok", durationMs: 1 },
      true,
    );
    emitMcpRouteLatency(
      vault,
      { createdAt: "2026-06-01T00:00:01.000Z", tool: "b", status: "error", durationMs: 2 },
      true,
    );
    emitMcpRouteLatency(
      vault,
      { createdAt: "2026-06-01T00:00:02.000Z", tool: "a", status: "ok", durationMs: 3 },
      true,
    );

    const all = listMcpRouteLatency(vault);
    expect(all).toHaveLength(3);
    // Newest first.
    expect(all[0]!.payload["duration_ms"]).toBe(3);

    expect(listMcpRouteLatency(vault, { tool: "a" })).toHaveLength(2);
    expect(listMcpRouteLatency(vault, { status: "error" })).toHaveLength(1);
    expect(listMcpRouteLatency(vault, { limit: 1 })).toHaveLength(1);
  });
});

describe("summarizeMcpRouteLatency", () => {
  test("per-tool percentiles, slowest-first, error rollup", () => {
    // Tool "slow": durations 10..100 -> high p95. Tool "fast": all 1.
    for (const d of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      emitMcpRouteLatency(vault, { tool: "slow", status: "ok", durationMs: d }, true);
    }
    emitMcpRouteLatency(vault, { tool: "fast", status: "ok", durationMs: 1 }, true);
    emitMcpRouteLatency(vault, { tool: "fast", status: "error", durationMs: 1 }, true);

    const summary = summarizeMcpRouteLatency(vault);
    expect(summary.total).toBe(12);
    expect(summary.error_count).toBe(1);
    expect(summary.by_status).toEqual({ ok: 11, error: 1 });

    // Slowest surface first.
    expect(summary.routes[0]!.tool).toBe("slow");
    const slow = summary.routes.find((r) => r.tool === "slow")!;
    expect(slow.count).toBe(10);
    expect(slow.min_ms).toBe(10);
    expect(slow.max_ms).toBe(100);
    expect(slow.avg_ms).toBe(55);
    expect(slow.p50_ms).toBe(50); // ceil(0.5*10)=5 -> idx 4 -> 50
    expect(slow.p95_ms).toBe(100); // ceil(0.95*10)=10 -> idx 9 -> 100

    const fast = summary.routes.find((r) => r.tool === "fast")!;
    expect(fast.count).toBe(2);
    expect(fast.error_count).toBe(1);
  });

  test("limit does not shrink the summary window", () => {
    for (const d of [1, 2, 3]) {
      emitMcpRouteLatency(vault, { tool: "t", status: "ok", durationMs: d }, true);
    }
    const summary = summarizeMcpRouteLatency(vault, { limit: 1 });
    expect(summary.total).toBe(3);
    expect(summary.routes[0]!.count).toBe(3);
  });
});

describe("mcp route latency stages", () => {
  const base = {
    createdAt: "2026-06-01T00:00:00.000Z",
    tool: "brain_feedback",
    status: "ok" as const,
    durationMs: 4,
  };

  test("stages are written only when non-empty", () => {
    const withStages = emitMcpRouteLatency(
      vault,
      {
        ...base,
        stages: [
          { name: "validate", ms: 0.4 },
          { name: "log_append", ms: 1.26 },
        ],
      },
      true,
    );
    expect(withStages!.payload["stages"]).toEqual([
      { name: "validate", ms: 0.4 },
      { name: "log_append", ms: 1.3 },
    ]);
    const empty = emitMcpRouteLatency(vault, { ...base, stages: [] }, true);
    expect(Object.hasOwn(empty!.payload, "stages")).toBe(false);
  });

  test("unknown names, negative and non-finite values are dropped", () => {
    const hostile = [
      { name: "validate", ms: -1 },
      { name: "document_write", ms: Number.NaN },
      { name: "lint", ms: Number.POSITIVE_INFINITY },
      { name: "not_a_stage", ms: 2 },
      { name: "write_receipt", ms: 2 },
    ] as unknown as ReadonlyArray<RouteStageTiming>;
    const record = emitMcpRouteLatency(vault, { ...base, stages: hostile }, true);
    expect(record!.payload["stages"]).toEqual([{ name: "write_receipt", ms: 2 }]);

    const allBad = [{ name: "validate", ms: -3 }] as unknown as ReadonlyArray<RouteStageTiming>;
    const none = emitMcpRouteLatency(vault, { ...base, stages: allBad }, true);
    expect(Object.hasOwn(none!.payload, "stages")).toBe(false);
  });

  test("repeated names are summed in first-seen order", () => {
    const record = emitMcpRouteLatency(
      vault,
      {
        ...base,
        stages: [
          { name: "write_receipt", ms: 1 },
          { name: "lint", ms: 0.5 },
          { name: "write_receipt", ms: 0.25 },
        ],
      },
      true,
    );
    expect(record!.payload["stages"]).toEqual([
      { name: "write_receipt", ms: 1.3 },
      { name: "lint", ms: 0.5 },
    ]);
  });

  test("a hostile stage name never reaches the persisted continuity file", () => {
    const PRIVATE_PATH = "Notes/private-topic-marker.md";
    const PRIVATE_TOPIC = "private-topic-slug-marker";
    const hostile = [
      { name: PRIVATE_PATH, ms: 1 },
      { name: PRIVATE_TOPIC, ms: 1 },
      { name: "validate", ms: 1 },
    ] as unknown as ReadonlyArray<RouteStageTiming>;
    emitMcpRouteLatency(vault, { ...base, stages: hostile }, true);
    const raw = readFileSync(join(vault, "Brain", "log", "continuity", "2026-06.jsonl"), "utf8");
    expect(raw).not.toContain(PRIVATE_PATH);
    expect(raw).not.toContain(PRIVATE_TOPIC);
    expect(raw).toContain('"validate"');
  });

  test("records without stages keep the pre-stage payload byte-for-byte", () => {
    const record = emitMcpRouteLatency(
      vault,
      { ...base, scope: "full", argKeys: ["topic"], decisionMs: 2.4 },
      true,
    );
    expect(JSON.stringify(record!.payload)).toBe(
      '{"tool":"brain_feedback","scope":"full","status":"ok","duration_ms":4,"arg_keys":["topic"],"decision_ms":2}',
    );
  });
});

function stagesFor(ms: number): ReadonlyArray<RouteStageTiming> {
  return [
    { name: "validate", ms },
    { name: "log_append", ms: ms * 2 },
  ];
}

describe("summarizeMcpRouteLatency stages", () => {
  test("each route gets a per-stage count, average and p95", () => {
    for (const ms of [1, 2, 3, 4]) {
      emitMcpRouteLatency(
        vault,
        { tool: "brain_feedback", status: "ok", durationMs: 10, stages: stagesFor(ms) },
        true,
      );
    }
    emitMcpRouteLatency(vault, { tool: "brain_feedback", status: "ok", durationMs: 10 }, true);

    const route = summarizeMcpRouteLatency(vault).routes.find((r) => r.tool === "brain_feedback")!;
    expect(route.stages).toEqual([
      { name: "validate", count: 4, avg_ms: 2.5, p95_ms: 4 },
      { name: "log_append", count: 4, avg_ms: 5, p95_ms: 8 },
    ]);
  });

  test("a route without stages has no stages key", () => {
    emitMcpRouteLatency(vault, { tool: "second_brain_status", status: "ok", durationMs: 2 }, true);
    const route = summarizeMcpRouteLatency(vault).routes[0]!;
    expect(Object.hasOwn(route, "stages")).toBe(false);
  });
});
