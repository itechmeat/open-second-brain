/**
 * The decline is honoured at provider construction, before any network
 * call (write-honesty-egress-consent, Lane F).
 *
 * `makeProvider` is the single construction point every embedding
 * provider in this tree goes through, so it is where a recorded decline
 * has to be honoured: a refusal there happens before an endpoint is
 * named, before a key is read and before a byte is sent. The file
 * asserts that with a REQUEST COUNTER on a live loopback server - the
 * count has to stay at zero, because "the provider was never built" is
 * the only claim that keeps a declined vault from reaching an endpoint.
 *
 * The other half of the file is the byte-identity requirement: a
 * configuration that records NO decision must build exactly the provider
 * it built before this feature existed, with no refusal and no changed
 * message, because the difference between "the operator declined" and
 * "the operator never configured this" is the whole point of the feature
 * and collapsing it back would undo it.
 *
 * No test here drops permission bits, and the fake server is a loopback
 * listener, so the file runs the same on every platform.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import { providerProducesVectors } from "../../../src/core/search/embeddings/contract.ts";
import { resolveConfiguredEmbeddingProvider } from "../../../src/core/search/embeddings/configured-provider.ts";
import {
  PROVIDER_CONSENT_KEY,
  PROVIDER_CONSENT_REENABLE_KEYS,
  resolveProviderConsent,
} from "../../../src/core/search/provider-consent.ts";
import { runSemanticPhase } from "../../../src/core/search/semantic-phase.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import type { Store } from "../../../src/core/search/store.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

/**
 * A store that holds vectors and has the extension, so the runtime
 * guards ahead of the configuration arm pass and what a case measures is
 * the configuration-derived arm alone.
 */
function readyStore(): Store {
  return {
    counts: () => ({ documents: 1, chunks: 1, embeddings: 1, staleEmbeddings: 0 }),
    vecLoaded: () => true,
    semanticTopK: () => [],
  } as unknown as Store;
}

/** A configuration that names a live endpoint and would reach it. */
function liveSemantic(baseUrl: string): ResolvedEmbeddingConfig {
  return {
    enabled: true,
    provider: "openai-compat",
    baseUrl,
    model: "fake-model",
    apiKey: FAKE_PROVIDER_KEY,
    dimension: 4,
    timeoutMs: 5_000,
    concurrency: 4,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 0,
  };
}

interface Fixture {
  readonly dir: string;
  readonly configPath: string;
  readonly cleanup: () => void;
}

