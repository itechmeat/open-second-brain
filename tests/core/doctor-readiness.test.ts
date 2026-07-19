import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_READINESS_TIMEOUT_MS,
  READINESS_PROBE,
  ReadinessTimeoutError,
  probeEmbeddingProvider,
  probeLlmKey,
  probeRuntimeAdapterWiring,
  runReadinessProbes,
  withReadinessTimeout,
} from "../../src/core/doctor-readiness.ts";

// The probes read the embedding config through `resolveSearchConfig`, which
// consults `process.env` before the config file. Clear the embedding env keys
// per test so a developer shell pointing at a real provider cannot leak in.
const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
  "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
  "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
  "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
  "OPEN_SECOND_BRAIN_EMBEDDING_DIM",
];

let tmp: string;
let configPath: string;
let origEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-readiness-"));
  configPath = join(tmp, "config.yaml");
  origEnv = {};
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  writeFileSync(configPath, `vault: "${tmp}"\n${body}`);
}

describe("probeLlmKey", () => {
  test("skipped when semantic search is disabled", async () => {
    writeConfig("");
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
    expect(v.detail.toLowerCase()).toContain("disabled");
  });

  test("skipped for a provider that needs no key", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
    expect(v.detail.toLowerCase()).toContain("no api key");
  });

  test("pass when a key-requiring provider has a resolvable key", async () => {
    writeConfig(
      "search_semantic_enabled: true\n" +
        "embedding_provider: openai-compat\n" +
        "embedding_base_url: https://example.invalid/v1\n" +
        "embedding_model: test-model\n" +
        'embedding_api_key: "sk-test-123"\n',
    );
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
  });

  test("fail with reason when a key-requiring provider has no key", async () => {
    writeConfig(
      "search_semantic_enabled: true\n" +
        "embedding_provider: openai-compat\n" +
        "embedding_base_url: https://example.invalid/v1\n" +
        "embedding_model: test-model\n",
    );
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("fail");
    expect(v.detail.toLowerCase()).toContain("key");
  });
});

describe("probeEmbeddingProvider", () => {
  test("skipped when semantic search is disabled", async () => {
    writeConfig("");
    const v = await probeEmbeddingProvider({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
  });

  test("pass for the offline local provider with model and dims", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    const v = await probeEmbeddingProvider({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
    expect(v.detail).toContain("local");
    // Model name and a positive dimension both appear in the detail.
    expect(v.detail).toMatch(/\d+ dim/);
  });
});

describe("probeRuntimeAdapterWiring", () => {
  test("pass: the adapter registry is populated and the payload wires", async () => {
    writeConfig("");
    const v = await probeRuntimeAdapterWiring({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
    expect(v.detail).toMatch(/adapter/);
  });
});

describe("withReadinessTimeout", () => {
  test("resolves when the function finishes within budget", async () => {
    const out = await withReadinessTimeout(async () => 42, 1000, "unit");
    expect(out).toBe(42);
  });

  test("rejects with a typed timeout error when the budget is exceeded", async () => {
    await expect(
      withReadinessTimeout(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        5,
        "unit",
      ),
    ).rejects.toBeInstanceOf(ReadinessTimeoutError);
  });
});

describe("runReadinessProbes", () => {
  test("runs all three probes and reports a failed count and durations", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    const report = await runReadinessProbes({ vault: tmp, config: configPath });
    expect(report.probes.length).toBe(3);
    const names = report.probes.map((p) => p.name);
    expect(names).toContain(READINESS_PROBE.llmKey);
    expect(names).toContain(READINESS_PROBE.embeddingProvider);
    expect(names).toContain(READINESS_PROBE.runtimeAdapterWiring);
    for (const p of report.probes) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0);
      // Never a silent pass: every probe carries an explicit status.
      expect(["pass", "fail", "skipped"]).toContain(p.status);
    }
    // local provider needs no key -> llm_key skipped, embedding_provider pass,
    // wiring pass; nothing failed.
    expect(report.failed).toBe(0);
  });

  test("a probe that exceeds the per-check timeout is a fail, not a hang", async () => {
    // An injected probe that sleeps past a tiny budget must surface as a
    // fail with a "timed out" reason rather than blocking the run.
    const slowProbe = {
      name: "slow_unit_probe",
      fn: () =>
        new Promise<{ status: "pass"; detail: string }>((resolve) =>
          setTimeout(() => resolve({ status: "pass", detail: "eventually" }), 100),
        ),
    };
    const report = await runReadinessProbes(
      { vault: tmp, config: configPath, perCheckTimeoutMs: 5 },
      [slowProbe],
    );
    expect(report.failed).toBe(1);
    expect(report.probes[0]!.status).toBe("fail");
    expect(report.probes[0]!.detail.toLowerCase()).toContain("timed out");
  });

  test("exposes a sane default per-check timeout constant", () => {
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
