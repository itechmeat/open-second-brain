import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateCostGate,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";

// ── pure cost-gate kernel ────────────────────────────────────────────────────

test("evaluateCostGate estimates spend for a priced model", () => {
  // 4,000,000 chars -> ~1,000,000 tokens at chars/4.
  const texts = ["x".repeat(4_000_000)];
  const r = evaluateCostGate({ texts, model: "text-embedding-3-small", gateUsd: 0 });
  expect(r.tokens).toBe(1_000_000);
  expect(r.estimatedUsd).toBeGreaterThan(0);
});

test("evaluateCostGate blocks when the estimate exceeds a positive gate", () => {
  const texts = ["x".repeat(4_000_000)]; // ~1M tokens
  const r = evaluateCostGate({ texts, model: "text-embedding-3-small", gateUsd: 0.001 });
  expect(r.blocked).toBe(true);
});

test("evaluateCostGate does not block when forced", () => {
  const texts = ["x".repeat(4_000_000)];
  const r = evaluateCostGate({
    texts,
    model: "text-embedding-3-small",
    gateUsd: 0.001,
    forced: true,
  });
  expect(r.blocked).toBe(false);
});

test("a zero gate (default) never blocks", () => {
  const texts = ["x".repeat(40_000_000)];
  const r = evaluateCostGate({ texts, model: "text-embedding-3-small", gateUsd: 0 });
  expect(r.blocked).toBe(false);
});

test("the local model never blocks regardless of gate or volume", () => {
  const texts = ["x".repeat(40_000_000)];
  const r = evaluateCostGate({ texts, model: LOCAL_EMBEDDING_MODEL, gateUsd: 0.0001 });
  expect(r.estimatedUsd).toBe(0);
  expect(r.blocked).toBe(false);
});

// ── config parsing ───────────────────────────────────────────────────────────

let tmp: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-costgate-"));
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("embedding_cost_gate_usd defaults to 0 (disabled)", () => {
  writeFileSync(config, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath: config });
  expect(cfg.semantic.costGateUsd).toBe(0);
});

test("embedding_cost_gate_usd is parsed from config", () => {
  writeFileSync(config, `vault: "${tmp}"\nembedding_cost_gate_usd: "2.5"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath: config });
  expect(cfg.semantic.costGateUsd).toBe(2.5);
});
