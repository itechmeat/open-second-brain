/**
 * The ordered provider chain (`decision_model_providers`, issue #264):
 * resolution and validation of the list, the fallback in `runDecision`
 * (a dead or hanging first entry falls through within the one budget),
 * the per-attempt records, and the check's order and reachability lines.
 *
 * Every request lands on a loopback fake (`startFakeSystemOne`); a dead
 * entry points at a port on 127.0.0.1 that refuses connections, so no
 * test waits on a real network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import {
  buildDecisionModelCheck,
  decisionModelCheckExitCode,
  renderDecisionModelCheck,
} from "../../../src/core/decision-model/diagnostics.ts";
import { runDecision } from "../../../src/core/decision-model/run.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { FAKE_DECISION_KEY, fakeCredential } from "../../helpers/fake-credentials.ts";
import { startFakeSystemOne } from "../../helpers/fake-decision-provider.ts";

const KEY_VAR = "O2B_TEST_CHAIN_LOCAL_KEY";
const FALLBACK_KEY_VAR = "O2B_TEST_CHAIN_FALLBACK_KEY";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempVault(): string {
  const v = mkdtempSync(join(tmpdir(), "osb-dm-chain-"));
  dirs.push(v);
  return v;
}

/** A chain config: a compatible server first, a hosted preset second. */
function chainConfig(extra: Record<string, string> = {}): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_providers: "compatible,typesafe",
    decision_model_base_url: "http://127.0.0.1:8080",
    decision_model_id: "local-model-1",
    decision_model_env_key: KEY_VAR,
    decision_model_uses: "rerank:enforce",
    ...extra,
  };
}

const CHAIN_ENV = {
  [KEY_VAR]: FAKE_DECISION_KEY,
  TYPESAFE_API_KEY: fakeCredential("O2B_TEST_CHAIN"),
} as NodeJS.ProcessEnv;

/** A state/questions pair small enough for every fake server. */
function build() {
  return {
    kind: "ok" as const,
    state: { query: "q", passages: { P0: "text" } },
    candidateCount: 1,
    context: null,
  };
}
const QUESTIONS = () => ({ rel_0: { type: "noul" as const, instructions: "relevant?" } });

describe("decision_model_providers resolution", () => {
  test("the list resolves in order; the first entry reads the global endpoint keys", () => {
    const cfg = resolveDecisionModelConfig({ env: CHAIN_ENV, config: chainConfig(), vault: null });
    expect(cfg.status).toBe("active");
    expect(cfg.provider).toBe("compatible");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8080");
    expect(cfg.model).toBe("local-model-1");
    const names = cfg.providers?.map((p) => p.name);
    expect(names).toEqual(["compatible", "typesafe"]);
    const second = cfg.providers?.[1];
    expect(second?.baseUrl).toBe("https://api.typesafe.ai");
    expect(second?.model).toBe("jev-1.13.0");
    expect(second?.envKey).toBe("TYPESAFE_API_KEY");
    expect(second?.keyPresent).toBe(true);
  });

  test("a single decision_model_provider resolves as a one-entry chain", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "typesafe",
        decision_model_uses: "rerank:shadow",
      },
      vault: null,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.providers?.map((p) => p.name)).toEqual(["typesafe"]);
    expect(cfg.providers?.[0]?.baseUrl).toBe("https://api.typesafe.ai");
  });

  test("the list wins over decision_model_provider, with a note naming both", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({ decision_model_provider: "openrouter" }),
      vault: null,
    });
    expect(cfg.providers?.map((p) => p.name)).toEqual(["compatible", "typesafe"]);
    expect(cfg.notes.join()).toContain("decision_model_provider");
    expect(cfg.notes.join()).toContain("decision_model_providers");
  });

  test("an unknown preset and a duplicate are errors naming the new key", () => {
    const unknown = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({ decision_model_providers: "compatible,somewhere" }),
      vault: null,
    });
    expect(unknown.status).toBe("invalid");
    expect(unknown.errors.join()).toContain("decision_model_providers");
    expect(unknown.errors.join()).toContain("'somewhere'");
    const duplicate = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({ decision_model_providers: "typesafe,typesafe" }),
      vault: null,
    });
    expect(duplicate.status).toBe("invalid");
    expect(duplicate.errors.join()).toContain("more than once");
  });

  test("an empty list is an error naming the key", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({ decision_model_providers: " , " }),
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join()).toContain("decision_model_providers");
  });

  test("a later entry without any endpoint is an error naming its per-entry key", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({ decision_model_providers: "typesafe,compatible" }),
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join()).toContain("decision_model_providers_compatible_base_url");
  });

  test("per-entry endpoint keys configure a later slot", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig({
        decision_model_providers: "typesafe,compatible",
        decision_model_providers_compatible_base_url: "http://127.0.0.1:9",
        decision_model_providers_compatible_id: "second-local-model",
        decision_model_providers_compatible_env_key: FALLBACK_KEY_VAR,
      }),
      vault: null,
    });
    expect(cfg.status).toBe("active");
    const second = cfg.providers?.[1];
    expect(second?.baseUrl).toBe("http://127.0.0.1:9");
    expect(second?.model).toBe("second-local-model");
    expect(second?.envKey).toBe(FALLBACK_KEY_VAR);
  });

  test("no_key only when no entry is configured; a keyed later entry keeps the feature on", () => {
    const none = resolveDecisionModelConfig({
      env: {},
      config: chainConfig(),
      vault: null,
    });
    expect(none.status).toBe("no_key");
    const secondHasKey = resolveDecisionModelConfig({
      env: { TYPESAFE_API_KEY: fakeCredential("O2B_TEST_CHAIN") } as NodeJS.ProcessEnv,
      config: chainConfig(),
      vault: null,
    });
    expect(secondHasKey.status).toBe("active");
    expect(secondHasKey.notes.join()).toContain("'compatible'");
    expect(secondHasKey.notes.join()).toContain(KEY_VAR);
    expect(secondHasKey.providers?.[0]?.keyPresent).toBe(false);
  });

  test("enforce is held per entry: the baseline fallback enforces where an unknown model cannot", () => {
    const cfg = resolveDecisionModelConfig({
      env: CHAIN_ENV,
      config: chainConfig(),
      vault: null,
      thresholdsPath: null,
    });
    expect(cfg.status).toBe("active");
    const first = cfg.providers?.[0];
    const second = cfg.providers?.[1];
    // compatible has no threshold profile and no stored thresholds, so
    // its rerank enforce holds as shadow; the hosted fallback is the
    // baseline family and keeps enforce.
    expect(first?.uses.rerank).toBe("shadow");
    expect(first?.shadowOnlyUses).toContain("rerank");
    expect(second?.uses.rerank).toBe("enforce");
    expect(second?.shadowOnlyUses).toEqual([]);
    // The top level mirrors the first entry.
    expect(cfg.uses.rerank).toBe("shadow");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("shadow");
  });
});

