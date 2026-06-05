/**
 * Dashboard-ready metrics sink (link-recall-intelligence, Task 1):
 * one append-only schema-versioned JSONL file per surface under
 * `Brain/metrics/`, the stable on-disk contract a dashboard plugin
 * reads without importing OSB internals. Envelope mirrors the
 * continuity-record discipline: additive-optional fields keep the
 * version, renames/removals bump it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMetric,
  listMetrics,
  METRICS_SCHEMA_VERSION,
  MetricSurfaceError,
} from "../../../src/core/brain/metrics.ts";

const NOW = "2026-06-05T10:00:00Z";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-metrics-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("appendMetric", () => {
  test("writes one schema-stamped line per call into the surface file", () => {
    appendMetric(vault, { surface: "recall_benchmark", runAt: NOW, payload: { mrr: 0.91 } });
    appendMetric(vault, {
      surface: "recall_benchmark",
      runAt: "2026-06-05T11:00:00Z",
      payload: { mrr: 0.93 },
    });
    const raw = readFileSync(join(vault, "Brain", "metrics", "recall_benchmark.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      schema: METRICS_SCHEMA_VERSION,
      surface: "recall_benchmark",
      run_at: NOW,
      payload: { mrr: 0.91 },
    });
  });

  test("surfaces are isolated files", () => {
    appendMetric(vault, { surface: "index", runAt: NOW, payload: { files: 3 } });
    appendMetric(vault, { surface: "communities", runAt: NOW, payload: { count: 2 } });
    expect(readFileSync(join(vault, "Brain", "metrics", "index.jsonl"), "utf8")).toContain(
      '"files":3',
    );
    expect(readFileSync(join(vault, "Brain", "metrics", "communities.jsonl"), "utf8")).toContain(
      '"count":2',
    );
  });

  test("rejects surface names outside [a-z][a-z0-9_]*", () => {
    for (const bad of ["", "Index", "9lives", "a-b", "a b", "a/../b", "x".repeat(65)]) {
      expect(() => appendMetric(vault, { surface: bad, runAt: NOW, payload: {} })).toThrow(
        MetricSurfaceError,
      );
    }
  });

  test("rejects a runAt that is not an ISO timestamp", () => {
    expect(() =>
      appendMetric(vault, { surface: "index", runAt: "yesterday", payload: {} }),
    ).toThrow(/run_at/);
  });
});

describe("listMetrics", () => {
  test("missing dir or file reads as empty", () => {
    expect(listMetrics(vault)).toEqual([]);
    expect(listMetrics(vault, { surface: "index" })).toEqual([]);
  });

  test("newest-first per surface with since and limit filters", () => {
    appendMetric(vault, { surface: "index", runAt: "2026-06-01T00:00:00Z", payload: { n: 1 } });
    appendMetric(vault, { surface: "index", runAt: "2026-06-03T00:00:00Z", payload: { n: 2 } });
    appendMetric(vault, { surface: "index", runAt: "2026-06-05T00:00:00Z", payload: { n: 3 } });
    const all = listMetrics(vault, { surface: "index" });
    expect(all.map((r) => r.payload["n"])).toEqual([3, 2, 1]);
    const since = listMetrics(vault, { surface: "index", since: "2026-06-02T00:00:00Z" });
    expect(since.map((r) => r.payload["n"])).toEqual([3, 2]);
    const limited = listMetrics(vault, { surface: "index", limit: 1 });
    expect(limited.map((r) => r.payload["n"])).toEqual([3]);
  });

  test("without a surface filter, merges every surface newest-first", () => {
    appendMetric(vault, { surface: "index", runAt: "2026-06-01T00:00:00Z", payload: { n: 1 } });
    appendMetric(vault, {
      surface: "bridge_discovery",
      runAt: "2026-06-04T00:00:00Z",
      payload: { n: 2 },
    });
    appendMetric(vault, { surface: "index", runAt: "2026-06-05T00:00:00Z", payload: { n: 3 } });
    const all = listMetrics(vault);
    expect(all.map((r) => r.payload["n"])).toEqual([3, 2, 1]);
    expect(all.map((r) => r.surface)).toEqual(["index", "bridge_discovery", "index"]);
  });

  test("a torn or malformed line never breaks the read", () => {
    appendMetric(vault, { surface: "index", runAt: NOW, payload: { n: 1 } });
    const path = join(vault, "Brain", "metrics", "index.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + "{not json\n[]\n");
    const records = listMetrics(vault, { surface: "index" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["n"]).toBe(1);
  });

  test("ignores non-jsonl files in the metrics dir", () => {
    mkdirSync(join(vault, "Brain", "metrics"), { recursive: true });
    writeFileSync(join(vault, "Brain", "metrics", "README.md"), "# not a metric\n");
    appendMetric(vault, { surface: "index", runAt: NOW, payload: { n: 1 } });
    expect(listMetrics(vault)).toHaveLength(1);
  });
});
