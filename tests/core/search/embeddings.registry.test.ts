import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSecret, secretsDir } from "../../../src/core/brain/secrets/store.ts";
import { loadOrCreateKey } from "../../../src/core/brain/secrets/crypto.ts";
import {
  clearHeldKey,
  wrapKeyfile,
  SecretStoreKeyfileMissingError,
  SecretStoreLockedError,
} from "../../../src/core/brain/secrets/envelope.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import {
  loadProviderRegistry,
  addProviderProfile,
  removeProviderProfile,
  getProviderProfile,
  expandRegisteredProvider,
  providerRegistryPath,
  RESERVED_PROVIDER_NAMES,
} from "../../../src/core/search/embeddings/registry.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { SecretReferenceError } from "../../../src/core/secret-ref.ts";
import { fakeCredential } from "../../helpers/fake-credentials.ts";

const NIM_KEY = fakeCredential("secret-", "123");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-registry-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const nim = {
  name: "nvidia-nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  defaultModel: "nvidia/nv-embed-v1",
  envKey: "NIM_API_KEY",
};

test("empty vault has an empty registry", () => {
  expect(loadProviderRegistry(vault)).toEqual([]);
});

test("add -> list -> get -> remove round-trips a profile", () => {
  const after = addProviderProfile(vault, nim);
  expect(after).toHaveLength(1);
  expect(loadProviderRegistry(vault)).toHaveLength(1);
  expect(getProviderProfile(vault, "nvidia-nim")).toMatchObject(nim);

  const { removed, registry } = removeProviderProfile(vault, "nvidia-nim");
  expect(removed).toBe(true);
  expect(registry).toEqual([]);
  expect(getProviderProfile(vault, "nvidia-nim")).toBeNull();
});

test("registry persists to Brain/search/embedding-providers.json", () => {
  addProviderProfile(vault, nim);
  expect(providerRegistryPath(vault)).toBe(
    join(vault, "Brain", "search", "embedding-providers.json"),
  );
});

test("add upserts an existing name rather than duplicating", () => {
  addProviderProfile(vault, nim);
  const after = addProviderProfile(vault, { ...nim, defaultModel: "nvidia/nv-embed-v2" });
  expect(after).toHaveLength(1);
  expect(getProviderProfile(vault, "nvidia-nim")?.defaultModel).toBe("nvidia/nv-embed-v2");
});

test("reserved built-in names cannot be registered", () => {
  for (const reserved of RESERVED_PROVIDER_NAMES) {
    expect(() => addProviderProfile(vault, { ...nim, name: reserved })).toThrow(SearchError);
  }
});

test("invalid profile fields are rejected", () => {
  expect(() => addProviderProfile(vault, { ...nim, name: "Bad Name" })).toThrow(/name/i);
  expect(() => addProviderProfile(vault, { ...nim, baseUrl: "" })).toThrow(/base/i);
  expect(() => addProviderProfile(vault, { ...nim, defaultModel: "" })).toThrow(/model/i);
  expect(() => addProviderProfile(vault, { ...nim, envKey: "" })).toThrow(/env/i);
});

test("removing an absent profile reports removed:false", () => {
  const { removed } = removeProviderProfile(vault, "ghost");
  expect(removed).toBe(false);
});

test("expandRegisteredProvider resolves to openai-compat with the env key", () => {
  const registry = addProviderProfile(vault, nim);
  const expanded = expandRegisteredProvider("nvidia-nim", registry, { NIM_API_KEY: NIM_KEY });
  expect(expanded).toEqual({
    provider: "openai-compat",
    baseUrl: nim.baseUrl,
    model: nim.defaultModel,
    apiKey: NIM_KEY,
    apiKeys: [NIM_KEY],
  });
});

test("expandRegisteredProvider yields a null apiKey when the env var is unset", () => {
  const registry = addProviderProfile(vault, nim);
  const expanded = expandRegisteredProvider("nvidia-nim", registry, {});
  expect(expanded?.apiKey).toBeNull();
  expect(expanded?.apiKeys).toEqual([]);
});

test("a profile envKey may be an ordered probe list; the first present key wins", () => {
  const registry = addProviderProfile(vault, {
    ...nim,
    envKey: ["NIM_PRIMARY", "NIM_SECONDARY", "NIM_TERTIARY"],
  });
  // primary unset, secondary + tertiary set -> secondary wins, tertiary is the fallback.
  const expanded = expandRegisteredProvider("nvidia-nim", registry, {
    NIM_SECONDARY: "key-b",
    NIM_TERTIARY: "key-c",
  });
  expect(expanded?.apiKey).toBe("key-b");
  expect(expanded?.apiKeys).toEqual(["key-b", "key-c"]);
});

test("probe-list profiles round-trip through the registry file", () => {
  addProviderProfile(vault, { ...nim, envKey: ["A_KEY", "B_KEY"] });
  const loaded = getProviderProfile(vault, "nvidia-nim");
  expect(loaded?.envKey).toEqual(["A_KEY", "B_KEY"]);
});

