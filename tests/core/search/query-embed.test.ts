/**
 * The query-embed gateway (honest-query-embed-and-safe-upgrades, tasks 2-3).
 *
 * Two questions every paid query embed shares, answered once:
 *
 *   - what text is sent: the query cut to the effective input window,
 *     with the prefix the backend actually sends charged against it under
 *     the CEILING estimate, so the cut never sends more than the window;
 *   - whether it is sent at all: a caller that is not local, under a
 *     positive `embedding_cost_gate_usd`, on a model nobody priced, is
 *     refused before any provider exists.
 */

import { expect, test } from "bun:test";

import {
  fitQueryToWindow,
  prepareQueryEmbed,
  queryEmbedCutMessage,
  queryEmbedEmptyFitMessage,
  queryEmbedRefusalMessage,
} from "../../../src/core/search/embeddings/query-embed.ts";
import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import {
  INPUT_WINDOW_TOKENS_KEY,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
  EMBEDDING_PRICE_SOURCE,
} from "../../../src/core/search/embeddings/pricing.ts";
import { COST_GATE_KEY, formatEstimatedUsd } from "../../../src/core/search/embedding-spend.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import {
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
  textExtent,
  tokenEstimateCeiling,
  tokenEstimateFloor,
} from "../../../src/core/search/embeddings/signature.ts";

const PREFIX = "query: ";

function ceiling(text: string): number {
  return tokenEstimateCeiling(textExtent(text));
}

/** The code point after `text` in `query`, or undefined at the end. */
function nextCodePoint(query: string, text: string): string | undefined {
  return [...query][[...text].length];
}

// ── task 2: the fit ──────────────────────────────────────────────────────────

test("a null window returns the query unchanged", () => {
  const query = "x".repeat(10_000);
  const fit = fitQueryToWindow(query, PREFIX, null);
  expect(fit.text).toBe(query);
  expect(fit.truncated).toBe(false);
});

test("a query that fits a known window is not cut", () => {
  const fit = fitQueryToWindow("short query", PREFIX, 512);
  expect(fit.text).toBe("short query");
  expect(fit.truncated).toBe(false);
});

test("an ASCII query over the window is cut to the longest prefix that fits", () => {
  const window = 16;
  const query = "abcdefghij".repeat(20);
  const fit = fitQueryToWindow(query, PREFIX, window);
  expect(fit.truncated).toBe(true);
  expect(query.startsWith(fit.text)).toBe(true);
  expect(ceiling(PREFIX + fit.text)).toBeLessThanOrEqual(window);
  const next = nextCodePoint(query, fit.text);
  expect(next).toBeDefined();
  expect(ceiling(PREFIX + fit.text + next!)).toBeGreaterThan(window);
});

test("a Han query is cut under the ceiling bound, never the floor", () => {
  const window = 32;
  const query = "知识管理系统".repeat(20);
  const fit = fitQueryToWindow(query, PREFIX, window);
  expect(fit.truncated).toBe(true);
  expect(ceiling(PREFIX + fit.text)).toBeLessThanOrEqual(window);
  expect(ceiling(PREFIX + fit.text + nextCodePoint(query, fit.text)!)).toBeGreaterThan(window);
  // The floor would have admitted roughly four times as much Han text.
  const floorCut = [...query].slice(0, (window - 2) * 4).join("");
  expect(tokenEstimateFloor(textExtent(PREFIX + floorCut))).toBeLessThanOrEqual(window);
  expect([...fit.text].length).toBeLessThan([...floorCut].length);
});

test("a cut never splits a surrogate pair", () => {
  // Astral-plane characters: each is one code point and two UTF-16 units.
  for (let window = 3; window <= 12; window++) {
    const query = "😀".repeat(40);
    const fit = fitQueryToWindow(query, "", window);
    expect(fit.truncated).toBe(true);
    // A lone high surrogate would round-trip as U+FFFD.
    expect(fit.text.length % 2).toBe(0);
    expect(fit.text).toBe("😀".repeat([...fit.text].length));
    expect(Buffer.from(fit.text, "utf8").toString("utf8")).toBe(fit.text);
  }
});

