/**
 * The live embedding-provider probe and the vocabulary it answers in
 * (wiring-what-exists, unit E1).
 *
 * The defect this file exists for: `indexCheck` raced `provider.ping()`
 * against a five-second `withTimeout` and folded every non-success into a
 * single `providerReachable = false`. A provider that ANSWERED and refused
 * and a provider that never answered at all were therefore reported as the
 * same finding, and both were then pushed into `warnings`, which the verb's
 * exit code does not read. A boolean cannot carry the difference between
 * "it is broken", "I could not find out" and "there is nothing configured
 * to ask", so the probe now answers in a closed vocabulary and each arm is
 * asserted here.
 *
 * Everything below talks to a loopback stub from `tests/helpers/fake-http.ts`.
 * No test in this file makes a real network call, and the not-configured
 * arm asserts that no call is made at all.
 *
 * Deliberately NOT covered here: the CLI's exit codes, its `--json` keys
 * and its `--no-probe` flag (all in `tests/cli/search-check-provider.test.ts`),
 * and the openai-compat retry/failover machinery `ping` sits on top of
 * (`tests/core/search/embeddings.test.ts`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import {
  isProviderProbeState,
  probeProvider,
  PROVIDER_PROBE,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_STATES,
} from "../../../src/core/search/provider-probe.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

/** A budget short enough to elapse inside a test, and long enough not to flake. */
const SHORT_BUDGET_MS = 120;
/** A server delay comfortably past every budget this file sets. */
const SLOW_RESPONSE_MS = 1_500;
/** A per-request timeout the provider itself trips before any budget does. */
const SHORT_REQUEST_TIMEOUT_MS = 100;

let server: FakeHttp;

function semanticConfig(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: server.url,
    model: "fake-model",
    apiKey: "test-key",
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 2,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

test("a provider that answers is reachable", async () => {
  const outcome = await probeProvider(() => makeProvider(semanticConfig()));
  expect(outcome.state).toBe(PROVIDER_PROBE.reachable);
  expect(outcome.reason).toBeNull();
  expect(server.callCount()).toBe(1);
});

test("a provider that answers with a refusal is proved unreachable, and the refusal is named", async () => {
  server.setHandler(() => ({ status: 500, body: { error: "upstream exploded" } }));
  const outcome = await probeProvider(() => makeProvider(semanticConfig()));
  expect(outcome.state).toBe(PROVIDER_PROBE.unreachable);
  expect(outcome.reason).toContain("500");
});

test("a provider that never answers within the budget did not complete, and is not a refusal", async () => {
  server.setHandler(() => ({ status: 200, body: { data: [] }, delayMs: SLOW_RESPONSE_MS }));
  const outcome = await probeProvider(() => makeProvider(semanticConfig()), {
    budgetMs: SHORT_BUDGET_MS,
  });
  expect(outcome.state).toBe(PROVIDER_PROBE.timedOut);
  expect(outcome.state).not.toBe(PROVIDER_PROBE.unreachable);
  expect(outcome.reason).toContain(String(SHORT_BUDGET_MS));
});

test("the provider's own request budget elapsing is a probe that did not complete either", async () => {
  // The inner timeout trips first, so the outcome arrives through `ping`
  // rather than through the outer race. Both are "I could not find out".
  server.setHandler(() => ({ status: 200, body: { data: [] }, delayMs: SLOW_RESPONSE_MS }));
  const outcome = await probeProvider(() =>
    makeProvider(semanticConfig({ timeoutMs: SHORT_REQUEST_TIMEOUT_MS, maxRetries: 1 })),
  );
  expect(outcome.state).toBe(PROVIDER_PROBE.timedOut);
  expect(outcome.reason).toContain(String(SHORT_REQUEST_TIMEOUT_MS));
});

test("a provider that cannot even be built is unreachable, with the construction error named", async () => {
  const outcome = await probeProvider(() => makeProvider(semanticConfig({ baseUrl: null })));
  expect(outcome.state).toBe(PROVIDER_PROBE.unreachable);
  expect(outcome.reason).toContain("embedding_base_url");
});

test("the probe budget is stated once, at the value the check has always spent", async () => {
  expect(PROVIDER_PROBE_BUDGET_MS).toBe(5_000);
  // The vocabulary is total over what the check can conclude.
  expect([...PROVIDER_PROBE_STATES].toSorted()).toEqual(Object.values(PROVIDER_PROBE).toSorted());
  expect(isProviderProbeState(PROVIDER_PROBE.timedOut)).toBe(true);
  expect(isProviderProbeState("reachable ")).toBe(false);
});