/** A temporary directory holding a config file. */
function fixture(prefix: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `o2b-${prefix}-`));
  return {
    dir,
    configPath: join(dir, "config.yaml"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The search configuration a declined vault resolves to. */
function searchConfig(configPath: string, semantic: ResolvedEmbeddingConfig): ResolvedSearchConfig {
  return {
    ...makeConfig({
      vault: "/tmp/does-not-matter",
      dbPath: "/tmp/does-not-matter/db.sqlite",
      semantic,
    }),
    configPath,
  };
}

/**
 * The consent env twins are saved and CLEARED around the tests that
 * resolve a provider without an explicit consent: the resolver reads
 * `process.env` and env values take precedence over the config file, so
 * a developer or CI runner exporting either of them would flip these
 * cases no matter what the fixtures write to disk.
 */
function saveAndClearConsentEnv(): () => void {
  const names = ["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC", "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("the decline at provider construction", () => {
  test("a declined record refuses the construction and contacts nothing", async () => {
    const server: FakeHttp = await startFakeHttp();
    const f = fixture("decline-construction");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      const semantic = liveSemantic(server.url);
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {}, semantic });
      let thrown: unknown;
      try {
        makeProvider(semantic, consent);
      } catch (e) {
        thrown = e;
      }
      expect(thrown instanceof SearchError).toBe(true);
      expect((thrown as SearchError).code).toBe("EMBEDDING_DISABLED");
      // The whole point: the refusal happened before a provider existed,
      // so no request was ever sent to the endpoint the configuration
      // named.
      expect(server.callCount()).toBe(0);
    } finally {
      f.cleanup();
      await server.close();
    }
  });

  test("the refusal names the keys that would re-enable the provider", async () => {
    const server: FakeHttp = await startFakeHttp();
    const f = fixture("decline-message");
    try {
      writeFileSync(f.configPath, "embedding_provider: disabled\n");
      const semantic = liveSemantic(server.url);
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {}, semantic });
      let message = "";
      try {
        makeProvider(semantic, consent);
      } catch (e) {
        message = (e as SearchError).message;
      }
      for (const key of PROVIDER_CONSENT_REENABLE_KEYS) {
        expect(message).toContain(key);
      }
      expect(message).toContain(PROVIDER_CONSENT_KEY.provider);
      expect(server.callCount()).toBe(0);
    } finally {
      f.cleanup();
      await server.close();
    }
  });

  test("a caller that passes no consent still reads the record in force", async () => {
    // The indexer and the hygiene detectors call `makeProvider` with the
    // resolved configuration alone, so the record has to be read from the
    // configuration this process is pointed at - the same path the
    // operator named.
    const server: FakeHttp = await startFakeHttp();
    const f = fixture("decline-default-path");
    const saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const restoreConsentEnv = saveAndClearConsentEnv();
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      let thrown: unknown;
      try {
        makeProvider(liveSemantic(server.url));
      } catch (e) {
        thrown = e;
      }
      expect(thrown instanceof SearchError).toBe(true);
      expect((thrown as SearchError).code).toBe("EMBEDDING_DISABLED");
      expect(server.callCount()).toBe(0);
    } finally {
      restoreConsentEnv();
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
      f.cleanup();
      await server.close();
    }
  });

  test("a decline in a named config file is honored when in force and ignored for another file", async () => {
    const server: FakeHttp = await startFakeHttp();
    const fDeclined = fixture("named-decline");
    const fActive = fixture("named-active");
    const saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const restoreConsentEnv = saveAndClearConsentEnv();
    try {
      writeFileSync(fDeclined.configPath, "search_semantic_enabled: false\n");
      writeFileSync(fActive.configPath, 'vault: "/tmp/v"\n');

      // Set ambient config to the declined file. A run pointed at fActive
      // must ignore the ambient decline and build the provider.
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = fDeclined.configPath;
      const activeSemantic = { ...liveSemantic(server.url), configPath: fActive.configPath };
      const activeProvider = makeProvider(activeSemantic);
      expect(providerProducesVectors(activeProvider)).toBe(true);

      // Now set ambient config to the active file. A run pointed at fDeclined
      // must honor the decline in that named file and refuse.
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = fActive.configPath;
      const declinedSemantic = { ...liveSemantic(server.url), configPath: fDeclined.configPath };
      let thrown: unknown;
      try {
        makeProvider(declinedSemantic);
      } catch (e) {
        thrown = e;
      }
      expect(thrown instanceof SearchError).toBe(true);
      expect((thrown as SearchError).code).toBe("EMBEDDING_DISABLED");
      expect(server.callCount()).toBe(0);
    } finally {
      restoreConsentEnv();
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
      fDeclined.cleanup();
      fActive.cleanup();
      await server.close();
    }
  });

  test("a caller that resolved a named config reads the consent from that file, not the ambient default", async () => {
    // `resolveConfiguredEmbeddingProvider` resolves the semantic
    // configuration from the config file it was handed. The consent that
    // gates construction must come from the SAME file: a decline written
    // in some other file the process happens to default to is not a
    // decision about this configuration, and reading it here let one
    // file's decline silently disable a provider another file enabled.
    const server: FakeHttp = await startFakeHttp();
    const fNamed = fixture("named-consent");
    const fAmbient = fixture("ambient-decline");
    const saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const restoreConsentEnv = saveAndClearConsentEnv();
    try {
      writeFileSync(
        fNamed.configPath,
        "search_semantic_enabled: true\n" +
          "embedding_provider: openai-compat\n" +
          `embedding_base_url: ${server.url}\n` +
          "embedding_model: fake-model\n" +
          `embedding_api_key: ${FAKE_PROVIDER_KEY}\n` +
          "embedding_dimension: 4\n",
      );
      writeFileSync(fAmbient.configPath, "search_semantic_enabled: false\n");
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = fAmbient.configPath;
      const provider = resolveConfiguredEmbeddingProvider(fNamed.dir, {
        configPath: fNamed.configPath,
      });
      expect(provider !== null).toBe(true);
      expect(providerProducesVectors(provider!)).toBe(true);
      expect(server.callCount()).toBe(0);
    } finally {
      restoreConsentEnv();
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
      fNamed.cleanup();
      fAmbient.cleanup();
      await server.close();
    }
  });

  test("a configuration that records no decision builds the provider exactly as before", async () => {
    const server: FakeHttp = await startFakeHttp();
    const f = fixture("decline-unset");
    try {
      writeFileSync(f.configPath, 'vault: "/tmp/v"\n');
      const semantic = liveSemantic(server.url);
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {}, semantic });
      // No refusal, and the provider is the one this tree has always
      // built for this configuration: same name, same model, same
      // dimension, and it produces vectors.
      const provider = makeProvider(semantic, consent);
      expect(provider.name).toBe("openai-compat");
      expect(provider.model).toBe("fake-model");
      expect(provider.dimension).toBe(4);
      expect(providerProducesVectors(provider)).toBe(true);
      expect(server.callCount()).toBe(0);
    } finally {
      f.cleanup();
      await server.close();
    }
  });
});

