/**
 * `o2b decision-model thresholds fit|list|set` (issue #264) and the
 * shadow messaging: check and report name the model that has no stored
 * thresholds and the command that tunes it. The store lives beside the
 * test's own config.yaml; the fit reads records the test seeds into the
 * vault's continuity log. No network, no credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDecisionModelCheck,
  buildDecisionModelReport,
  renderDecisionModelCheck,
  renderDecisionModelReport,
} from "../../src/core/decision-model/diagnostics.ts";
import {
  decisionThresholdsPath,
  parseThresholdsStore,
  resetThresholdsStoreCache,
} from "../../src/core/decision-model/thresholds.ts";
import { emitDecisionModelCall } from "../../src/core/decision-model/record.ts";
import { runCli } from "../helpers/run-cli.ts";

const KEY_VAR = "O2B_TEST_THR_CLI_KEY";
const MODEL = "self-hosted-cli-1";

let tmp: string;
let vault: string;
let configPath: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-thr-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  storePath = decisionThresholdsPath(configPath);
  writeConfig({
    vault: `"${vault}"`,
    decision_model_enabled: "true",
    decision_model_provider: "compatible",
    decision_model_base_url: "http://127.0.0.1:9",
    decision_model_id: MODEL,
    decision_model_env_key: KEY_VAR,
    decision_model_uses: "dedup:enforce,tension:enforce",
  });
  resetThresholdsStoreCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetThresholdsStoreCache();
});

function writeConfig(entries: Record<string, string>): void {
  const lines = Object.entries(entries).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(configPath, lines.join("\n") + "\n");
}

function cliEnv(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: configPath, [KEY_VAR]: "unused" };
}

function seedDedupRecords(model: string, mergedProbability = 0.6): void {
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  // Eight true negatives at or above 0.9 and one merged pair (one side
  // retired) at 0.6: the fit lands on 0.9 with zero false actions. A
  // merged pair recorded at 0.95 instead sits inside every wide window,
  // so no threshold survives a small target.
  writeFileSync(join(vault, "Brain", "preferences", "pref-fa.md"), "---\nid: pref-fa\n---\n");
  writeFileSync(join(vault, "Brain", "retired", "ret-fb.md"), "---\nid: ret-fb\n---\n");
  emitDecisionModelCall(vault, {
    use: "dedup",
    mode: "shadow",
    provider: "fake",
    model,
    calibrated: true,
    questionCount: 1,
    candidateCount: 1,
    inputPriceUsdPerMtok: null,
    latencyMs: 1,
    outcome: "ok",
    details: {
      pair_kind: "preference",
      pairs: [
        {
          id: "f",
          a: "pref-fa",
          b: "pref-fb",
          verdict: "different",
          probability: mergedProbability,
        },
      ],
    },
  });
  for (let i = 0; i < 8; i++) {
    writeFileSync(
      join(vault, "Brain", "preferences", `pref-o${i}a.md`),
      `---\nid: pref-o${i}a\n---\n`,
    );
    writeFileSync(
      join(vault, "Brain", "preferences", `pref-o${i}b.md`),
      `---\nid: pref-o${i}b\n---\n`,
    );
    emitDecisionModelCall(vault, {
      use: "dedup",
      mode: "shadow",
      provider: "fake",
      model,
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
      details: {
        pair_kind: "preference",
        pairs: [
          {
            id: `o${i}`,
            a: `pref-o${i}a`,
            b: `pref-o${i}b`,
            verdict: "different",
            probability: 0.9 + i / 100,
          },
        ],
      },
    });
  }
}

describe("o2b decision-model thresholds set and list", () => {
  test("set writes the entry beside config.yaml; list shows it with history", async () => {
    const set = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "dedup",
        "--value",
        "0.8",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(set.returncode).toBe(0);
    expect(set.stdout).toContain(`low_priority_min = 0.8 for model '${MODEL}'`);
    expect(existsSync(storePath)).toBe(true);

    const update = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "dedup",
        "--value",
        "0.85",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(update.returncode).toBe(0);

    const list = await runCli(["decision-model", "thresholds", "list", "--config", configPath], {
      env: cliEnv(),
    });
    expect(list.returncode).toBe(0);
    expect(list.stdout).toContain(storePath);
    expect(list.stdout).toContain(`${MODEL} / dedup: low_priority_min=0.85 (set,`);
    expect(list.stdout).toContain("was 0.8 (set,");

    const json = await runCli(
      ["decision-model", "thresholds", "list", "--config", configPath, "--json"],
      { env: cliEnv() },
    );
    expect(json.returncode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      path: string;
      store: { models: Record<string, unknown> };
    };
    expect(parsed.path).toBe(storePath);
    expect(Object.keys(parsed.store.models)).toEqual([MODEL]);
  });

  test("set refuses a value, name or use that cannot be written", async () => {
    const badValue = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "dedup",
        "--value",
        "7",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(badValue.returncode).toBe(2);
    expect(badValue.stderr).toContain("--value");

    const badName = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "dedup",
        "--value",
        "0.5",
        "--name",
        "drop_below",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(badName.returncode).toBe(2);
    expect(badName.stderr).toContain("low_priority_min");

    const badUse = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "nonsense",
        "--value",
        "0.5",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(badUse.returncode).toBe(2);
    expect(existsSync(storePath)).toBe(false);
  });

  test("list on a fresh install says none stored and exits 0", async () => {
    const list = await runCli(["decision-model", "thresholds", "list", "--config", configPath], {
      env: cliEnv(),
    });
    expect(list.returncode).toBe(0);
    expect(list.stdout).toContain("none stored");
  });

  test("a per-vault override is written with --vault and listed under it", async () => {
    const set = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "tension",
        "--value",
        "0.7",
        "--vault",
        vault,
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(set.returncode).toBe(0);
    const store = parseThresholdsStore(readFileSync(storePath, "utf8"));
    expect(store.vaults[vault]?.[MODEL]?.tension?.values).toEqual({ low_priority_min: 0.7 });
    expect(store.models[MODEL]?.tension).toBeUndefined();
    const list = await runCli(["decision-model", "thresholds", "list", "--config", configPath], {
      env: cliEnv(),
    });
    expect(list.stdout).toContain("vault overrides:");
    expect(list.stdout).toContain(vault);
  });
});

describe("o2b decision-model thresholds fit", () => {
  test("fit writes the derived threshold for the answering model and says what it wrote", async () => {
    seedDedupRecords("fit-model-9");
    const fit = await runCli(
      [
        "decision-model",
        "thresholds",
        "fit",
        "--use",
        "dedup",
        "--config",
        configPath,
        "--vault",
        vault,
      ],
      { env: cliEnv() },
    );
    expect(fit.returncode).toBe(0);
    expect(fit.stdout).toContain("wrote low_priority_min = 0.9 for model 'fit-model-9'");
    expect(fit.stdout).toContain("at most 5.0%");
    expect(fit.stdout).toContain(storePath);
    const store = parseThresholdsStore(readFileSync(storePath, "utf8"));
    expect(store.models["fit-model-9"]?.dedup?.values).toEqual({ low_priority_min: 0.9 });
    expect(store.models["fit-model-9"]?.dedup?.source).toBe("fit");
    // A different model on the same preset inherits nothing.
    expect(store.models[MODEL]).toBeUndefined();
  });

  test("fit --json prints the written entry", async () => {
    seedDedupRecords("fit-model-9");
    const fit = await runCli(
      [
        "decision-model",
        "thresholds",
        "fit",
        "--use",
        "dedup",
        "--config",
        configPath,
        "--vault",
        vault,
        "--json",
      ],
      { env: cliEnv() },
    );
    expect(fit.returncode).toBe(0);
    const parsed = JSON.parse(fit.stdout) as {
      model: string;
      name: string;
      value: number;
      target: number;
      already_tuned: boolean;
    };
    expect(parsed).toMatchObject({
      model: "fit-model-9",
      name: "low_priority_min",
      value: 0.9,
      target: 0.05,
      already_tuned: false,
    });
  });

  test("a fit that misses the target is a named refusal, and nothing is written", async () => {
    // The merged pair at 0.95 sits inside the only wide window, so no
    // threshold both acts on eight samples and keeps a 0.1% false share.
    seedDedupRecords("fit-model-9", 0.95);
    const fit = await runCli(
      [
        "decision-model",
        "thresholds",
        "fit",
        "--use",
        "dedup",
        "--target",
        "0.001",
        "--config",
        configPath,
        "--vault",
        vault,
      ],
      { env: cliEnv() },
    );
    expect(fit.returncode).toBe(2);
    expect(fit.stderr).toContain("no threshold meets");
    expect(fit.stderr).toContain("nothing was written");
    expect(existsSync(storePath)).toBe(false);
  });

  test("a use without a labelled report is refused with the fittable list", async () => {
    const fit = await runCli(
      [
        "decision-model",
        "thresholds",
        "fit",
        "--use",
        "rerank",
        "--config",
        configPath,
        "--vault",
        vault,
      ],
      { env: cliEnv() },
    );
    expect(fit.returncode).toBe(2);
    expect(fit.stderr).toContain("no labelled report");
  });
});

describe("shadow messaging", () => {
  test("check names the model without stored thresholds and the tuning command", async () => {
    const report = await buildDecisionModelCheck({
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "http://127.0.0.1:9",
        decision_model_id: MODEL,
        decision_model_env_key: KEY_VAR,
        decision_model_uses: "dedup:enforce",
      },
      vault: null,
      env: cliEnv() as unknown as NodeJS.ProcessEnv,
      markSource: null,
    });
    expect(report.shadow_only_uses).toEqual(["dedup"]);
    const text = renderDecisionModelCheck(report);
    expect(text).toContain("enforce runs as shadow for dedup");
    expect(text).toContain(`model '${MODEL}'`);
    expect(text).toContain("o2b decision-model thresholds fit --use dedup");
    expect(text).toContain("o2b decision-model thresholds set");
  });

  test("after thresholds set, the use enforces and the warning is gone", async () => {
    const set = await runCli(
      [
        "decision-model",
        "thresholds",
        "set",
        "--model",
        MODEL,
        "--use",
        "dedup",
        "--value",
        "0.8",
        "--config",
        configPath,
      ],
      { env: cliEnv() },
    );
    expect(set.returncode).toBe(0);
    const report = await buildDecisionModelCheck({
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "http://127.0.0.1:9",
        decision_model_id: MODEL,
        decision_model_env_key: KEY_VAR,
        decision_model_uses: "dedup:enforce",
      },
      vault: null,
      env: cliEnv() as unknown as NodeJS.ProcessEnv,
      markSource: null,
    });
    expect(report.shadow_only_uses).toEqual([]);
    expect(report.uses.dedup).toBe("enforce");
    expect(renderDecisionModelCheck(report)).not.toContain("enforce runs as shadow");

    // Another model on the same preset is still shadow: the key is the
    // model id, never the provider preset.
    const other = await buildDecisionModelCheck({
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "http://127.0.0.1:9",
        decision_model_id: "other-model",
        decision_model_env_key: KEY_VAR,
        decision_model_uses: "dedup:enforce",
      },
      vault: null,
      env: cliEnv() as unknown as NodeJS.ProcessEnv,
      markSource: null,
    });
    expect(other.shadow_only_uses).toEqual(["dedup"]);
  });

  test("report names the shadow uses and the fit command when the config is supplied", () => {
    emitDecisionModelCall(vault, {
      use: "dedup",
      mode: "shadow",
      provider: "fake",
      model: MODEL,
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
    });
    const report = buildDecisionModelReport(vault, {
      config: {
        status: "active",
        errors: [],
        notes: [],
        enabled: true,
        provider: "compatible",
        adapter: "systemone",
        baseUrl: "http://127.0.0.1:9",
        model: MODEL,
        envKey: KEY_VAR,
        keyPresent: true,
        keyRequired: true,
        allowInsecureHttp: false,
        timeoutMs: 3000,
        hookBudgetMs: 700,
        maxStateTokens: 32000,
        uses: { dedup: "shadow" } as never,
        configuredUses: { dedup: "enforce" } as never,
        dailyCostGateUsd: 0.5,
        inputPriceUsdPerMtok: null,
        allowUncalibrated: false,
        calibrated: true,
        thresholdProfile: null,
        shadowOnlyUses: ["dedup"],
        processor: null,
        vault,
      },
    });
    expect(report.shadow).toMatchObject({ model: MODEL, uses: ["dedup"] });
    expect(report.shadow?.command).toContain("thresholds fit --use dedup");
    const rendered = renderDecisionModelReport(report);
    expect(rendered).toContain(`no tuned thresholds for model '${MODEL}'`);
    expect(rendered).toContain("thresholds fit --use dedup");
  });
});
