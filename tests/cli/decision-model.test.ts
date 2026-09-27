/**
 * `o2b decision-model check|report` and `o2b search rerank-eval`
 * (issue #213, Parts 1 and 2). The check is the one surface that reports a
 * missing key; it names the variable and never prints its value.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeDecisionModel } from "../../src/core/doctor-readiness.ts";
import { listDecisionModelCalls } from "../../src/core/decision-model/record.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../helpers/fake-decision-provider.ts";
import { runCli } from "../helpers/run-cli.ts";

const KEY_VAR = "O2B_TEST_DECISION_CLI_KEY";

let server: FakeSystemOne;
let tmp: string;
let vault: string;
let configPath: string;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  server.requests.length = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const lines = [`vault: "${vault}"`, ...Object.entries(entries).map(([k, v]) => `${k}: "${v}"`)];
  writeFileSync(configPath, lines.join("\n") + "\n");
}

const ENABLED = {
  decision_model_enabled: "true",
  decision_model_provider: "compatible",
  decision_model_id: "fake-model-1",
  decision_model_env_key: KEY_VAR,
  decision_model_uses: "rerank:shadow",
};

function check(args: string[] = [], env: Record<string, string> = {}) {
  return runCli(["decision-model", "check", "--config", configPath, ...args], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath, ...env },
  });
}

describe("o2b decision-model check", () => {
  test("without config it reports off and exits 0", async () => {
    writeConfig({});
    const res = await check();
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("decision model: disabled");
    expect(res.stdout).toContain("key variable: (not named)");
    expect(res.stdout).toContain("hint:");
  });

  test("configured but not enabled: shows the configured uses, hints only what is missing", async () => {
    const { decision_model_enabled: _, ...notEnabled } = ENABLED;
    writeConfig({ ...notEnabled, decision_model_base_url: server.url });
    const res = await check();
    expect(res.stdout).toContain("uses: rerank:shadow");
    expect(res.stdout).toContain("every use listed above runs off");
    expect(res.stdout).toContain(
      'hint: the feature is off; to try it, set decision_model_enabled: "true" in',
    );
    expect(res.stdout).not.toContain("a decision_model_provider");
  });

  test("a vault that tries to enable the feature is warned about in check and doctor", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ndecision_model:\n  enabled: true\n",
    );
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    const res = await check();
    expect(res.stdout).toContain("warning: vault: decision_model.enabled: true ignored");
    const verdict = await probeDecisionModel({ vault, config: configPath, env: {} });
    expect(verdict.detail).toContain("decision_model.enabled: true ignored");
  });

  test("enabled without the key: names the variable, says how to set it, exits 0", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    const res = await check();
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("decision model: no_key");
    expect(res.stdout).toContain(`key variable: ${KEY_VAR} (not set)`);
    expect(res.stdout).toContain(`set the environment variable ${KEY_VAR}`);
    expect(server.requests).toHaveLength(0);
  });

  test("active: the key is reported as set and never printed, even with --ping", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    server.setReply((req) => ({ json: answerAll(req, () => 0.99, "fake-model-1.0") }));
    const res = await check(["--ping"], { [KEY_VAR]: FAKE_DECISION_KEY });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("decision model: active");
    expect(res.stdout).toContain(`key variable: ${KEY_VAR} (set)`);
    expect(res.stdout).toContain("ping: ok, answered by fake-model-1.0");
    expect(res.stdout).toContain("shadow and enforce both send data");
    expect(res.stdout + res.stderr).not.toContain(FAKE_DECISION_KEY);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.bodyText).not.toContain(vault);
    // The ping is real spend: it is recorded like any request.
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({ use: "ping", origin: "ping", outcome: "ok" });
  });

  test("--json carries the same facts without the key value", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    const res = await check(["--json"], { [KEY_VAR]: FAKE_DECISION_KEY });
    const report = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(report["status"]).toBe("active");
    expect(report["env_key"]).toBe(KEY_VAR);
    expect(report["key_set"]).toBe(true);
    expect(res.stdout).not.toContain(FAKE_DECISION_KEY);
  });

  test("an invalid config exits 1 and names the key", async () => {
    writeConfig({
      ...ENABLED,
      decision_model_base_url: server.url,
      decision_model_uses: "rerank:loud",
    });
    const res = await check([], { [KEY_VAR]: FAKE_DECISION_KEY });
    expect(res.returncode).toBe(1);
    expect(res.stdout).toContain("error: decision_model_uses");
  });

  test("a failed ping of an active provider exits 1", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    server.setReply(() => ({ status: 401 }));
    const res = await check(["--ping"], { [KEY_VAR]: FAKE_DECISION_KEY });
    expect(res.returncode).toBe(1);
    expect(res.stdout).toContain("ping: failed (http_401)");
  });

  test("rerank endpoint keys are reported as ignored for the decision-model kind", async () => {
    writeConfig({
      ...ENABLED,
      decision_model_base_url: server.url,
      search_rerank_kind: "decision-model",
      search_rerank_base_url: "https://rerank.example.com",
    });
    const res = await check();
    expect(res.stdout).toContain("ignored for this kind: search_rerank_base_url");
  });
});

describe("o2b decision-model report", () => {
  test("summarises records per use with shadow agreement", async () => {
    writeConfig({
      ...ENABLED,
      decision_model_base_url: server.url,
      search_rerank_enabled: "true",
      search_rerank_kind: "decision-model",
    });
    writeFileSync(join(vault, "a.md"), "# A\n\nfox fox fox\n");
    writeFileSync(join(vault, "b.md"), "# B\n\nfox and hound\n");
    server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
    const env = { [KEY_VAR]: FAKE_DECISION_KEY };
    await runCli(["search", "index", "--config", configPath], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, ...env },
    });
    await runCli(["search", "query", "fox", "--config", configPath], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, ...env },
    });
    const res = await runCli(["decision-model", "report", "--config", configPath, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    const report = JSON.parse(res.stdout) as {
      total: number;
      uses: Array<{ use: string; outcomes: Record<string, number>; agreement?: unknown }>;
    };
    expect(report.total).toBe(1);
    expect(report.uses[0]).toMatchObject({ use: "rerank", outcomes: { ok: 1 } });
    expect(report.uses[0]!.agreement).toBeDefined();
  });
});

describe("doctor readiness line", () => {
  test("off, no key, active and invalid", async () => {
    writeConfig({});
    expect((await probeDecisionModel({ vault, config: configPath, env: {} })).status).toBe(
      "skipped",
    );

    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    const noKey = await probeDecisionModel({ vault, config: configPath, env: {} });
    expect(noKey.status).toBe("skipped");
    expect(noKey.detail).toContain(KEY_VAR);

    const active = await probeDecisionModel({
      vault,
      config: configPath,
      env: { [KEY_VAR]: FAKE_DECISION_KEY },
    });
    expect(active.status).toBe("pass");
    expect(active.detail).not.toContain(FAKE_DECISION_KEY);

    writeConfig({ ...ENABLED, decision_model_base_url: "http://decisions.example.com" });
    const invalid = await probeDecisionModel({
      vault,
      config: configPath,
      env: { [KEY_VAR]: FAKE_DECISION_KEY },
    });
    expect(invalid.status).toBe("fail");
    expect(invalid.detail).toContain("decision_model_base_url");
  });
});

describe("o2b search rerank-eval", () => {
  test("reports hit@k and MRR for off and the local reranker", async () => {
    writeConfig({});
    writeFileSync(
      join(vault, "ml.md"),
      "# Machine learning\n\nGradient descent optimizes the loss.\n",
    );
    writeFileSync(join(vault, "garden.md"), "# Gardening\n\nTomatoes and compost in spring.\n");
    const dataset = join(tmp, "dataset.json");
    writeFileSync(
      dataset,
      JSON.stringify({ queries: [{ id: "q1", query: "gradient descent", expected: ["ml.md"] }] }),
    );
    const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };
    await runCli(["search", "index", "--config", configPath], { env });
    const res = await runCli(
      ["search", "rerank-eval", "--config", configPath, "--dataset", dataset, "--json"],
      { env },
    );
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, Record<string, number>>;
    expect(out["baseline"]).toMatchObject({ hit_at_k: 1, mrr: 1, hit_at_1: 1, hit_at_5: 1 });
    expect(out["baseline"]!["hit_at_10"]).toBeUndefined();
    expect(out["local"]).toMatchObject({
      delta_hit_at_k: 0,
      versus_off: { wins: 0, losses: 0, ties: 1 },
    });
  });

  test("--kind decision-model reports the run's calls, so a failing arm shows as failing", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    writeFileSync(join(vault, "ml.md"), "# Machine learning\n\nGradient descent optimizes.\n");
    writeFileSync(join(vault, "gd.md"), "# Descent\n\nGradient descent notes.\n");
    const dataset = join(tmp, "dataset.json");
    writeFileSync(
      dataset,
      JSON.stringify({ queries: [{ id: "q1", query: "gradient descent", expected: ["ml.md"] }] }),
    );
    const env = { OPEN_SECOND_BRAIN_CONFIG: configPath, [KEY_VAR]: FAKE_DECISION_KEY };
    await runCli(["search", "index", "--config", configPath], { env });
    server.setReply(() => ({ status: 400 }));
    const args = ["search", "rerank-eval", "--config", configPath, "--dataset", dataset];
    const res = await runCli([...args, "--kind", "decision-model", "--json"], { env });
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, Record<string, unknown>>;
    expect(out["decision-model"]!["calls"]).toMatchObject({
      total: 1,
      outcomes: { http_400: 1 },
    });
    const text = await runCli([...args, "--kind", "decision-model"], { env });
    expect(text.stdout).toContain("decision calls: 1 (http_400 1)");
    expect(text.stdout).toMatch(/vs off \d+ win\(s\)/);
  });

  test("--kind decision-model without an active config is refused with a pointer", async () => {
    writeConfig({ ...ENABLED, decision_model_base_url: server.url });
    const dataset = join(tmp, "dataset.json");
    writeFileSync(
      dataset,
      JSON.stringify({ queries: [{ id: "q", query: "x", expected: ["x.md"] }] }),
    );
    const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };
    await runCli(["search", "index", "--config", configPath], { env });
    const res = await runCli(
      [
        "search",
        "rerank-eval",
        "--config",
        configPath,
        "--dataset",
        dataset,
        "--kind",
        "decision-model",
      ],
      { env },
    );
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("o2b decision-model check");
    expect(server.requests).toHaveLength(0);
  });
});