test("an empty probe list is rejected", () => {
  expect(() => addProviderProfile(vault, { ...nim, envKey: [] })).toThrow(/env/i);
  expect(() => addProviderProfile(vault, { ...nim, envKey: ["  "] })).toThrow(/env/i);
});

test("expandRegisteredProvider returns null for an unknown name", () => {
  expect(expandRegisteredProvider("missing", [], {})).toBeNull();
});

test("a malformed registry file degrades to empty, never throws", () => {
  mkdirSync(join(vault, "Brain", "search"), { recursive: true });
  writeFileSync(providerRegistryPath(vault), "{ not json");
  expect(loadProviderRegistry(vault)).toEqual([]);
});

// ----- Custody-store probing (trust-surface-hardening, t_e5807974 / B2) ------
//
// The probe map is the merged provider: a name the custody store holds
// answers ahead of the environment, and a probe entry written as a
// `$secret:NAME` reference resolves through the same store. Resolution is
// read-only (no `last_used_at` stamp, no store mutation), and with no
// store entry and no reference the probing is byte-identical to the
// plain-env behavior.

const STORED_PROBE_KEY = fakeCredential("stored-", "probe-8d31");
const EMBED_KEY_REF = "$secret:embed_key";
const ABSENT_EMBED_REF = "$secret:absent_name";
const SPACED_EMBED_REF = "$secret:has space";
const ENV_PROBE_KEY = fakeCredential("env-", "probe-2e77");
const LOCK_PASSPHRASE = fakeCredential("registry-wrap-", "phrase-71bd");
const PROBE_NOW = new Date("2026-06-05T10:00:00Z");
/** The fixture profile, pointed at the probe name the store entry uses. */
const probeProfile = { ...nim, envKey: "embed_key" };

function storeProbeKey(name = "embed_key"): void {
  setSecret(vault, { name, value: STORED_PROBE_KEY, agent: "tester", now: PROBE_NOW });
}

/** A machine config selecting `provider`, so the resolver expands the registry. */
function configWithProvider(provider: string, extra = ""): string {
  const configPath = join(vault, "machine-config.yaml");
  writeFileSync(configPath, `embedding_provider: "${provider}"\n${extra}`, "utf8");
  return configPath;
}