describe("chain fallback in runDecision", () => {
  test("a dead first entry falls through; records name each provider and the answering model", async () => {
    const vault = tempVault();
    const server = await startFakeSystemOne();
    try {
      const cfg = resolveDecisionModelConfig({
        env: CHAIN_ENV,
        config: chainConfig({
          decision_model_base_url: "http://127.0.0.1:1",
          decision_model_providers_typesafe_base_url: server.url,
          decision_model_providers_typesafe_id: "fake-model-1.0",
          decision_model_providers_typesafe_env_key: "TYPESAFE_API_KEY",
          decision_model_uses: "rerank:shadow",
        }),
        vault,
      });
      expect(cfg.status).toBe("active");
      const result = await runDecision("rerank", build, QUESTIONS, { config: cfg, env: CHAIN_ENV });
      expect(result.status).toBe("ok");
      const records = listDecisionModelCalls(vault);
      expect(records).toHaveLength(2);
      expect(records[0]?.payload).toMatchObject({
        provider: "compatible",
        outcome: "network",
      });
      expect(records[1]?.payload).toMatchObject({
        provider: "typesafe",
        model: "fake-model-1.0",
        outcome: "ok",
      });
    } finally {
      await server.close();
    }
  });

  test("a hanging first entry cannot stretch the call past the budget", async () => {
    const vault = tempVault();
    const hang = await startFakeSystemOne();
    const fast = await startFakeSystemOne();
    hang.setReply(() => ({ hang: true }));
    try {
      const cfg = resolveDecisionModelConfig({
        env: CHAIN_ENV,
        config: chainConfig({
          decision_model_base_url: hang.url,
          decision_model_providers_typesafe_base_url: fast.url,
          decision_model_providers_typesafe_id: "fake-model-1.0",
          decision_model_uses: "rerank:shadow",
          decision_model_timeout_ms: "500",
        }),
        vault,
      });
      const started = Date.now();
      const result = await runDecision("rerank", build, QUESTIONS, { config: cfg, env: CHAIN_ENV });
      const elapsed = Date.now() - started;
      expect(result.status).toBe("ok");
      // The whole chain shares the one budget: two entries, 500 ms, so
      // the first attempt is cut at about half and the second answers.
      // Anything near or above the full budget twice over would mean a
      // hook waiting on a dead server.
      expect(elapsed).toBeLessThan(1500);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      const records = listDecisionModelCalls(vault);
      expect(records[0]?.payload).toMatchObject({ provider: "compatible", outcome: "timeout" });
      expect(records[1]?.payload).toMatchObject({ provider: "typesafe", outcome: "ok" });
      expect(fast.requests).toHaveLength(1);
    } finally {
      await hang.close();
      await fast.close();
    }
  });

  test("an HTTP failure is an answer, not a fall-through: the next entry is not asked", async () => {
    const vault = tempVault();
    const refusing = await startFakeSystemOne();
    const next = await startFakeSystemOne();
    refusing.setReply(() => ({ status: 401 }));
    try {
      const cfg = resolveDecisionModelConfig({
        env: CHAIN_ENV,
        config: chainConfig({
          decision_model_base_url: refusing.url,
          decision_model_providers_typesafe_base_url: next.url,
          decision_model_providers_typesafe_id: "fake-model-1.0",
          decision_model_uses: "rerank:shadow",
        }),
        vault,
      });
      const result = await runDecision("rerank", build, QUESTIONS, { config: cfg, env: CHAIN_ENV });
      expect(result).toMatchObject({ status: "degraded", reason: "http_401" });
      expect(next.requests).toHaveLength(0);
      expect(listDecisionModelCalls(vault)).toHaveLength(1);
    } finally {
      await refusing.close();
      await next.close();
    }
  });

  test("an entry whose key is missing is skipped, not fatal", async () => {
    const vault = tempVault();
    const server = await startFakeSystemOne();
    try {
      const cfg = resolveDecisionModelConfig({
        env: { TYPESAFE_API_KEY: fakeCredential("O2B_TEST_CHAIN") } as NodeJS.ProcessEnv,
        config: chainConfig({
          decision_model_providers: "compatible,typesafe",
          decision_model_base_url: server.url,
          decision_model_id: "fake-model-1.0",
          // No local key: the compatible entry is not configured.
          decision_model_providers_typesafe_base_url: server.url,
          decision_model_providers_typesafe_id: "jev-1.13.0",
          decision_model_uses: "rerank:shadow",
        }),
        vault,
      });
      expect(cfg.status).toBe("active");
      const result = await runDecision("rerank", build, QUESTIONS, {
        config: cfg,
        env: { TYPESAFE_API_KEY: fakeCredential("O2B_TEST_CHAIN") } as NodeJS.ProcessEnv,
      });
      expect(result.status).toBe("ok");
      const records = listDecisionModelCalls(vault);
      expect(records).toHaveLength(1);
      expect(records[0]?.payload).toMatchObject({ provider: "typesafe", outcome: "ok" });
    } finally {
      await server.close();
    }
  });
});

