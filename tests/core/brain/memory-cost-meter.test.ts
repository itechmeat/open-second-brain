import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { recordHostMemoryWrite } from "../../../src/core/brain/host-memory-write.ts";
import { emitRecallTelemetry } from "../../../src/core/brain/recall-telemetry.ts";
import {
  computeMemoryCostMeter,
  summarizeMemoryWrites,
} from "../../../src/core/brain/memory-cost-meter.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-memory-cost-meter-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeEvent(kind: string, timestamp: string): void {
  appendLogEvent(
    vault,
    {
      timestamp,
      eventType: kind as never,
      agent: "claude",
      body: { agent: "claude" },
    },
    { deviceId: "" },
  );
}

function read(createdAt: string, mode: "search" | "context_pack" | "query"): void {
  emitRecallTelemetry(vault, {
    createdAt,
    host: "unit-test",
    mode,
    status: "ok",
    durationMs: 1,
    resultCount: 1,
  });
}

describe("summarizeMemoryWrites", () => {
  test("counts brain-log write verbs and host-bridge writes; ignores lifecycle events", () => {
    writeEvent("feedback", "2026-07-01T10:00:00Z");
    writeEvent("apply-evidence", "2026-07-01T10:01:00Z");
    writeEvent("note", "2026-07-01T10:02:00Z");
    // Lifecycle transitions are not writes and must be ignored.
    writeEvent("promote", "2026-07-01T10:03:00Z");
    writeEvent("retire", "2026-07-01T10:04:00Z");
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "remember this",
      createdAt: "2026-07-01T10:05:00Z",
    });

    const summary = summarizeMemoryWrites(vault);
    expect(summary.total).toBe(4);
    expect(summary.by_kind).toEqual({
      feedback: 1,
      apply_evidence: 1,
      note: 1,
      host_memory_write: 1,
    });
  });

  test("bounds writes by inclusive since/until across both sources", () => {
    writeEvent("feedback", "2026-06-30T23:59:59Z"); // before window
    writeEvent("note", "2026-07-01T12:00:00Z"); // in window
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "user",
      content: "in window",
      createdAt: "2026-07-02T00:00:00Z",
    });
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "user",
      content: "after window",
      createdAt: "2026-07-03T00:00:01Z",
    });

    const summary = summarizeMemoryWrites(vault, {
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-03T00:00:00Z",
    });
    expect(summary.total).toBe(2);
    expect(summary.by_kind).toEqual({ note: 1, host_memory_write: 1 });
  });
});

describe("computeMemoryCostMeter", () => {
  test("folds writes against reads into ratio, cost, and write-heavy flag", () => {
    // 3 writes, 2 reads → ratio 1.5, write-heavy under the default ratio of 1.
    writeEvent("feedback", "2026-07-01T10:00:00Z");
    writeEvent("feedback", "2026-07-01T10:01:00Z");
    writeEvent("note", "2026-07-01T10:02:00Z");
    read("2026-07-01T11:00:00.000Z", "search");
    read("2026-07-01T11:01:00.000Z", "context_pack");

    const meter = computeMemoryCostMeter(vault);
    expect(meter.writes.total).toBe(3);
    expect(meter.reads.total).toBe(2);
    expect(meter.write_read_ratio).toBe(1.5);
    expect(meter.write_heavy).toBe(true);
    expect(meter.reads.by_mode).toEqual({ search: 1, context_pack: 1 });
    // Default unit weights: cost equals op counts.
    expect(meter.cost).toEqual({ write: 3, read: 2, total: 5 });
  });

  test("applies custom weights and a custom write-heavy threshold", () => {
    writeEvent("feedback", "2026-07-01T10:00:00Z");
    writeEvent("note", "2026-07-01T10:01:00Z");
    read("2026-07-01T11:00:00.000Z", "search");
    read("2026-07-01T11:01:00.000Z", "search");

    const meter = computeMemoryCostMeter(vault, {
      weights: { write: 5, read: 0.5 },
      writeHeavyRatio: 2,
    });
    expect(meter.write_read_ratio).toBe(1); // 2 writes / 2 reads
    expect(meter.write_heavy).toBe(false); // 1 <= threshold 2
    expect(meter.cost).toEqual({ write: 10, read: 1, total: 11 });
    expect(meter.weights).toEqual({ write: 5, read: 0.5 });
  });

  test("no reads → null ratio, write-heavy when any writes exist", () => {
    writeEvent("feedback", "2026-07-01T10:00:00Z");
    const meter = computeMemoryCostMeter(vault);
    expect(meter.reads.total).toBe(0);
    expect(meter.write_read_ratio).toBeNull();
    expect(meter.write_heavy).toBe(true);
  });

  test("empty vault → zeroed meter, not write-heavy", () => {
    const meter = computeMemoryCostMeter(vault);
    expect(meter.writes.total).toBe(0);
    expect(meter.reads.total).toBe(0);
    expect(meter.write_read_ratio).toBeNull();
    expect(meter.write_heavy).toBe(false);
    expect(meter.cost.total).toBe(0);
  });

  test("negative or non-finite weights fall back to unit defaults", () => {
    writeEvent("feedback", "2026-07-01T10:00:00Z");
    read("2026-07-01T11:00:00.000Z", "search");
    const meter = computeMemoryCostMeter(vault, {
      weights: { write: -3, read: Number.NaN },
    });
    expect(meter.weights).toEqual({ write: 1, read: 1 });
  });
});
