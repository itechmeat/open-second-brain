/**
 * Decision-model config resolution: the feature is active only when it is
 * explicitly enabled AND the named key variable is set; everything else is
 * off, and resolution never throws.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import { setSecret, secretsDir } from "../../../src/core/brain/secrets/store.ts";
import {
  clearHeldKey,
  SecretStoreLockedError,
  wrapKeyfile,
} from "../../../src/core/brain/secrets/envelope.ts";
import { loadOrCreateKey } from "../../../src/core/brain/secrets/crypto.ts";
import { SecretReferenceError } from "../../../src/core/secret-ref.ts";
import { makeDecisionProvider } from "../../../src/core/decision-model/provider.ts";
import { buildDecisionModelCheck } from "../../../src/core/decision-model/diagnostics.ts";
import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import { loadBrainConfigDetailed } from "../../../src/core/brain/policy.ts";
import { startFakeSystemOne } from "../../helpers/fake-decision-provider.ts";
import { FAKE_DECISION_KEY, fakeCredential } from "../../helpers/fake-credentials.ts";

const KEY_VAR = "O2B_TEST_DECISION_MODEL_KEY";
const ENABLED = {
  decision_model_enabled: "true",
  decision_model_provider: "typesafe",
  decision_model_env_key: KEY_VAR,
  decision_model_uses: "rerank:shadow",
};
const WITH_KEY = { [KEY_VAR]: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function vaultWithBrainYaml(yaml: string): string {
  const vault = mkdtempSync(join(tmpdir(), "osb-dm-config-"));
  dirs.push(vault);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), yaml);
  return vault;
}

describe("decision-model config", () => {
  test("no config: disabled, every use off", () => {
    const cfg = resolveDecisionModelConfig({ env: {}, config: {}, vault: null });
    expect(cfg.status).toBe("disabled");
    expect(cfg.errors).toEqual([]);
    expect(decisionModelModeFor(cfg, "rerank")).toBe("off");
  });

  test("a key in the environment without enabling stays disabled", () => {
    const { decision_model_enabled: _, ...rest } = ENABLED;
    const cfg = resolveDecisionModelConfig({ env: WITH_KEY, config: rest, vault: null });
    expect(cfg.status).toBe("disabled");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("off");
  });

  test("enabled without the key variable is no_key, not an error", () => {
    const cfg = resolveDecisionModelConfig({ env: {}, config: ENABLED, vault: null });
    expect(cfg.status).toBe("no_key");
    expect(cfg.errors).toEqual([]);
    expect(cfg.envKey).toBe(KEY_VAR);
    expect(cfg.keyPresent).toBe(false);
    expect(decisionModelModeFor(cfg, "rerank")).toBe("off");
  });

  test("an empty key variable counts as missing", () => {
    const cfg = resolveDecisionModelConfig({
      env: { [KEY_VAR]: "  " } as NodeJS.ProcessEnv,
      config: ENABLED,
      vault: null,
    });
    expect(cfg.status).toBe("no_key");
  });

  test("enabled with the key is active and takes the preset defaults", () => {
    const cfg = resolveDecisionModelConfig({ env: WITH_KEY, config: ENABLED, vault: null });
    expect(cfg.status).toBe("active");
    expect(cfg.baseUrl).toBe("https://api.typesafe.ai");
    expect(cfg.model).toBe("jev-1.13.0");
    expect(cfg.timeoutMs).toBe(3000);
    expect(cfg.dailyCostGateUsd).toBe(0.5);
    expect(decisionModelModeFor(cfg, "rerank")).toBe("shadow");
    expect(decisionModelModeFor(cfg, "skills")).toBe("off");
    // The key itself is never part of the resolved config.
    expect(JSON.stringify(cfg)).not.toContain(FAKE_DECISION_KEY);
  });

  test("the preset's default key variable name is used when none is configured", () => {
    const { decision_model_env_key: _, ...rest } = ENABLED;
    const cfg = resolveDecisionModelConfig({ env: {}, config: rest, vault: null });
    expect(cfg.envKey).toBe("TYPESAFE_API_KEY");
  });

  test("environment overrides win over the config file", () => {
    const cfg = resolveDecisionModelConfig({
      env: {
        ...WITH_KEY,
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "rerank:enforce",
        OPEN_SECOND_BRAIN_DECISION_MODEL_TIMEOUT_MS: "1500",
      } as NodeJS.ProcessEnv,
      config: ENABLED,
      vault: null,
    });
    expect(cfg.uses.rerank).toBe("enforce");
    expect(cfg.timeoutMs).toBe(1500);
  });

  test("invalid values are errors naming the key, and the status is invalid (off)", () => {
    const cfg = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: {
        ...ENABLED,
        decision_model_uses: "rerank:loud,nope:shadow",
        decision_model_timeout_ms: "soon",
        decision_model_cost_gate_usd: "-1",
      },
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("off");
    const all = cfg.errors.join("\n");
    expect(all).toContain("decision_model_uses");
    expect(all).toContain("'nope'");
    expect(all).toContain("decision_model_timeout_ms");
    expect(all).toContain("decision_model_cost_gate_usd");
  });

  test("an unknown provider and a moving model alias are refused", () => {
    const unknown = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: { ...ENABLED, decision_model_provider: "somewhere" },
      vault: null,
    });
    expect(unknown.status).toBe("invalid");
    expect(unknown.errors.join()).toContain("decision_model_provider");
    const alias = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: { ...ENABLED, decision_model_id: "jev-latest" },
      vault: null,
    });
    expect(alias.status).toBe("invalid");
    expect(alias.errors.join()).toContain("decision_model_id");
  });

  test("compatible needs a base URL and a model id", () => {
    const cfg = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: { ...ENABLED, decision_model_provider: "compatible" },
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join()).toContain("decision_model_base_url is required");
    expect(cfg.errors.join()).toContain("decision_model_id is required");
  });

  test("plain http to a remote host is refused unless the operator opts out", () => {
    const base = {
      ...ENABLED,
      decision_model_provider: "compatible",
      decision_model_base_url: "http://decisions.example.com",
      decision_model_id: "m-1",
    };
    const refused = resolveDecisionModelConfig({ env: WITH_KEY, config: base, vault: null });
    expect(refused.status).toBe("invalid");
    expect(refused.errors.join()).toContain("decision_model_allow_insecure_http");
    const loopback = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: { ...base, decision_model_base_url: "http://127.0.0.1:8080" },
      vault: null,
    });
    expect(loopback.status).toBe("active");
  });

  test("an env_key that is not a variable name is invalid and never repeated", () => {
    const pasted = FAKE_DECISION_KEY;
    const cfg = resolveDecisionModelConfig({
      env: { [pasted]: "x" } as NodeJS.ProcessEnv,
      config: { ...ENABLED, decision_model_env_key: pasted },
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.envKey).toBeNull();
    expect(cfg.keyPresent).toBe(false);
    expect(cfg.errors.join()).toContain("decision_model_env_key must be the NAME");
    expect(JSON.stringify(cfg)).not.toContain(pasted);
  });

  test("a base_url with user:password@ is invalid and printed without them", () => {
    const cfg = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: {
        ...ENABLED,
        decision_model_provider: "compatible",
        decision_model_id: "m-1",
        decision_model_base_url: "https://someone:hunter22@decisions.example.com/api",
      },
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join()).toContain("must not carry user:password@");
    expect(cfg.baseUrl).toBe("https://decisions.example.com/api");
    expect(JSON.stringify(cfg)).not.toContain("hunter22");
  });

  test("a disabled config still reports the uses it would run", () => {
    const { decision_model_enabled: _, ...notEnabled } = ENABLED;
    const cfg = resolveDecisionModelConfig({ env: WITH_KEY, config: notEnabled, vault: null });
    expect(cfg.status).toBe("disabled");
    expect(cfg.uses.rerank).toBe("off");
    expect(cfg.configuredUses.rerank).toBe("shadow");
  });

  test("max_state_tokens is clamped to the preset maximum", () => {
    const cfg = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: { ...ENABLED, decision_model_max_state_tokens: "100000" },
      vault: null,
    });
    expect(cfg.maxStateTokens).toBe(32_000);
    expect(cfg.notes.join()).toContain("clamped");
  });
});

describe("vault opt-out", () => {
  test("decision_model: { enabled: false } in _brain.yaml disables every use", () => {
    const vault = vaultWithBrainYaml("schema_version: 1\ndecision_model:\n  enabled: false\n");
    const cfg = resolveDecisionModelConfig({ env: WITH_KEY, config: ENABLED, vault });
    expect(cfg.status).toBe("disabled_by_vault");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("off");
  });

  test("a vault cannot enable, add uses or change the endpoint", () => {
    const vault = vaultWithBrainYaml(
      "schema_version: 1\ndecision_model:\n  enabled: true\n  uses: rerank:enforce\n" +
        "  base_url: https://elsewhere.example.com\n",
    );
    const { warnings, config } = loadBrainConfigDetailed(vault);
    expect(config.decision_model).toEqual({});
    const text = warnings.map((w) => w.message).join("\n");
    expect(text).toContain("decision_model.enabled: true ignored");
    expect(text).toContain("decision_model.uses");
    expect(text).toContain("decision_model.base_url");
    // The machine config is what decides; the vault widened nothing.
    const off = resolveDecisionModelConfig({ env: {}, config: {}, vault });
    expect(off.status).toBe("disabled");
    const on = resolveDecisionModelConfig({ env: WITH_KEY, config: ENABLED, vault });
    expect(on.status).toBe("active");
    expect(on.baseUrl).toBe("https://api.typesafe.ai");
    expect(on.uses.rerank).toBe("shadow");
  });

  test("an unreadable _brain.yaml keeps the feature off for that vault", () => {
    const vault = vaultWithBrainYaml("schema_version: 99\n");
    const cfg = resolveDecisionModelConfig({ env: WITH_KEY, config: ENABLED, vault });
    expect(cfg.status).toBe("disabled_by_vault");
  });
});

// ----- Key resolution through the custody store (t_e5807974 / B2) ------------
//
// The value of the variable `decision_model_env_key` names may itself be a
// `$secret:NAME` reference; with `secretsVault` set it resolves through the
// custody store at resolution time. Resolution still never throws: an
// unresolvable reference lands in `errors` (status `invalid`) instead of
// silently reading as an unset key, and a plain value keeps today's path.

describe("decision-model key through the custody store", () => {
  const STORED_DM_KEY = fakeCredential("stored-dm-", "key-88ac");
  const REF_VALUE = "$secret:dm_key";
  const NOW = new Date("2026-06-05T10:00:00Z");

  function tempCustodyVault(): string {
    const vault = mkdtempSync(join(tmpdir(), "osb-dm-custody-"));
    dirs.push(vault);
    mkdirSync(join(vault, "Brain"), { recursive: true });
    return vault;
  }

  test("a reference as the key value resolves through the store and activates", () => {
    const vault = tempCustodyVault();
    setSecret(vault, { name: "dm_key", value: STORED_DM_KEY, agent: "tester", now: NOW });
    const cfg = resolveDecisionModelConfig({
      env: { [KEY_VAR]: REF_VALUE } as NodeJS.ProcessEnv,
      config: ENABLED,
      vault: null,
      secretsVault: vault,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.keyPresent).toBe(true);
    expect(cfg.errors).toEqual([]);
  });

  test("a plain key value keeps resolving exactly as before", () => {
    const vault = tempCustodyVault();
    const without = resolveDecisionModelConfig({ env: WITH_KEY, config: ENABLED, vault: null });
    const withVaultOpt = resolveDecisionModelConfig({
      env: WITH_KEY,
      config: ENABLED,
      vault: null,
      secretsVault: vault,
    });
    expect(withVaultOpt).toEqual(without);
    expect(withVaultOpt.status).toBe("active");
  });

  test("an unresolvable reference is a named error, not a silent empty key", () => {
    const vault = tempCustodyVault();
    const cfg = resolveDecisionModelConfig({
      env: { [KEY_VAR]: "$secret:absent_name" } as NodeJS.ProcessEnv,
      config: ENABLED,
      vault: null,
      secretsVault: vault,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.keyPresent).toBe(false);
    expect(cfg.errors.join("\n")).toContain("absent_name");
  });
});

// ----- The diagnostics surface joins the custody store ----------------------
//
// `o2b decision-model check` builds its report and its ping. Without the
// custody thread, a reference-shaped key value reported `active`
// everywhere and the ping built a provider whose Bearer key was the raw
// `$secret:NAME` literal - the doctor could probe an endpoint with it.

function diagnosticsCustodyVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "osb-dm-check-"));
  dirs.push(vault);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  return vault;
}

describe("decision-model check (diagnostics) through the custody store", () => {
  const NOW = new Date("2026-06-05T10:00:00Z");
  const REF_ENV = { [KEY_VAR]: "$secret:dm_key" } as NodeJS.ProcessEnv;
  const CHECK_KEY = fakeCredential("stored-dm-check-", "key-4c02");

  test("a reference the store resolves activates the check and the ping sends the resolved key", async () => {
    const vault = diagnosticsCustodyVault();
    setSecret(vault, { name: "dm_key", value: CHECK_KEY, agent: "tester", now: NOW });
    const fake = await startFakeSystemOne();
    try {
      const report = await buildDecisionModelCheck({
        env: REF_ENV,
        config: { ...ENABLED, decision_model_base_url: fake.url },
        vault,
        ping: true,
      });
      expect(report.status).toBe("active");
      expect(report.key_set).toBe(true);
      expect(report.ping?.ok).toBe(true);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${CHECK_KEY}`);
    } finally {
      await fake.close();
    }
  });

  test("an unresolvable reference degrades the check to invalid with the named error", async () => {
    const vault = diagnosticsCustodyVault();
    const report = await buildDecisionModelCheck({
      env: { [KEY_VAR]: "$secret:absent_name" } as NodeJS.ProcessEnv,
      config: ENABLED,
      vault,
    });
    // Before the custody thread this reported `active` with key_set true,
    // deferring the failure to the use site.
    expect(report.status).toBe("invalid");
    expect(report.key_set).toBe(false);
    expect(report.errors.join("\n")).toContain("absent_name");
  });

  test("a locked store degrades the ping to the named state and never sends the raw literal", async () => {
    const vault = diagnosticsCustodyVault();
    setSecret(vault, { name: "dm_key", value: CHECK_KEY, agent: "tester", now: NOW });
    const kp = join(secretsDir(vault), "keyfile");
    wrapKeyfile(kp, fakeCredential("dm-check-", "phrase-5f27"), loadOrCreateKey(kp));
    clearHeldKey(kp);
    const fake = await startFakeSystemOne();
    try {
      const report = await buildDecisionModelCheck({
        env: REF_ENV,
        config: { ...ENABLED, decision_model_base_url: fake.url },
        vault,
        ping: true,
      });
      expect(report.status).toBe("invalid");
      expect(report.errors.join("\n")).toContain("locked");
      expect(report.ping?.ok).toBe(false);
      // The decisive assertion: no request left for the endpoint, so the
      // raw `$secret:` literal never went out as a Bearer key.
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
      clearHeldKey(kp);
    }
  });

  test("a missing keyfile degrades the ping by name instead of minting over the store", async () => {
    // The locked refusal's sibling state on the same factory path: the
    // read-only resolve now refuses a store whose keyfile is gone while
    // entries survive, and the check degrades it into the ping's reason
    // exactly like the locked state.
    const vault = diagnosticsCustodyVault();
    setSecret(vault, { name: "dm_key", value: CHECK_KEY, agent: "tester", now: NOW });
    rmSync(join(secretsDir(vault), "keyfile"));
    const fake = await startFakeSystemOne();
    try {
      const report = await buildDecisionModelCheck({
        env: REF_ENV,
        config: { ...ENABLED, decision_model_base_url: fake.url },
        vault,
        ping: true,
      });
      expect(report.status).toBe("invalid");
      expect(report.errors.join("\n")).toContain("missing");
      expect(report.ping?.ok).toBe(false);
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

// ----- The provider factory resolves the key at the use site -----------------
//
// Config resolution only PROBES a `$secret:NAME` reference for presence;
// the factory re-reads the raw variable at call time, so it must resolve
// the reference itself when handed the vault. A loopback fake records the
// `authorization` header, which is the only honest witness of what the
// adapter would actually send.

function factoryCustodyVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "osb-dm-factory-"));
  dirs.push(vault);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  return vault;
}

/** Active config for the reference env value, pointed at an explicit base URL. */
function activeReferenceConfig(baseUrl: string) {
  return resolveDecisionModelConfig({
    env: { [KEY_VAR]: "$secret:dm_key" } as NodeJS.ProcessEnv,
    config: { ...ENABLED, decision_model_base_url: baseUrl },
    vault: null,
    secretsVault: undefined,
  });
}