describe("the decline on a query-time embed request", () => {
  test("an explicit request is refused by name", async () => {
    const f = fixture("decline-explicit");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      const config = searchConfig(f.configPath, liveSemantic("http://127.0.0.1:9"));
      let thrown: unknown;
      try {
        await runSemanticPhase(readyStore(), config, "q", {
          limit: 10,
          pathPrefix: undefined,
          explicit: true,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown instanceof SearchError).toBe(true);
      expect((thrown as SearchError).code).toBe("EMBEDDING_DISABLED");
      for (const key of PROVIDER_CONSENT_REENABLE_KEYS) {
        expect((thrown as SearchError).message).toContain(key);
      }
    } finally {
      f.cleanup();
    }
  });

  test("an implicit request degrades with the decline named, not with a bare 'disabled'", async () => {
    const f = fixture("decline-implicit");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      const config = searchConfig(f.configPath, liveSemantic("http://127.0.0.1:9"));
      const outcome = await runSemanticPhase(readyStore(), config, "q", {
        limit: 10,
        pathPrefix: undefined,
        explicit: false,
      });
      expect(outcome.attempted).toBe(false);
      expect(outcome.warnings.length).toBe(1);
      for (const key of PROVIDER_CONSENT_REENABLE_KEYS) {
        expect(outcome.warnings[0]).toContain(key);
      }
    } finally {
      f.cleanup();
    }
  });

  test("a configuration that records no decision keeps the existing behaviour", async () => {
    const f = fixture("decline-unset-phase");
    try {
      writeFileSync(f.configPath, 'vault: "/tmp/v"\n');
      // The switch is off and no provider is named: the capability tier
      // answers, exactly as it did before this feature existed.
      const config = searchConfig(f.configPath, {
        enabled: false,
        provider: "openai-compat",
        baseUrl: null,
        model: null,
        apiKey: null,
        dimension: null,
        timeoutMs: 10_000,
        concurrency: 4,
        batchSize: 32,
        costGateUsd: 0,
        maxRetries: 3,
      });
      const outcome = await runSemanticPhase(readyStore(), config, "q", {
        limit: 10,
        pathPrefix: undefined,
        explicit: false,
      });
      expect(outcome.attempted).toBe(false);
      expect(outcome.warnings.length).toBe(1);
      // The registry sentence, not a sentence assembled at the call site.
      expect(outcome.warnings[0]).toBe(
        "semantic search not configured (disabled by config or provider)",
      );
    } finally {
      f.cleanup();
    }
  });
});
