/**
 * Self-hosted presets (`laya`, `openjev`), per-preset limits and threshold
 * profiles (issue #213, Part 7). Loopback fake server only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import {
  DECISION_MODEL_USES,
  type DecisionChoiceQuestion,
} from "../../../src/core/decision-model/contract.ts";
import {
  buildDecisionModelCheck,
  renderDecisionModelCheck,
} from "../../../src/core/decision-model/diagnostics.ts";
import { makeDecisionProvider } from "../../../src/core/decision-model/provider.ts";
import { runDecision } from "../../../src/core/decision-model/run.ts";
import { probeDecisionModel } from "../../../src/core/doctor-readiness.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";

let server: FakeSystemOne;
beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
});

function preset(name: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_provider: name,
    decision_model_uses: "rerank:shadow",
    ...extra,
  };
}

function choice(n: number): DecisionChoiceQuestion {
  return {
    type: "choice",
    instructions: "Pick one",
    criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null])),
  };
}

describe("self-hosted presets", () => {
  test("laya and openjev default to loopback and run without any key", () => {
    for (const [name, url, model] of [
      ["laya", "http://127.0.0.1:8000", "english"],
      ["openjev", "http://127.0.0.1:3000", "openjev"],
    ] as const) {
      const cfg = resolveDecisionModelConfig({ env: {}, config: preset(name), vault: null });
      expect(`${name}: ${cfg.status}`).toBe(`${name}: active`);
      expect(cfg.baseUrl).toBe(url);
      expect(cfg.model).toBe(model);
      expect(cfg.envKey).toBeNull();
      expect(cfg.keyRequired).toBe(false);
      expect(makeDecisionProvider(cfg, {})).not.toBeNull();
    }
  });

  test("a self-hosted preset pointed off the machine needs a key again", () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: preset("laya", {
        decision_model_base_url: "https://laya.example.com",
        decision_model_env_key: "O2B_TEST_LAYA_KEY",
      }),
      vault: null,
    });
    expect(cfg.status).toBe("no_key");
    expect(makeDecisionProvider(cfg, {})).toBeNull();
  });

  test("compatible keeps needing a named key, even on loopback", () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: preset("compatible", {
        decision_model_base_url: "http://127.0.0.1:8080",
        decision_model_id: "local-model",
      }),
      vault: null,
    });
    expect(cfg.status).toBe("no_key");
  });

  test("small state defaults, raisable to the server's ceiling and clamped there", () => {
    const laya = resolveDecisionModelConfig({ env: {}, config: preset("laya"), vault: null });
    expect(laya.maxStateTokens).toBe(2000);
    const openjev = resolveDecisionModelConfig({ env: {}, config: preset("openjev"), vault: null });
    expect(openjev.maxStateTokens).toBe(4000);
    const raised = resolveDecisionModelConfig({
      env: {},
      config: preset("laya", { decision_model_max_state_tokens: "6000" }),
      vault: null,
    });
    expect(raised.maxStateTokens).toBe(6000);
    const clamped = resolveDecisionModelConfig({
      env: {},
      config: preset("laya", { decision_model_max_state_tokens: "50000" }),
      vault: null,
    });
    expect(clamped.maxStateTokens).toBe(8192);
  });

  test("keyless requests carry no authorization header; a set key is sent", async () => {
    const run = async (env: Record<string, string>, extra: Record<string, string>) => {
      server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
      const cfg = resolveDecisionModelConfig({
        env,
        config: preset("openjev", { decision_model_base_url: server.url, ...extra }),
        vault: null,
      });
      await makeDecisionProvider(cfg, env)!.decide(
        { use: "rerank", state: "s", questions: { q: { type: "noul", instructions: "q?" } } },
        { timeoutMs: 2000 },
      );
    };
    await run({}, {});
    expect(server.requests[0]!.headers["authorization"]).toBeUndefined();
    await run(
      { O2B_TEST_OPENJEV_KEY: FAKE_DECISION_KEY },
      { decision_model_env_key: "O2B_TEST_OPENJEV_KEY" },
    );
    expect(server.requests[1]!.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
  });

  test("openjev: 52 options are sent, 53 degrade with budget before sending", async () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: preset("openjev", { decision_model_base_url: server.url }),
      vault: null,
    });
    expect(cfg.maxChoiceOptions).toBe(52);
    const attempt = (n: number) =>
      runDecision(
        "rerank",
        () => ({ kind: "ok", state: "s", candidateCount: n, context: null }),
        () => ({ pick: choice(n) }),
        { config: cfg, env: {} },
      );
    server.setReply(() => ({
      json: {
        answers: { pick: { type: "choice", choice: "o0", probabilities: { o0: 1 } } },
        usage: {},
      },
    }));
    const over = await attempt(53);
    expect(over).toMatchObject({ status: "degraded", reason: "budget" });
    expect(server.requests).toHaveLength(0);
    const fits = await attempt(52);
    expect(fits.status).toBe("ok");
    expect(server.requests).toHaveLength(1);
  });
});

describe("threshold profiles", () => {
  test("the Jev family enforces every use", () => {
    const allEnforce = DECISION_MODEL_USES.map((u) => `${u}:enforce`).join(",");
    const jev = resolveDecisionModelConfig({
      env: { O2B_TEST_TS_KEY: FAKE_DECISION_KEY },
      config: preset("typesafe", {
        decision_model_env_key: "O2B_TEST_TS_KEY",
        decision_model_uses: allEnforce,
      }),
      vault: null,
    });
    // Every use inherits the baseline.
    expect(DECISION_MODEL_USES.filter((u) => decisionModelModeFor(jev, u) !== "enforce")).toEqual(
      [],
    );
  });

  test("enforce on a profile without tuned thresholds runs as shadow", () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: preset("laya", { decision_model_uses: "rerank:enforce,skills:shadow" }),
      vault: null,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.errors).toEqual([]);
    expect(cfg.configuredUses.rerank).toBe("enforce");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("shadow");
    expect(decisionModelModeFor(cfg, "skills")).toBe("shadow");
    expect(cfg.shadowOnlyUses).toEqual(["rerank"]);
  });

  test("compatible has no profile unless the operator names the family it serves", () => {
    const env = { O2B_TEST_COMPAT_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;
    const base = preset("compatible", {
      decision_model_base_url: "http://127.0.0.1:8080",
      decision_model_id: "local-model",
      decision_model_env_key: "O2B_TEST_COMPAT_KEY",
      decision_model_uses: "rerank:enforce",
    });
    const unknown = resolveDecisionModelConfig({ env, config: base, vault: null });
    expect(unknown.thresholdProfile).toBeNull();
    expect(decisionModelModeFor(unknown, "rerank")).toBe("shadow");
    const jev = resolveDecisionModelConfig({
      env,
      config: { ...base, decision_model_threshold_profile: "jev-1.13" },
      vault: null,
    });
    expect(decisionModelModeFor(jev, "rerank")).toBe("enforce");
    const bad = resolveDecisionModelConfig({
      env,
      config: { ...base, decision_model_threshold_profile: "jev-9" },
      vault: null,
    });
    expect(bad.status).toBe("invalid");
    expect(bad.errors.join("\n")).toContain("decision_model_threshold_profile");
  });

  test("another preset cannot borrow a profile to enforce", () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: preset("laya", {
        decision_model_uses: "rerank:enforce",
        decision_model_threshold_profile: "jev-1.13",
      }),
      vault: null,
    });
    expect(cfg.thresholdProfile).toBe("laya");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("shadow");
    expect(cfg.notes.join("\n")).toContain("decision_model_threshold_profile");
  });
});

describe("check and doctor for the new presets", () => {
  test("check warns once that enforce runs as shadow; the hot path never does", async () => {
    const report = await buildDecisionModelCheck({
      config: preset("laya", { decision_model_uses: "rerank:enforce" }),
      vault: null,
      env: {},
    });
    expect(report.status).toBe("active");
    expect(report.shadow_only_uses).toEqual(["rerank"]);
    expect(report.key_required).toBe(false);
    const text = renderDecisionModelCheck(report);
    expect(text.match(/enforce runs as shadow/g)).toHaveLength(1);
    expect(text).toContain("threshold profile: laya");
    expect(text).toContain("optional on this loopback server");
    expect(text).not.toContain("licence:");
  });

  test("check prints the licence note for openjev only", async () => {
    const report = await buildDecisionModelCheck({
      config: preset("openjev"),
      vault: null,
      env: {},
    });
    expect(report.licence_note).toContain("CC-BY-NC-4.0");
    expect(renderDecisionModelCheck(report)).toContain("licence: the OpenJev weights");
    expect(report.max_choice_options).toBe(52);
  });

  test("check flags an uncalibrated provider", async () => {
    const report = await buildDecisionModelCheck({
      config: preset("llm-emulation", {
        decision_model_base_url: "https://api.example.com/v1",
        decision_model_id: "chat-1",
        decision_model_env_key: "O2B_TEST_EMU_KEY",
      }),
      vault: null,
      env: { O2B_TEST_EMU_KEY: FAKE_DECISION_KEY },
    });
    expect(report.calibrated).toBe(false);
    expect(renderDecisionModelCheck(report)).toContain("uncalibrated");
    expect(JSON.stringify(report)).not.toContain(FAKE_DECISION_KEY);
  });

  test("doctor passes a keyless loopback server without claiming a key", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "osb-dm-doctor-"));
    try {
      const configPath = join(tmp, "config.yaml");
      writeFileSync(
        configPath,
        Object.entries(preset("laya"))
          .map(([k, v]) => `${k}: "${v}"`)
          .join("\n") + "\n",
      );
      const verdict = await probeDecisionModel({ vault: tmp, config: configPath, env: {} });
      expect(verdict.status).toBe("pass");
      expect(verdict.detail).toContain("no key needed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