function withEnvKey(name: string, value: string, run: () => void): void {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("a store-held probe name answers ahead of the environment", () => {
  storeProbeKey();
  withEnvKey("embed_key", ENV_PROBE_KEY, () => {
    const expanded = expandRegisteredProvider("nvidia-nim", [probeProfile], process.env, {
      secretsVault: vault,
    });
    expect(expanded?.apiKey).toBe(STORED_PROBE_KEY);
    expect(expanded?.apiKeys).toEqual([STORED_PROBE_KEY]);
  });
});

test("a probe entry written as a reference resolves through the store", () => {
  storeProbeKey();
  const expanded = expandRegisteredProvider(
    "nvidia-nim",
    [{ ...nim, envKey: EMBED_KEY_REF }],
    {},
    { secretsVault: vault },
  );
  expect(expanded?.apiKey).toBe(STORED_PROBE_KEY);
});

test("plain env probing is byte-identical with and without a custody vault", () => {
  withEnvKey("embed_key", ENV_PROBE_KEY, () => {
    const plain = expandRegisteredProvider("nvidia-nim", [probeProfile], process.env);
    const routed = expandRegisteredProvider("nvidia-nim", [probeProfile], process.env, {
      secretsVault: vault,
    });
    expect(routed).toEqual(plain);
    expect(routed?.apiKey).toBe(ENV_PROBE_KEY);
  });
});

test("an unresolvable reference probe surfaces the named resolver error", () => {
  expect(() =>
    expandRegisteredProvider(
      "nvidia-nim",
      [{ ...nim, envKey: ABSENT_EMBED_REF }],
      {},
      { secretsVault: vault },
    ),
  ).toThrow(SecretReferenceError);
});

test("resolution through the probe does not mutate the custody store", () => {
  storeProbeKey();
  const storePath = join(vault, ".open-second-brain", "secrets", "secrets.json");
  const before = readFileSync(storePath, "utf8");
  expandRegisteredProvider("nvidia-nim", [probeProfile], process.env, { secretsVault: vault });
  expect(readFileSync(storePath, "utf8")).toBe(before);
});

// ----- The search config resolver joins the custody store (t_e5807974) -------
//
// `resolveRegistryProvider` hands `expandRegisteredProvider` the vault, so
// a registered `embedding_provider` resolves its key through
// `resolveSearchConfig` itself - not only when the registry module is
// called directly.

describe("resolveSearchConfig probes a registered provider through the store", () => {
  test("a store-held key name answers through the full config resolution", () => {
    addProviderProfile(vault, probeProfile);
    storeProbeKey();
    // An env value under the same name makes the precedence claim, not
    // just the resolution claim: the store answers ahead of the
    // environment through the full config resolution too.
    withEnvKey("embed_key", ENV_PROBE_KEY, () => {
      const cfg = resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") });
      expect(cfg.semantic.provider).toBe("openai-compat");
      expect(cfg.semantic.apiKey).toBe(STORED_PROBE_KEY);
      expect(cfg.semantic.apiKeys).toEqual([STORED_PROBE_KEY]);
    });
  });

  test("a reference-shaped envKey resolves through the full config resolution", () => {
    addProviderProfile(vault, { ...probeProfile, envKey: EMBED_KEY_REF });
    storeProbeKey();
    const cfg = resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") });
    expect(cfg.semantic.apiKey).toBe(STORED_PROBE_KEY);
  });

  test("a plain env key resolves identically through the vault-joined probe", () => {
    addProviderProfile(vault, probeProfile);
    withEnvKey("embed_key", ENV_PROBE_KEY, () => {
      const cfg = resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") });
      expect(cfg.semantic.apiKey).toBe(ENV_PROBE_KEY);
    });
  });

  test("a locked store behind the probe surfaces the named locked error, not 'not a registered provider'", () => {
    // The swallowing catch used to convert the resolver's named refusal
    // into a null expansion, so `parseProvider` then claimed the name was
    // not registered - for a name that IS registered, with the remedy
    // (fix the provider name) pointing the wrong way.
    addProviderProfile(vault, probeProfile);
    storeProbeKey();
    const kp = join(secretsDir(vault), "keyfile");
    wrapKeyfile(kp, LOCK_PASSPHRASE, loadOrCreateKey(kp));
    clearHeldKey(kp);
    try {
      expect(() =>
        resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") }),
      ).toThrow(SecretStoreLockedError);
    } finally {
      clearHeldKey(kp);
    }
  });

  test("a malformed reference probe surfaces the named reference error through the full resolution", () => {
    addProviderProfile(vault, { ...probeProfile, envKey: SPACED_EMBED_REF });
    expect(() =>
      resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") }),
    ).toThrow(SecretReferenceError);
  });

  test("a missing keyfile behind the probe surfaces the named refusal, not 'not a registered provider'", () => {
    // The missing-keyfile refusal is the locked refusal's sibling state on
    // the same probe path, so it propagates for the same reason: a
    // fail-soft null here would misreport a registered provider as
    // unregistered, with the remedy pointing the wrong way.
    addProviderProfile(vault, probeProfile);
    storeProbeKey();
    rmSync(join(secretsDir(vault), "keyfile"));
    expect(() =>
      resolveSearchConfig({ vault, configPath: configWithProvider("nvidia-nim") }),
    ).toThrow(SecretStoreKeyfileMissingError);
  });

  test("the explicit embedding_api_key resolves a $secret: reference like its siblings", () => {
    // The explicit key used to pass a reference through verbatim - a
    // dead endpoint auth with nothing naming why - while the registry
    // probe beside it resolved.
    storeProbeKey();
    const cfg = resolveSearchConfig({
      vault,
      configPath: configWithProvider(
        "openai-compat",
        `embedding_base_url: "https://embed.example/v1"\nembedding_api_key: "${EMBED_KEY_REF}"\n`,
      ),
    });
    expect(cfg.semantic.provider).toBe("openai-compat");
    expect(cfg.semantic.apiKey).toBe(STORED_PROBE_KEY);
    expect(cfg.semantic.apiKeys).toEqual([STORED_PROBE_KEY]);
  });

  test("the cross-encoder rerank env key resolves a $secret: reference like its siblings", () => {
    storeProbeKey();
    withEnvKey("rerank_key_var", EMBED_KEY_REF, () => {
      const cfg = resolveSearchConfig({
        vault,
        configPath: configWithProvider(
          "openai-compat",
          `search_rerank_enabled: "true"\nsearch_rerank_env_key: rerank_key_var\n`,
        ),
      });
      expect(cfg.rerank.enabled).toBe(true);
      expect(cfg.rerank.apiKey).toBe(STORED_PROBE_KEY);
    });
  });

  test("a plain explicit and rerank key pass through byte-identically", () => {
    withEnvKey("rerank_key_var", ENV_PROBE_KEY, () => {
      const cfg = resolveSearchConfig({
        vault,
        configPath: configWithProvider(
          "openai-compat",
          `embedding_api_key: "${ENV_PROBE_KEY}"\n` +
            `search_rerank_enabled: "true"\nsearch_rerank_env_key: rerank_key_var\n`,
        ),
      });
      expect(cfg.semantic.apiKey).toBe(ENV_PROBE_KEY);
      expect(cfg.rerank.apiKey).toBe(ENV_PROBE_KEY);
    });
  });
});