test("a prefix that alone fills the window gives an empty text, truncated", () => {
  const prefix = "an instruction prefix far longer than the window allows: ";
  const fit = fitQueryToWindow("the actual question", prefix, 4);
  expect(fit.text).toBe("");
  expect(fit.truncated).toBe(true);
  // Nothing is sent, so nothing is counted.
  expect(fit.sentTokens).toBe(0);
});

test("sentTokens counts the prefix, with the shared spend estimator", () => {
  const uncut = fitQueryToWindow("hello world", PREFIX, null);
  expect(uncut.sentTokens).toBe(estimateTokens([PREFIX + "hello world"]));
  expect(uncut.sentTokens).toBeGreaterThan(estimateTokens(["hello world"]));
  const cut = fitQueryToWindow("abcdefghij".repeat(20), PREFIX, 16);
  expect(cut.sentTokens).toBe(estimateTokens([PREFIX + cut.text]));
});

// ── task 3: the reach and price gate ─────────────────────────────────────────

/** A model string outside both the price table and the preset table. */
const UNPRICED_MODEL = "acme/custom-embed-9000";

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault: "/vault-never-read",
    dbPath: "/index-never-opened.db",
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "https://embeddings.invalid/v1",
      model: UNPRICED_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      costGateUsd: 1,
      ...semantic,
    },
  });
}

test("a remote caller under a positive gate on an unpriced model is refused, naming the model", () => {
  const result = prepareQueryEmbed(cfg(), "what did I decide", TRANSPORT_REACH.remote);
  expect(result).toEqual({
    kind: "refused",
    code: "EMBEDDING_COST_UNPRICED",
    model: UNPRICED_MODEL,
  });
});

test("an omitted reach is remote, as everywhere else", () => {
  expect(prepareQueryEmbed(cfg(), "what did I decide", undefined).kind).toBe("refused");
});

test("a local caller under a positive gate on an unpriced model is ready", () => {
  const result = prepareQueryEmbed(cfg(), "what did I decide", TRANSPORT_REACH.local);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.quote.source).toBe(EMBEDDING_PRICE_SOURCE.unknown);
});

test("a remote caller under a zero gate is ready", () => {
  expect(prepareQueryEmbed(cfg({ costGateUsd: 0 }), "q", TRANSPORT_REACH.remote).kind).toBe(
    "ready",
  );
});

test("a remote caller on an operator-priced model is ready", () => {
  const result = prepareQueryEmbed(
    cfg({ priceOverride: { model: UNPRICED_MODEL, usdPerMtok: 0 } }),
    "q",
    TRANSPORT_REACH.remote,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.quote).toEqual({ usdPerMtok: 0, source: EMBEDDING_PRICE_SOURCE.operator });
});

test("the offline local embedder is ready: its builtin price is zero", () => {
  const result = prepareQueryEmbed(
    cfg({ provider: "local", model: LOCAL_EMBEDDING_MODEL, baseUrl: null, apiKey: null }),
    "q",
    TRANSPORT_REACH.remote,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.quote.source).toBe(EMBEDDING_PRICE_SOURCE.builtin);
  expect(result.model).toBe(LOCAL_EMBEDDING_MODEL);
  expect(result.windowTokens).toBeNull();
});

test("the ready result carries the fitted text, the window and the quote", () => {
  const query = "abcdefghij".repeat(40);
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 16, queryPrefix: "query: " });
  const result = prepareQueryEmbed(config, query, TRANSPORT_REACH.remote);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  const fit = fitQueryToWindow(query, "query: ", 16);
  expect(result.text).toBe(fit.text);
  expect(result.truncated).toBe(true);
  expect(result.sentTokens).toBe(fit.sentTokens);
  expect(result.windowTokens).toBe(16);
  expect(result.model).toBe(UNPRICED_MODEL);
  expect(result.quote.source).toBe(EMBEDDING_PRICE_SOURCE.unknown);
});

test("the fit charges the prefix the backend sends, not the one configured", () => {
  const query = "abcdefghij".repeat(40);
  const config = cfg({
    provider: "zeroentropy",
    costGateUsd: 0,
    inputWindowTokens: 16,
    queryPrefix: "query: ",
  });
  const result = prepareQueryEmbed(config, query, TRANSPORT_REACH.local);
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.text).toBe(fitQueryToWindow(query, "", 16).text);
});

