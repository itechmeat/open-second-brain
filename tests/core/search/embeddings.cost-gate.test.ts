import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeEmbeddingModel } from "../../../src/core/search/embedding-spend.ts";
import { embeddingSignature } from "../../../src/core/search/embeddings/signature.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

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

const COST_GATE_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_COST_GATE";

/** Resolve `lines` with `value` (or nothing) as the gate env twin, restoring it after. */
function resolveGate(lines: ReadonlyArray<string>, value?: string): ResolvedSearchConfig {
  writeFileSync(config, [`vault: "${tmp}"`, ...lines, ""].join("\n"));
  const saved = process.env[COST_GATE_ENV];
  if (value === undefined) delete process.env[COST_GATE_ENV];
  else process.env[COST_GATE_ENV] = value;
  try {
    return resolveSearchConfig({ vault: tmp, configPath: config });
  } finally {
    if (saved === undefined) delete process.env[COST_GATE_ENV];
    else process.env[COST_GATE_ENV] = saved;
  }
}

test("a blank cost gate is refused, never read as a gate of 0", () => {
  // `Number("  ")` is 0, which would silently switch the gate off.
  for (const run of [
    () => resolveGate(["embedding_cost_gate_usd: 1"], "  "),
    () => resolveGate(['embedding_cost_gate_usd: "  "']),
  ]) {
    const refusal = refusalOf(run);
    expect(refusal.code).toBe("INVALID_INPUT");
    expect(refusal.message).toContain("embedding_cost_gate_usd must be a number >= 0");
    expect(refusal.message).toContain("got empty string");
  }
});

test("an empty cost gate env twin still counts as unset", () => {
  expect(resolveGate(["embedding_cost_gate_usd: 1"], "").semantic.costGateUsd).toBe(1);
});

test("a blank rerank floor is refused, never read as 0", () => {
  const refusal = refusalOf(() => resolveGate(['search_rerank_min_score: "  "']));
  expect(refusal.code).toBe("INVALID_INPUT");
  expect(refusal.message).toContain("must be a finite number, got empty string");
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

test("an env model never pairs with a config rate", () => {
  const refusal = refusalOf(() =>
    resolveWith([`${PRICE_RATE_KEY}: "0.05"`], { [PRICE_MODEL_ENV]: "voyage-3" }),
  );
  expect(refusal.code).toBe("INVALID_INPUT");
  expect(refusal.message).toContain(`${PRICE_MODEL_ENV} is set but ${PRICE_RATE_ENV} is not`);
});

test("a half-set env pair is refused even over a full config pair", () => {
  const refusal = refusalOf(() =>
    resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "0.05"`], {
      [PRICE_RATE_ENV]: "0.06",
    }),
  );
  expect(refusal.code).toBe("INVALID_INPUT");
  expect(refusal.message).toContain(`${PRICE_RATE_ENV} is set but ${PRICE_MODEL_ENV} is not`);
});

test("a bad env rate is refused under the env name", () => {
  const refusal = refusalOf(() =>
    resolveWith([], { [PRICE_MODEL_ENV]: "voyage-3", [PRICE_RATE_ENV]: "cheap" }),
  );
  expect(refusal.code).toBe("INVALID_INPUT");
  expect(refusal.message).toContain(PRICE_RATE_ENV);
});

test("a negative or non-numeric rate is refused by name", () => {
  for (const rate of ["-1", "cheap", "NaN", "Infinity", "-Infinity", "0x10", "1e3", "1e308"]) {
    const refusal = refusalOf(() =>
      resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "${rate}"`]),
    );
    expect(refusal.code).toBe("INVALID_INPUT");
    expect(refusal.message).toContain(PRICE_RATE_KEY);
  }
});

test("a rate that is not a plain decimal is refused with an example", () => {
  for (const rate of [".5", "5."]) {
    const refusal = refusalOf(() =>
      resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "${rate}"`]),
    );
    expect(refusal.message).toBe(
      `${PRICE_RATE_KEY} must be a plain decimal number >= 0 (for example 0.02), got '${rate}'`,
    );
  }
});

test("a blank half is a missing half, never a declared free price", () => {
  // `Number("  ")` is 0: a whitespace rate used to resolve to an operator
  // price of $0 - the unknown-reads-as-free defect this pair exists to end.
  const blankRate = refusalOf(() =>
    resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "  "`]),
  );
  expect(blankRate.code).toBe("INVALID_INPUT");
  expect(blankRate.message).toContain(`${PRICE_MODEL_KEY} is set but ${PRICE_RATE_KEY} is not`);
  const blankEnvRate = refusalOf(() =>
    resolveWith([], { [PRICE_MODEL_ENV]: "voyage-3", [PRICE_RATE_ENV]: " " }),
  );
  expect(blankEnvRate.message).toContain(`${PRICE_MODEL_ENV} is set but ${PRICE_RATE_ENV} is not`);
  const blankModel = refusalOf(() =>
    resolveWith([], { [PRICE_MODEL_ENV]: "  ", [PRICE_RATE_ENV]: "0.05" }),
  );
  expect(blankModel.message).toContain(`${PRICE_RATE_ENV} is set but ${PRICE_MODEL_ENV} is not`);
});

test("a rate above the ceiling is refused by name; the ceiling itself resolves", () => {
  const refusal = refusalOf(() =>
    resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "1000001"`]),
  );
  expect(refusal.code).toBe("INVALID_INPUT");
  expect(refusal.message).toContain(PRICE_RATE_KEY);
  expect(refusal.message).toContain("1000000");
  const ceiling = resolveWith([`${PRICE_MODEL_KEY}: zembed-1`, `${PRICE_RATE_KEY}: "1000000"`]);
  expect(ceiling.semantic.priceOverride).toEqual({ model: "zembed-1", usdPerMtok: 1_000_000 });
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

test("the configured embedding model wins over the stored one; the stored one fills a gap", () => {
  const configured = resolveWith(["embedding_model: voyage-3"]);
  expect(activeEmbeddingModel(configured, "zembed-1")).toBe("voyage-3");
  const unset = resolveWith([]);
  expect(unset.semantic.model).toBeNull();
  expect(activeEmbeddingModel(unset, "zembed-1")).toBe("zembed-1");
});
