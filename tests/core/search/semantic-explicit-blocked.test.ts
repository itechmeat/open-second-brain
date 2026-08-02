/**
 * An EXPLICIT semantic request that the CONFIGURATION cannot serve fails
 * typed; it is never answered with keyword-only results and exit 0.
 *
 * `semantic-phase.ts` says so in prose - "the explicit arm is the one that
 * ATTEMPTED something and could not, so it keeps reporting the typed
 * SearchError" - but the tier ladder it now resolves through had only the
 * `credential-missing` rung wired to a throw, so an explicit `--semantic`
 * against `embedding_provider: disabled` silently degraded. This file
 * covers BOTH values of `explicit` against BOTH blocked rungs, so neither
 * cell can regress unobserved again.
 */

import { test, expect } from "bun:test";

import {
  resolveSemanticCapability,
  semanticCapabilityLabel,
  SEMANTIC_CAPABILITY_TIER,
} from "../../../src/core/search/capability-tier.ts";
import { runSemanticPhase } from "../../../src/core/search/semantic-phase.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import type { Store } from "../../../src/core/search/store.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";

/**
 * A store that HAS vectors and HAS the extension, so the two runtime
 * guards ahead of the capability arm pass and what a case measures is the
 * configuration-derived arm alone.
 */
function readyStore(): Store {
  return {
    counts: () => ({ documents: 1, chunks: 1, embeddings: 1, staleEmbeddings: 0 }),
    vecLoaded: () => true,
    semanticTopK: () => [],
  } as unknown as Store;
}

/** Every rung of the ladder that BLOCKS, with the configuration that reaches it. */
const BLOCKED_CASES = [
  {
    label: "provider disabled while semantic is switched on",
    semantic: { enabled: true, provider: "disabled" } satisfies Partial<ResolvedEmbeddingConfig>,
    tier: SEMANTIC_CAPABILITY_TIER.disabled,
    code: "EMBEDDING_DISABLED",
  },
  {
    label: "semantic switched off outright",
    semantic: {
      enabled: false,
      provider: "openai-compat",
    } satisfies Partial<ResolvedEmbeddingConfig>,
    tier: SEMANTIC_CAPABILITY_TIER.disabled,
    code: "EMBEDDING_DISABLED",
  },
  {
    label: "remote provider with no credential",
    semantic: {
      enabled: true,
      provider: "openai-compat",
      apiKey: undefined,
      apiKeys: [],
    } satisfies Partial<ResolvedEmbeddingConfig>,
    tier: SEMANTIC_CAPABILITY_TIER.credentialMissing,
    code: "EMBEDDING_KEY_MISSING",
  },
] as const;

function configFor(semantic: Partial<ResolvedEmbeddingConfig>) {
  return makeConfig({
    vault: "/tmp/does-not-matter",
    dbPath: "/tmp/does-not-matter/db.sqlite",
    semantic,
  });
}

/** The registry sentence for each case, resolved once and in case order. */
function registryLabels(): Promise<string[]> {
  return Promise.all(
    BLOCKED_CASES.map((c) =>
      semanticCapabilityLabel(resolveSemanticCapability(configFor(c.semantic).semantic).code),
    ),
  );
}

test("each blocked configuration sits on the rung the case names", () => {
  const observed = BLOCKED_CASES.map(
    (c) => `${c.label}: ${resolveSemanticCapability(configFor(c.semantic).semantic).tier}`,
  );
  expect(observed).toEqual(BLOCKED_CASES.map((c) => `${c.label}: ${c.tier}`));
});

test("an explicit semantic request throws the typed error for every blocked rung", async () => {
  const labels = await registryLabels();
  const observed = await Promise.all(
    BLOCKED_CASES.map(async (c) => {
      try {
        await runSemanticPhase(readyStore(), configFor(c.semantic), "q", {
          limit: 10,
          pathPrefix: undefined,
          explicit: true,
        });
        return `${c.label}: returned keyword-only results`;
      } catch (e) {
        const err = e as SearchError;
        return `${c.label}: ${err.code} / ${err.message}`;
      }
    }),
  );
  // The sentence is the registry's, not one assembled at the throw site, so
  // the explicit and implicit arms name the same condition identically.
  expect(observed).toEqual(BLOCKED_CASES.map((c, i) => `${c.label}: ${c.code} / ${labels[i]}`));
});

test("an implicit request degrades with the registry label for every blocked rung", async () => {
  const labels = await registryLabels();
  const observed = await Promise.all(
    BLOCKED_CASES.map(async (c) => {
      const outcome = await runSemanticPhase(readyStore(), configFor(c.semantic), "q", {
        limit: 10,
        pathPrefix: undefined,
        explicit: false,
      });
      return `${c.label}: ${outcome.attempted} / ${outcome.warnings.join("|")}`;
    }),
  );
  expect(observed).toEqual(BLOCKED_CASES.map((c, i) => `${c.label}: false / ${labels[i]}`));
});