describe("decision-model provider factory through the custody store", () => {
  const STORED_DM_KEY = fakeCredential("stored-dm-", "key-99be");
  const NOW = new Date("2026-06-05T10:00:00Z");
  const REQUEST: DecisionRequest = {
    use: "rerank",
    state: { query: "q", passages: { P0: "alpha" } },
    questions: { yes: { type: "noul", instructions: "Does `passages.P0` help?" } },
  };

  test("a reference key value reaches the adapter resolved, not raw", async () => {
    const vault = factoryCustodyVault();
    setSecret(vault, { name: "dm_key", value: STORED_DM_KEY, agent: "tester", now: NOW });
    const fake = await startFakeSystemOne();
    try {
      const cfg = activeReferenceConfig(fake.url);
      expect(cfg.status).toBe("active");
      const provider = makeDecisionProvider(
        cfg,
        { [KEY_VAR]: "$secret:dm_key" } as NodeJS.ProcessEnv,
        vault,
      );
      expect(provider).not.toBeNull();
      await provider!.decide(REQUEST, { timeoutMs: 2000 });
      expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${STORED_DM_KEY}`);
    } finally {
      await fake.close();
    }
  });

  test("without a vault the raw value is sent exactly as before", async () => {
    const fake = await startFakeSystemOne();
    try {
      const cfg = activeReferenceConfig(fake.url);
      const provider = makeDecisionProvider(cfg, {
        [KEY_VAR]: "$secret:dm_key",
      } as NodeJS.ProcessEnv);
      expect(provider).not.toBeNull();
      await provider!.decide(REQUEST, { timeoutMs: 2000 });
      expect(fake.requests[0]!.headers["authorization"]).toBe("Bearer $secret:dm_key");
    } finally {
      await fake.close();
    }
  });

  test("a plain key value is byte-identical with and without a vault", async () => {
    const vault = factoryCustodyVault();
    const fake = await startFakeSystemOne();
    try {
      const cfg = resolveDecisionModelConfig({
        env: { [KEY_VAR]: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
        config: { ...ENABLED, decision_model_base_url: fake.url },
        vault: null,
      });
      expect(cfg.status).toBe("active");
      const env = { [KEY_VAR]: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;
      await makeDecisionProvider(cfg, env)!.decide(REQUEST, { timeoutMs: 2000 });
      await makeDecisionProvider(cfg, env, vault)!.decide(REQUEST, { timeoutMs: 2000 });
      expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
      expect(fake.requests[1]!.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
    } finally {
      await fake.close();
    }
  });

  test("an unresolvable reference raises the named resolver error at the use site", () => {
    const vault = factoryCustodyVault();
    const cfg = activeReferenceConfig("http://127.0.0.1:9");
    expect(() =>
      makeDecisionProvider(cfg, { [KEY_VAR]: "$secret:absent_name" } as NodeJS.ProcessEnv, vault),
    ).toThrow(SecretReferenceError);
  });

  test("a store-held name under a locked envelope raises the named locked error", () => {
    const vault = factoryCustodyVault();
    setSecret(vault, { name: "dm_key", value: STORED_DM_KEY, agent: "tester", now: NOW });
    const keyPath = join(secretsDir(vault), "keyfile");
    wrapKeyfile(keyPath, fakeCredential("dm-wrap", "-phrase-", "42"), loadOrCreateKey(keyPath));
    clearHeldKey(keyPath);
    const cfg = activeReferenceConfig("http://127.0.0.1:9");
    expect(() =>
      makeDecisionProvider(cfg, { [KEY_VAR]: "$secret:dm_key" } as NodeJS.ProcessEnv, vault),
    ).toThrow(SecretStoreLockedError);
  });
});
