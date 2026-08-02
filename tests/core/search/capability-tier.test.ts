/**
 * The semantic capability tier is resolved ONCE and agreed on by every
 * surface that reports it (provenance-at-the-boundary, unit F).
 *
 * Four sites used to compute "is semantic search configured, and if not
 * why" from the resolved config separately, in four spellings, one of
 * them assembling operator-facing sentences at the call site. This file
 * drives all four against one config matrix and requires them to say the
 * same thing:
 *
 *   1. `runSemanticPhase`            (`search/semantic-phase.ts`)
 *   2. `indexVault().deferredReason` (`search/indexer.ts`)
 *   3. `probeEmbeddingProvider`      (`doctor-readiness.ts`)
 *   4. `indexCheck()`                (`search/indexer.ts`)
 *
 * The second half covers the capability PREDICATE that replaced the
 * `provider.name === "null"` sentinel: a provider whose name is neither
 * of the literals in the tree must be classified by what it declares it
 * can do, never by what it is called.
 *
 * No test here reaches the network. The one configuration that needs an
 * embedding endpoint points at the loopback fake server the search
 * fixtures already ship, and `probeEmbeddingProvider` is deliberately
 * driven only on configurations it cannot make an outbound call for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSemanticCapability,
  SEMANTIC_CAPABILITY_CODE,
  SEMANTIC_CAPABILITY_TIER,
  semanticCapabilityIsBlocked,
  semanticCapabilityLabel,
  SEMANTIC_VECTOR_CODE,
} from "../../../src/core/search/capability-tier.ts";
import {
  providerProducesVectors,
  type EmbeddingProvider,
} from "../../../src/core/search/embeddings/contract.ts";
import { NullProvider } from "../../../src/core/search/embeddings/null-provider.ts";
import { indexCheck, indexVault } from "../../../src/core/search/indexer.ts";
import { runSemanticPhase } from "../../../src/core/search/semantic-phase.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { probeEmbeddingProvider } from "../../../src/core/doctor-readiness.ts";
import { resolveNextStep } from "../../../src/core/brain/next-step.ts";
import { detectSemanticDedup } from "../../../src/core/brain/hygiene/detectors/dedup.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

/** An endpoint nothing listens on; used where no call may be made. */
const REFUSED_ENDPOINT = "http://127.0.0.1:9";

/**
 * Whether `sqlite-vec` loaded in THIS process, resolved once at module
 * load. Only the `runSemanticPhase` test needs it - that arm requires a
 * store that really holds vectors - and it is declared with `skipIf` so a
 * missing extension is REPORTED as a skip rather than returning before
 * its first assertion and reading as a pass.
 */
const VEC_LOADABLE = sqliteVecLoadable();

/**
 * Set only on a platform that genuinely cannot load `sqlite-vec`. Absent
 * - the default, and what CI runs - an unloadable extension is a FAULT,
 * not a platform fact, and the loadability guard below turns this file
 * red instead of letting the fourth site's coverage disappear silently.
 */
const ALLOW_MISSING_VEC_ENV = "O2B_ALLOW_MISSING_SQLITE_VEC";

/** Whether this environment has declared the extension optional. */
const VEC_DECLARED_OPTIONAL = process.env[ALLOW_MISSING_VEC_ENV] !== undefined;

/** How many of the five variants are blocked, and so measurable below. */
const BLOCKED_VARIANT_COUNT = 3;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("capability-tier");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

interface Variant {
  readonly label: string;
  readonly semantic: Partial<ResolvedEmbeddingConfig>;
  readonly tier: string;
}

/** The configurations the tier ladder must distinguish. */
function semanticVariants(baseUrl: string): ReadonlyArray<Variant> {
  return [
    { label: "disabled", semantic: { enabled: false }, tier: SEMANTIC_CAPABILITY_TIER.disabled },
    {
      label: "provider disabled while enabled",
      semantic: { enabled: true, provider: "disabled" },
      tier: SEMANTIC_CAPABILITY_TIER.disabled,
    },
    {
      label: "remote provider, no key",
      semantic: { enabled: true, provider: "openai-compat", apiKey: null },
      tier: SEMANTIC_CAPABILITY_TIER.credentialMissing,
    },
    {
      label: "local provider needs no key",
      semantic: { enabled: true, provider: "local", apiKey: null, dimension: 4 },
      tier: SEMANTIC_CAPABILITY_TIER.configured,
    },
    {
      label: "remote provider with a key",
      semantic: {
        enabled: true,
        provider: "openai-compat",
        baseUrl,
        model: "fake-model",
        apiKey: "test-key",
        dimension: 4,
      },
      tier: SEMANTIC_CAPABILITY_TIER.configured,
    },
  ];
}

