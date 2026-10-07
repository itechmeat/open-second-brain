/**
 * Credential-source report for `search check` (t_82c3b275, task 8).
 *
 * The defect pinned here: a `credential-missing` tier told the operator
 * that no key resolved, and nothing more. It did not say WHERE it had
 * looked, so an operator whose key sat under a registered profile's env
 * name - or under the wrong one - had to read the resolver to find out.
 * The report names the sources consulted, in probe order, and the other
 * registered profiles whose env key is present. Names only: a value is
 * tested for presence and never copied anywhere.
 *
 * Covered: the explicit-config arm, the registry-profile arm (single
 * key and probe list), the present-elsewhere list, the silence of every
 * non-blocked or disabled tier, and a sweep proving no env value reaches
 * the report.
 *
 * Deliberately not covered: the tier itself (`resolveSemanticCapability`
 * is unchanged and has its own suite) and the rendering in `search
 * check`, which `tests/cli/search-check-provider.test.ts` pins.
 */

import { describe, expect, test } from "bun:test";

import {
  describeCredentialSources,
  EXPLICIT_CREDENTIAL_SOURCES,
} from "../../../src/core/search/embeddings/credential-report.ts";
import type { ProviderProfile } from "../../../src/core/search/embeddings/registry.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { fakeCredential } from "../../helpers/fake-credentials.ts";

const ACTIVE_PROFILE = "acme-embed";
const ACTIVE_ENV_KEYS = ["ACME_EMBED_KEY_PRIMARY", "ACME_EMBED_KEY_FALLBACK"] as const;
const OTHER_PRESENT_PROFILE = "beta-embed";
const OTHER_PRESENT_ENV_KEY = "BETA_EMBED_KEY";
const OTHER_ABSENT_PROFILE = "gamma-embed";
const OTHER_ABSENT_ENV_KEY = "GAMMA_EMBED_KEY";
const OTHER_LIST_PROFILE = "delta-embed";
const OTHER_LIST_ENV_KEYS = ["DELTA_EMBED_KEY_ONE", "DELTA_EMBED_KEY_TWO"] as const;

/** Credential-shaped placeholders: every one must stay out of the report. */
const PRIVATE_BODY_BETA = fakeCredential("beta", "-private-", "4c1d");
const PRIVATE_BODY_DELTA = fakeCredential("delta", "-private-", "77ae");

const REGISTRY: ReadonlyArray<ProviderProfile> = Object.freeze([
  {
    name: ACTIVE_PROFILE,
    baseUrl: "https://acme.invalid/v1",
    defaultModel: "acme-1",
    envKey: ACTIVE_ENV_KEYS,
  },
  {
    name: OTHER_PRESENT_PROFILE,
    baseUrl: "https://beta.invalid/v1",
    defaultModel: "beta-1",
    envKey: OTHER_PRESENT_ENV_KEY,
  },
  {
    name: OTHER_ABSENT_PROFILE,
    baseUrl: "https://gamma.invalid/v1",
    defaultModel: "gamma-1",
    envKey: OTHER_ABSENT_ENV_KEY,
  },
  {
    name: OTHER_LIST_PROFILE,
    baseUrl: "https://delta.invalid/v1",
    defaultModel: "delta-1",
    envKey: OTHER_LIST_ENV_KEYS,
  },
]);

const ENV_WITH_OTHER_KEYS: Readonly<Record<string, string | undefined>> = Object.freeze({
  [OTHER_PRESENT_ENV_KEY]: PRIVATE_BODY_BETA,
  [OTHER_ABSENT_ENV_KEY]: "",
  [OTHER_LIST_ENV_KEYS[1]]: PRIVATE_BODY_DELTA,
});

function semantic(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: "https://acme.invalid/v1",
    model: "acme-1",
    apiKey: null,
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 4,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

describe("describeCredentialSources", () => {
  test("explicit config consults the env override, then the config key", () => {
    const report = describeCredentialSources({
      semantic: semantic(),
      activeProfile: null,
      registry: REGISTRY,
      env: {},
    });
    expect(report).toEqual({
      consulted: ["OPEN_SECOND_BRAIN_EMBEDDING_KEY", "embedding_api_key"],
      presentElsewhere: [],
    });
    expect(report?.consulted).toEqual([...EXPLICIT_CREDENTIAL_SOURCES]);
  });

  test("a registry profile adds its env-key names in probe order", () => {
    const report = describeCredentialSources({
      semantic: semantic(),
      activeProfile: ACTIVE_PROFILE,
      registry: REGISTRY,
      env: {},
    });
    expect(report?.consulted).toEqual([...EXPLICIT_CREDENTIAL_SOURCES, ...ACTIVE_ENV_KEYS]);
  });

  test("other registered profiles whose env key is present are listed by name, in registry order", () => {
    const report = describeCredentialSources({
      semantic: semantic(),
      activeProfile: ACTIVE_PROFILE,
      registry: REGISTRY,
      env: ENV_WITH_OTHER_KEYS,
    });
    expect(report?.presentElsewhere).toEqual([OTHER_PRESENT_PROFILE, OTHER_LIST_PROFILE]);
  });

  test("explicit config lists every registered profile with a present key", () => {
    const report = describeCredentialSources({
      semantic: semantic(),
      activeProfile: null,
      registry: REGISTRY,
      env: { ...ENV_WITH_OTHER_KEYS, [ACTIVE_ENV_KEYS[0]]: PRIVATE_BODY_BETA },
    });
    expect(report?.presentElsewhere).toEqual([
      ACTIVE_PROFILE,
      OTHER_PRESENT_PROFILE,
      OTHER_LIST_PROFILE,
    ]);
  });

  test("no env value ever reaches the report", () => {
    const report = describeCredentialSources({
      semantic: semantic(),
      activeProfile: ACTIVE_PROFILE,
      registry: REGISTRY,
      env: ENV_WITH_OTHER_KEYS,
    });
    const serialized = JSON.stringify(report);
    for (const privateBody of [PRIVATE_BODY_BETA, PRIVATE_BODY_DELTA]) {
      expect(serialized).not.toContain(privateBody);
    }
  });

  test("a configured tier reports nothing", () => {
    expect(
      describeCredentialSources({
        semantic: semantic({ apiKey: PRIVATE_BODY_BETA }),
        activeProfile: null,
        registry: REGISTRY,
        env: ENV_WITH_OTHER_KEYS,
      }),
    ).toBeNull();
  });

  test("the keyless local provider reports nothing", () => {
    expect(
      describeCredentialSources({
        semantic: semantic({ provider: "local" }),
        activeProfile: null,
        registry: REGISTRY,
        env: {},
      }),
    ).toBeNull();
  });

  test("a disabled tier reports nothing", () => {
    expect(
      describeCredentialSources({
        semantic: semantic({ enabled: false }),
        activeProfile: null,
        registry: REGISTRY,
        env: {},
      }),
    ).toBeNull();
  });

  test("a named profile the registry does not hold is refused by name", () => {
    expect(() =>
      describeCredentialSources({
        semantic: semantic(),
        activeProfile: "missing-profile",
        registry: REGISTRY,
        env: {},
      }),
    ).toThrow(/missing-profile/);
  });
});
