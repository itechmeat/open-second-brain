import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSecret } from "../../../src/core/brain/secrets/store.ts";
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
const ENV_PROBE_KEY = fakeCredential("env-", "probe-2e77");
const PROBE_NOW = new Date("2026-06-05T10:00:00Z");
/** The fixture profile, pointed at the probe name the store entry uses. */
const probeProfile = { ...nim, envKey: "embed_key" };

function storeProbeKey(name = "embed_key"): void {
  setSecret(vault, { name, value: STORED_PROBE_KEY, agent: "tester", now: PROBE_NOW });
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
    [{ ...nim, envKey: "$secret:embed_key" }],
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
      [{ ...nim, envKey: "$secret:absent_name" }],
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