describe("check with a chain", () => {
  test("the report lists the order and per-entry key state without any request", async () => {
    const report = await buildDecisionModelCheck({
      config: chainConfig(),
      vault: null,
      env: CHAIN_ENV,
    });
    expect(report.provider_order.map((p) => p.name)).toEqual(["compatible", "typesafe"]);
    expect(report.provider_order[0]?.configured).toBe(true);
    expect(report.provider_order[0]?.ping).toBeUndefined();
    const text = renderDecisionModelCheck(report);
    expect(text).toContain("providers (in order): compatible, typesafe");
    expect(text).toContain("1. compatible (systemone): http://127.0.0.1:8080");
    expect(text).toContain("2. typesafe (systemone): https://api.typesafe.ai");
  });

  test("--ping answers per entry; a dead first entry with a live second exits 0", async () => {
    const vault = tempVault();
    const dead = await startFakeSystemOne();
    const deadUrl = dead.url;
    await dead.close();
    const live = await startFakeSystemOne();
    try {
      const report = await buildDecisionModelCheck({
        config: chainConfig({
          decision_model_base_url: deadUrl,
          decision_model_providers_typesafe_base_url: live.url,
          decision_model_providers_typesafe_id: "fake-model-1.0",
          decision_model_uses: "rerank:shadow",
        }),
        vault,
        env: CHAIN_ENV,
        ping: true,
      });
      expect(report.ping?.ok).toBe(false);
      expect(report.provider_order[0]?.ping?.ok).toBe(false);
      expect(report.provider_order[1]?.ping?.ok).toBe(true);
      expect(report.provider_order[1]?.ping?.model).toBe("fake-model-1.0");
      expect(decisionModelCheckExitCode(report)).toBe(0);
      // Each ping is its own record, naming its own provider.
      const pings = listDecisionModelCalls(vault).filter((r) => r.payload["use"] === "ping");
      expect(pings.map((r) => r.payload["provider"])).toEqual(["compatible", "typesafe"]);
      expect(pings.map((r) => r.payload["outcome"])).toEqual(["network", "ok"]);
    } finally {
      await live.close();
    }
  });

  test("--ping exits 1 when every configured entry fails", async () => {
    const dead = await startFakeSystemOne();
    const deadUrl = dead.url;
    await dead.close();
    const report = await buildDecisionModelCheck({
      config: chainConfig({
        decision_model_base_url: deadUrl,
        decision_model_providers_typesafe_base_url: deadUrl,
        decision_model_providers_typesafe_id: "fake-model-1.0",
        decision_model_uses: "rerank:shadow",
      }),
      vault: null,
      env: CHAIN_ENV,
      ping: true,
    });
    expect(decisionModelCheckExitCode(report)).toBe(1);
  });
});
