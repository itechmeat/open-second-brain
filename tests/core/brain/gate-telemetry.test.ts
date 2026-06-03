/**
 * Recall-gate telemetry kernel (Workspace Insight Suite, t_65036e02).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitGateTelemetry,
  hashPrompt,
  listGateTelemetry,
  summarizeGateTelemetry,
} from "../../../src/core/brain/gate-telemetry.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-gate-telemetry-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("emit stores decision, reason, and prompt hash - never the raw prompt", () => {
  const record = emitGateTelemetry(vault, {
    host: "hermes",
    prompt: "secret operational detail",
    retrieve: false,
    reason: "no_recall_intent",
  });
  expect(record.payload["decision"]).toBe("skip");
  expect(record.payload["reason"]).toBe("no_recall_intent");
  expect(record.payload["prompt_hash"]).toBe(hashPrompt("secret operational detail"));
  expect(record.payload["prompt_chars"]).toBe("secret operational detail".length);
  expect(JSON.stringify(record.payload)).not.toContain("secret operational detail");
});

test("summary aggregates by decision and reason", () => {
  emitGateTelemetry(vault, { host: "a", prompt: "p1", retrieve: true, reason: "explicit" });
  emitGateTelemetry(vault, { host: "a", prompt: "p2", retrieve: false, reason: "greeting" });
  emitGateTelemetry(vault, { host: "b", prompt: "p3", retrieve: false, reason: "greeting" });
  const summary = summarizeGateTelemetry(vault);
  expect(summary.total).toBe(3);
  expect(summary.retrieved).toBe(1);
  expect(summary.skipped).toBe(2);
  expect(summary.by_reason["greeting"]).toBe(2);

  const hostOnly = summarizeGateTelemetry(vault, { host: "a" });
  expect(hostOnly.total).toBe(2);
});

test("list is newest-first and respects limit", () => {
  emitGateTelemetry(vault, {
    host: "a",
    prompt: "first",
    retrieve: true,
    reason: "explicit",
    createdAt: "2026-06-01T00:00:00Z",
  });
  emitGateTelemetry(vault, {
    host: "a",
    prompt: "second",
    retrieve: true,
    reason: "explicit",
    createdAt: "2026-06-02T00:00:00Z",
  });
  const listed = listGateTelemetry(vault, { limit: 1 });
  expect(listed).toHaveLength(1);
  expect(listed[0]!.payload["prompt_hash"]).toBe(hashPrompt("second"));
});
