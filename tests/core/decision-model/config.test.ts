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
import { loadBrainConfigDetailed } from "../../../src/core/brain/policy.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";

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
