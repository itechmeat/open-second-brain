import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitMcpRouteLatency,
  listMcpRouteLatency,
  summarizeMcpRouteLatency,
} from "../../../src/core/brain/mcp-route-metrics.ts";

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