describe("the tier resolver", () => {
  test("classifies each configuration into exactly one tier", () => {
    for (const variant of semanticVariants(REFUSED_ENDPOINT)) {
      const cfg = makeConfig({ vault, dbPath, semantic: variant.semantic });
      expect(`${variant.label}: ${resolveSemanticCapability(cfg.semantic).tier}`).toBe(
        `${variant.label}: ${variant.tier}`,
      );
    }
  });

  test("every code the resolver can produce is registered on the advisory rail", async () => {
    const codes = [
      ...Object.values(SEMANTIC_CAPABILITY_CODE),
      ...Object.values(SEMANTIC_VECTOR_CODE),
    ];
    expect(codes.length).toBeGreaterThan(4);
    for (const code of codes) {
      expect(`${code} registered: ${resolveNextStep(code) !== null}`).toBe(
        `${code} registered: true`,
      );
      // The label a surface renders is the registry's, never a sentence
      // assembled beside the call.
      expect(await semanticCapabilityLabel(code)).toBe(resolveNextStep(code)!.issueClass);
    }
  });

  test("only the configured tier is unblocked", () => {
    for (const variant of semanticVariants(REFUSED_ENDPOINT)) {
      const cfg = makeConfig({ vault, dbPath, semantic: variant.semantic });
      const capability = resolveSemanticCapability(cfg.semantic);
      expect(`${variant.label}: ${semanticCapabilityIsBlocked(capability)}`).toBe(
        `${variant.label}: ${variant.tier !== SEMANTIC_CAPABILITY_TIER.configured}`,
      );
    }
  });
});

describe("the four sites agree with the resolver", () => {
  test("indexVault's deferred reason is the registry label for the resolved tier", async () => {
    for (const variant of semanticVariants(REFUSED_ENDPOINT)) {
      const v = createTempVault("capability-defer");
      try {
        writeMd(v.vault, "a.md", "# A\n\nFirst note about something.");
        const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath, semantic: variant.semantic });
        const stats = await indexVault(cfg);
        const capability = resolveSemanticCapability(cfg.semantic);
        // Configured-but-not-asked-for is its own registered state, not a
        // capability fault.
        const expected = semanticCapabilityIsBlocked(capability)
          ? await semanticCapabilityLabel(capability.code)
          : await semanticCapabilityLabel(SEMANTIC_VECTOR_CODE.deferred);
        expect(`${variant.label}: ${stats.deferredReason}`).toBe(`${variant.label}: ${expected}`);
      } finally {
        v.cleanup();
      }
    }
  });

  test("indexCheck reports the key as resolved exactly on the configured tier", async () => {
    for (const variant of semanticVariants(REFUSED_ENDPOINT)) {
      // A remote provider with a key would ping; the refused base URL
      // keeps that on loopback and off the network.
      const cfg = makeConfig({
        vault,
        dbPath,
        semantic: { ...variant.semantic, baseUrl: REFUSED_ENDPOINT },
      });
      const report = await indexCheck(cfg);
      expect(`${variant.label}: ${report.embeddingKeyResolved}`).toBe(
        `${variant.label}: ${variant.tier === SEMANTIC_CAPABILITY_TIER.configured}`,
      );
    }
  });

  test("probeEmbeddingProvider skips exactly the blocked tiers", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-capability-probe-"));
    const configPath = join(tmp, "config.yaml");
    const envKeys = [
      "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
      "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
      "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
      "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
      "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
      "OPEN_SECOND_BRAIN_EMBEDDING_DIM",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      // Only configurations that cannot make an outbound call: disabled
      // (no provider at all), key-missing (which must be refused BEFORE
      // any ping), and the offline local provider.
      const cases = [
        { body: "", tier: SEMANTIC_CAPABILITY_TIER.disabled },
        {
          body: "search_semantic_enabled: true\nembedding_provider: openai-compat\n",
          tier: SEMANTIC_CAPABILITY_TIER.credentialMissing,
        },
        {
          body: "search_semantic_enabled: true\nembedding_provider: local\n",
          tier: SEMANTIC_CAPABILITY_TIER.configured,
        },
      ];
      for (const c of cases) {
        writeFileSync(configPath, `vault: "${tmp}"\n${c.body}`);
        const verdict = await probeEmbeddingProvider({ vault: tmp, config: configPath });
        const blocked = c.tier !== SEMANTIC_CAPABILITY_TIER.configured;
        expect(`${c.tier}: ${verdict.status === "skipped"}`).toBe(`${c.tier}: ${blocked}`);
      }
    } finally {
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(VEC_DECLARED_OPTIONAL)(
    "the vector extension the runSemanticPhase arm depends on is loadable",
    () => {
      expect(VEC_LOADABLE).toBe(true);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "runSemanticPhase degrades with the registry label for the resolved tier",
    async () => {
      const server: FakeHttp = await startFakeHttp();
      try {
        writeMd(vault, "a.md", "# A\n\nFirst note about something.");
        const indexed = makeConfig({
          vault,
          dbPath,
          semantic: {
            enabled: true,
            provider: "openai-compat",
            baseUrl: server.url,
            model: "fake-model",
            apiKey: "test-key",
            dimension: 4,
            timeoutMs: 5_000,
          },
        });
        // A store that HAS vectors and HAS the extension, so the runtime
        // guards pass and what is measured is the config-derived arm.
        await indexVault(indexed, { embeddings: true });
        const store = await Store.open(indexed, { mode: "read" });
        try {
          expect(store.counts().embeddings).toBeGreaterThan(0);
          let measured = 0;
          for (const variant of semanticVariants(server.url)) {
            const cfg = makeConfig({ vault, dbPath, semantic: variant.semantic });
            const capability = resolveSemanticCapability(cfg.semantic);
            if (!semanticCapabilityIsBlocked(capability)) continue;
            measured++;
            const outcome = await runSemanticPhase(store, cfg, "something", {
              limit: 5,
              pathPrefix: undefined,
              explicit: false,
            });
            expect(`${variant.label}: ${outcome.attempted}`).toBe(`${variant.label}: false`);
            expect(`${variant.label}: ${outcome.warnings.join("|")}`).toBe(
              `${variant.label}: ${await semanticCapabilityLabel(capability.code)}`,
            );
          }
          // A loop that measured nothing would report agreement over an
          // empty set.
          expect(measured).toBe(BLOCKED_VARIANT_COUNT);
        } finally {
          await store.close();
        }
      } finally {
        await server.close();
      }
    },
  );
});

/**
 * A provider whose name is neither `null` nor any name this tree ships.
 * It DECLARES that it produces no vectors while still returning some, so
 * a site that honours the declaration falls back and a site that still
 * compares names does not - which is exactly the defect the predicate
 * removes.
 */
class SentinelNamedProvider implements EmbeddingProvider {
  readonly name = "capability-test-sentinel";
  readonly model = "capability-test-sentinel-model";
  readonly dimension = 3;
  readonly producesVectors = false;
  calls = 0;

  embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    this.calls++;
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  }

  async ping(): Promise<{ ok: true; dimension: number }> {
    return { ok: true, dimension: 3 };
  }
}