test("a curated model is fitted to its declared window with no operator key", () => {
  const query = "word ".repeat(2000);
  const result = prepareQueryEmbed(
    cfg({ model: RECOMMENDED_EMBEDDING_MODEL, costGateUsd: 0 }),
    query,
    TRANSPORT_REACH.local,
  );
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.truncated).toBe(true);
  expect(result.windowTokens).toBeGreaterThan(0);
});

test("the gateway constructs no provider: it is pure over config", () => {
  // A config no provider can be built from: makeProvider throws on it.
  const unbuildable = cfg({ baseUrl: null, apiKey: null, costGateUsd: 0 });
  expect(() => makeProvider(unbuildable.semantic)).toThrow();
  const result = prepareQueryEmbed(unbuildable, "q", TRANSPORT_REACH.remote);
  expect(result instanceof Promise).toBe(false);
  expect(result.kind).toBe("ready");
});

test("the refusal sentence names the model, the gate key and the price pair", () => {
  const result = prepareQueryEmbed(cfg(), "q", TRANSPORT_REACH.remote);
  if (result.kind !== "refused") throw new Error("narrowed wrong");
  const message = queryEmbedRefusalMessage(result);
  for (const needle of [
    UNPRICED_MODEL,
    COST_GATE_KEY,
    EMBEDDING_PRICE_MODEL_KEY,
    EMBEDDING_PRICE_RATE_KEY,
  ]) {
    expect(message).toContain(needle);
  }
});

test("the refusal sentence says the gate is on, never its amount", () => {
  const result = prepareQueryEmbed(cfg({ costGateUsd: 7.25 }), "q", TRANSPORT_REACH.remote);
  if (result.kind !== "refused") throw new Error("narrowed wrong");
  const message = queryEmbedRefusalMessage(result);
  expect(message).toContain(`${COST_GATE_KEY} is positive`);
  expect(message).not.toContain(formatEstimatedUsd(7.25));
  expect(message).not.toContain("7.25");
});

// ── the shared sentences for a cut ───────────────────────────────────────────

test("a prefix that fills the window is an empty fit, cut to that window", () => {
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 1, queryPrefix: "query: " });
  const result = prepareQueryEmbed(config, "the actual question", TRANSPORT_REACH.remote);
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.text).toBe("");
  expect(result.truncated).toBe(true);
  expect(result.emptyFit).toBe(true);
  expect(result.windowTokens).toBe(1);
});

test("a cut that keeps some of the query is not an empty fit", () => {
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 16, queryPrefix: "query: " });
  const result = prepareQueryEmbed(config, "abcdefghij".repeat(40), TRANSPORT_REACH.remote);
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.truncated).toBe(true);
  expect(result.emptyFit).toBe(false);
});

test("an empty query is sent as it came, not reported as an empty fit", () => {
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 16, queryPrefix: "query: " });
  const result = prepareQueryEmbed(config, "", TRANSPORT_REACH.remote);
  if (result.kind !== "ready") throw new Error("narrowed wrong");
  expect(result.truncated).toBe(false);
  expect(result.emptyFit).toBe(false);
});

test("the empty-fit sentence names the window and the key that raises it", () => {
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 3, queryPrefix: "a long prefix: " });
  const result = prepareQueryEmbed(config, "q", TRANSPORT_REACH.remote);
  if (result.kind !== "ready" || !result.truncated) throw new Error("narrowed wrong");
  const message = queryEmbedEmptyFitMessage(result);
  expect(message).toContain("3-token");
  expect(message).toContain(INPUT_WINDOW_TOKENS_KEY);
});

test("the cut sentence names the window, what was kept and the key that raises it", () => {
  const query = "abcdefghij".repeat(40);
  const config = cfg({ costGateUsd: 0, inputWindowTokens: 16, queryPrefix: "query: " });
  const result = prepareQueryEmbed(config, query, TRANSPORT_REACH.remote);
  if (result.kind !== "ready" || !result.truncated) throw new Error("narrowed wrong");
  const message = queryEmbedCutMessage(result, query);
  expect(message).toContain("16-token");
  expect(message).toContain(`${[...result.text].length} of ${[...query].length} code point(s)`);
  expect(message).toContain(INPUT_WINDOW_TOKENS_KEY);
});
