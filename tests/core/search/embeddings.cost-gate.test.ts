import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  embeddingSignature,
  evaluateCostGate,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

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

// ── operator price pair ──────────────────────────────────────────────────────

const PRICE_MODEL_KEY = "embedding_price_model";
const PRICE_RATE_KEY = "embedding_price_usd_per_mtok";
const PRICE_MODEL_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_PRICE_MODEL";
const PRICE_RATE_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_PRICE_USD_PER_MTOK";

/** Resolve with exactly `env` as the price-pair env layer, restoring it after. */
function resolveWith(lines: ReadonlyArray<string>, env: Record<string, string> = {}) {
  writeFileSync(config, [`vault: "${tmp}"`, ...lines, ""].join("\n"));
  const saved = {
    [PRICE_MODEL_ENV]: process.env[PRICE_MODEL_ENV],
    [PRICE_RATE_ENV]: process.env[PRICE_RATE_ENV],
  };
  delete process.env[PRICE_MODEL_ENV];
  delete process.env[PRICE_RATE_ENV];
  Object.assign(process.env, env);
  try {
    return resolveSearchConfig({ vault: tmp, configPath: config });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function refusalOf(run: () => unknown): SearchError {
  try {
    run();
  } catch (error) {
    if (error instanceof SearchError) return error;
    throw error;
  }
  throw new Error("expected config resolution to refuse");
}

test("the price pair resolves from config into priceOverride", () => {
  const cfg = resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "0.05"`]);
  expect(cfg.semantic.priceOverride).toEqual({ model: "zembed-1", usdPerMtok: 0.05 });
});

test("the env pair wins over the config pair", () => {
  const cfg = resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "0.05"`], {
    [PRICE_MODEL_ENV]: "voyage-3",
    [PRICE_RATE_ENV]: "0.06",
  });
  expect(cfg.semantic.priceOverride).toEqual({ model: "voyage-3", usdPerMtok: 0.06 });
});

test("a colon-bearing model id survives the flat parser", () => {
  const cfg = resolveWith([`${PRICE_MODEL_KEY}: nomic-embed-text:latest`, `${PRICE_RATE_KEY}: 0`]);
  expect(cfg.semantic.priceOverride).toEqual({ model: "nomic-embed-text:latest", usdPerMtok: 0 });
});

test("a half pair is refused, naming the missing key", () => {
  const noRate = refusalOf(() => resolveWith([`${PRICE_MODEL_KEY}: zembed-1`]));
  expect(noRate.code).toBe("INVALID_INPUT");
  expect(noRate.message).toContain(PRICE_RATE_KEY);
  const noModel = refusalOf(() => resolveWith([`${PRICE_RATE_KEY}: "0.05"`]));
  expect(noModel.code).toBe("INVALID_INPUT");
  expect(noModel.message).toContain(PRICE_MODEL_KEY);
});

test("a negative or non-numeric rate is refused by name", () => {
  for (const rate of ["-1", "cheap"]) {
    const refusal = refusalOf(() =>
      resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "${rate}"`]),
    );
    expect(refusal.code).toBe("INVALID_INPUT");
    expect(refusal.message).toContain(PRICE_RATE_KEY);
  }
});

test("without the pair priceOverride is absent", () => {
  const cfg = resolveWith([]);
  expect("priceOverride" in cfg.semantic).toBe(false);
});

function signatureOf(cfg: ResolvedSearchConfig): string {
  return embeddingSignature({
    provider: cfg.semantic.provider,
    model: cfg.semantic.model,
    dimension: cfg.semantic.dimension,
  });
}

test("declaring a price never changes the embedding signature", () => {
  const model = "text-embedding-3-small";
  const plain = resolveWith([`embedding_model: ${model}`]);
  const priced = resolveWith([
    `embedding_model: ${model}`,
    `${PRICE_MODEL_KEY}: ${model}`,
    `${PRICE_RATE_KEY}: "0.5"`,
  ]);
  expect(priced.semantic.priceOverride).toBeDefined();
  expect(signatureOf(priced)).toBe(signatureOf(plain));
});