/** A real provider that declares nothing: the default must be "it embeds". */
class UndeclaredProvider implements EmbeddingProvider {
  readonly name = "capability-test-working";
  readonly model = "capability-test";
  readonly dimension = 3;

  embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  }

  async ping(): Promise<{ ok: true; dimension: number }> {
    return { ok: true, dimension: 3 };
  }
}

describe("the capability predicate replaces the name sentinel", () => {
  test("classification follows the declaration, not the name", () => {
    expect(providerProducesVectors(new SentinelNamedProvider())).toBe(false);
    expect(providerProducesVectors(new UndeclaredProvider())).toBe(true);
    expect(providerProducesVectors(new NullProvider())).toBe(false);
  });

  test("the semantic dedup detector falls back on a differently-named sentinel", async () => {
    const prefVault = mkdtempSync(join(tmpdir(), "o2b-capability-dedup-"));
    try {
      const dir = join(prefVault, "Brain", "preferences");
      mkdirSync(dir, { recursive: true });
      const writePref = (slug: string, topic: string, principle: string): void => {
        writeFileSync(
          join(dir, `pref-${slug}.md`),
          [
            "---",
            "kind: brain-preference",
            `id: pref-${slug}`,
            "tags: [brain, brain/preference]",
            `topic: ${topic}`,
            "_status: confirmed",
            `principle: ${principle}`,
            "created_at: 2026-01-01T00:00:00Z",
            "unconfirmed_until: 2026-01-15T00:00:00Z",
            "---",
            "",
          ].join("\n"),
          "utf8",
        );
      };
      writePref("a", "writing-style", "Never use exclamation marks in docs");
      writePref("b", "doc-tone", "Do not use exclamation marks in documentation");

      const provider = new SentinelNamedProvider();
      const result = await detectSemanticDedup(prefVault, { provider });
      // Under the old `provider.name === "null"` sentinel this provider
      // passed the guard, embedded both principles, and the report read
      // `embedding`.
      expect(result.method).toBe("lexical");
      expect(provider.calls).toBe(0);
    } finally {
      rmSync(prefVault, { recursive: true, force: true });
    }
  });
});
