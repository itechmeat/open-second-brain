/**
 * The machine-side tuning mark and the measured gate (cycle 20261020,
 * card t_4e1681b3, task C3).
 *
 * The mark is the one machine-consumed summary the config resolver
 * consults when the source table says a use is untuned. It is accepted
 * ONLY when its spec hash, fixture hash and pinned threshold values
 * match the installed spec - anything else fails closed to shadow - and
 * with no mark file everything behaves exactly as the hand-edit path
 * always did. The vault's grade records are review evidence; this file
 * is the gate input, and it is written solely by the eval runner, and
 * only on a promote verdict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import {
  decisionModelModeFor,
  type ResolvedDecisionModelConfig,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
  type DecisionEvalSpec,
} from "../../../src/core/decision-model/eval-spec.ts";
import { runDecisionModelEval } from "../../../src/core/decision-model/eval/grade.ts";
import {
  decisionModelTuningMarkPath,
  machineTunedMarkReader,
  readTuningMark,
  resetTuningMarkCache,
  validatedTuningMark,
  writeTuningMark,
} from "../../../src/core/decision-model/eval/mark.ts";
import type { PlatformDirsEnv } from "../../../src/core/platform-dirs.ts";
import { decisionModelStateDir } from "../../../src/core/platform-dirs.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

let tmp: string;
let vault: string;
let stateEnv: PlatformDirsEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-eval-mark-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  stateEnv = { platform: "linux", home: tmp, env: { XDG_STATE_HOME: join(tmp, "state") } };
  resetTuningMarkCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetTuningMarkCache();
});

/** Answers relevance/helps by the fixtures' labeling rule: on-topic helps. */
function byLabelRule(id: string, req: DecisionRequest): number {
  const state = req.state as {
    query?: string;
    prompt?: string;
    passages?: Record<string, string>;
    notes?: Record<string, string>;
  };
  const subject = /the (.+)\?/.exec(state.query ?? state.prompt ?? "")![1]!;
  const key = id.startsWith("rel_")
    ? `P${id.slice(4)}`
    : id.startsWith("helps_")
      ? `N${id.slice(6)}`
      : null;
  if (key === null) return 0.5;
  const text = state.passages?.[key] ?? state.notes?.[key] ?? "";
  return text.includes(subject) ? 0.99 : 0.01;
}

const INVERTED = (id: string, req: DecisionRequest): number =>
  byLabelRule(id, req) > 0.5 ? 0.01 : 0.99;

function evalConfig(profile: string | null = "laya"): ResolvedDecisionModelConfig {
  return {
    status: "active",
    errors: [],
    notes: [],
    enabled: true,
    provider: "compatible",
    adapter: "systemone",
    baseUrl: "http://127.0.0.1:9",
    model: "fake-model-1",
    envKey: "FAKE_DECISION_KEY_UNUSED",
    keyPresent: true,
    allowInsecureHttp: false,
    timeoutMs: 3000,
    hookBudgetMs: 700,
    maxStateTokens: 32_000,
    uses: {
      rerank: "shadow",
      answerable: "off",
      skills: "off",
      extract_prefilter: "off",
      dedup: "off",
      tension: "off",
      labels: "off",
      recall_inject: "off",
    },
    configuredUses: {
      rerank: "shadow",
      answerable: "off",
      skills: "off",
      extract_prefilter: "off",
      dedup: "off",
      tension: "off",
      labels: "off",
      recall_inject: "off",
    },
    dailyCostGateUsd: 0.5,
    inputPriceUsdPerMtok: 0.042,
    allowUncalibrated: false,
    calibrated: true,
    thresholdProfile: profile,
    shadowOnlyUses: ["rerank"],
    processor: null,
    vault,
  };
}

describe("the machine-side mark file", () => {
  test("lives under the decision-model state directory, keyed by profile and use", () => {
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    expect(path.startsWith(decisionModelStateDir(stateEnv))).toBe(true);
    expect(path).toContain(join("tuning-marks", "laya", "rerank.json"));
  });

  test("write and read round-trip; malformed content reads as null", () => {
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const spec = decisionEvalSpecFor("rerank")!;
    writeTuningMark(path, {
      profile: "laya",
      use: "rerank",
      spec_hash: "a".repeat(64),
      fixture_hash: spec.fixture_hash,
      thresholds: {},
      metric: "counted_error_rate",
      counted_n: 30,
      counted_error: 0,
      baseline_error: 0.5,
      verdict: "promote",
      created_at: "2026-10-20T00:00:00.000Z",
    });
    const mark = readTuningMark(path);
    expect(mark?.profile).toBe("laya");
    expect(mark?.verdict).toBe("promote");
    const broken = join(tmp, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    expect(readTuningMark(broken)).toBeNull();
  });

  test("the TTL cache serves reads without re-reading, until reset", () => {
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const spec = decisionEvalSpecFor("rerank")!;
    const base = {
      profile: "laya",
      use: "rerank" as const,
      spec_hash: "a".repeat(64),
      fixture_hash: spec.fixture_hash,
      thresholds: {},
      metric: "counted_error_rate",
      counted_n: 30,
      counted_error: 0,
      baseline_error: 0.5,
      verdict: "promote" as const,
    };
    writeTuningMark(path, { ...base, created_at: "2026-10-20T00:00:00.000Z" });
    expect(readTuningMark(path)?.created_at).toBe("2026-10-20T00:00:00.000Z");
    writeFileSync(
      path,
      JSON.stringify({ ...base, created_at: "2026-10-21T00:00:00.000Z" }),
      "utf8",
    );
    expect(readTuningMark(path)?.created_at).toBe("2026-10-20T00:00:00.000Z");
    resetTuningMarkCache();
    expect(readTuningMark(path)?.created_at).toBe("2026-10-21T00:00:00.000Z");
  });
});

describe("validatedTuningMark", () => {
  test("accepts a mark that matches the installed spec on every axis", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const mark = validatedTuningMark("laya", "rerank", stateEnv);
    expect(mark?.use).toBe("rerank");
    expect(mark?.counted_n).toBe(30);
    expect(mark?.thresholds).toEqual({});
  });

  test("fails closed on a foreign spec hash, a changed fixture hash or drifted thresholds", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    const foreign = { ...valid, spec_hash: "f".repeat(64) };
    writeFileSync(path, JSON.stringify(foreign), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();

    const refixtured = { ...valid, fixture_hash: "e".repeat(64) };
    writeFileSync(path, JSON.stringify(refixtured), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();

    // A mark is only as good as the thresholds it was measured against.
    // The on-disk mark here names the drifted spec's own hash and
    // fixture hash, so the pinned-threshold comparison is the only check
    // that can refuse it.
    const registry = decisionEvalSpecFor("rerank")!;
    const drifted: DecisionEvalSpec = { ...registry, thresholds: { min_score: 0.5 } };
    writeFileSync(
      path,
      JSON.stringify({
        ...valid,
        spec_hash: decisionEvalSpecHash(drifted),
        fixture_hash: drifted.fixture_hash,
        thresholds: registry.thresholds,
      }),
      "utf8",
    );
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv, drifted)).toBeNull();

    // The control: a mark that matches the drifted spec on every axis -
    // including its thresholds - validates, so the refusal above is the
    // threshold comparison's and nothing else's.
    writeFileSync(
      path,
      JSON.stringify({
        ...valid,
        spec_hash: decisionEvalSpecHash(drifted),
        fixture_hash: drifted.fixture_hash,
        thresholds: drifted.thresholds,
      }),
      "utf8",
    );
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv, drifted)).not.toBeNull();
  });

  test("fails closed on a mark keyed for another profile or use, or written by a hold", async () => {
    // A real promote mark for (laya, rerank) is on disk; every refusal
    // below is the acceptance check's, not the mere absence of a file.
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(validatedTuningMark("laya", "rerank", stateEnv)).not.toBeNull();

    // The same mark dropped under another profile's path (or asked for
    // under another profile) is refused: a mark tuned for one provider
    // family says nothing about another.
    const foreignProfilePath = decisionModelTuningMarkPath(stateEnv, "openjev", "rerank");
    mkdirSync(dirname(foreignProfilePath), { recursive: true });
    writeFileSync(foreignProfilePath, JSON.stringify(valid), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("openjev", "rerank", stateEnv)).toBeNull();

    // ...and under another use's path: recall_inject was never measured.
    const foreignUsePath = decisionModelTuningMarkPath(stateEnv, "laya", "recall_inject");
    mkdirSync(dirname(foreignUsePath), { recursive: true });
    writeFileSync(foreignUsePath, JSON.stringify(valid), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "recall_inject", stateEnv)).toBeNull();

    // A hold verdict never tunes, whatever the file claims.
    writeFileSync(path, JSON.stringify({ ...valid, verdict: "hold" }), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();
  });
});

describe("the eval runner writes the mark only on a promote", () => {
  test("a promote writes a validating mark", async () => {
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    expect(result.verdict).toBe("promote");
    expect(result.mark_written).toBe(true);
    expect(validatedTuningMark("laya", "rerank", stateEnv)).not.toBeNull();
  });

  test("a hold writes nothing", async () => {
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: INVERTED }),
      markSource: stateEnv,
    });
    expect(result.verdict).toBe("hold");
    expect(result.mark_written).toBe(false);
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();
  });

  test("not enough evidence writes nothing, and neither does a profileless config", async () => {
    const registry = decisionEvalSpecFor("rerank")!;
    const spec: DecisionEvalSpec = {
      ...registry,
      min_counted: registry.receipt.counted.length + 1,
    };
    const short = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
      spec,
    });
    expect(short.verdict).toBe("not_enough_evidence");
    expect(short.mark_written).toBe(false);

    const profileless = await runDecisionModelEval("rerank", {
      config: evalConfig(null),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    expect(profileless.verdict).toBe("promote");
    expect(profileless.mark_written).toBe(false);
  });
});

describe("the measured gate", () => {
  const ENV = {};
  const CONFIG = {
    decision_model_enabled: "true",
    decision_model_provider: "laya",
    decision_model_uses: "rerank:enforce",
  };

  test("with no mark the use stays shadow exactly as today", () => {
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: CONFIG,
      vault,
      measuredTunedMark: machineTunedMarkReader(stateEnv),
    });
    expect(cfg.status).toBe("active");
    expect(cfg.shadowOnlyUses).toEqual(["rerank"]);
    expect(cfg.uses["rerank"]).toBe("shadow");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("shadow");
  });

  test("a valid mark lets the previously shadow-only use run enforce", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const reader = machineTunedMarkReader(stateEnv);
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: CONFIG,
      vault,
      measuredTunedMark: reader,
    });
    expect(cfg.shadowOnlyUses).toEqual([]);
    expect(cfg.uses["rerank"]).toBe("enforce");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("enforce");
    // Only the marked use is measured: an untuned use without a mark
    // stays shadow.
    const both = resolveDecisionModelConfig({
      env: ENV,
      config: { ...CONFIG, decision_model_uses: "rerank:enforce,dedup:enforce" },
      vault,
      measuredTunedMark: reader,
    });
    expect(both.shadowOnlyUses).toEqual(["dedup"]);
  });

  test("a tampered mark fails closed to shadow", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...valid, spec_hash: "0".repeat(64) }), "utf8");
    resetTuningMarkCache();
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: CONFIG,
      vault,
      measuredTunedMark: machineTunedMarkReader(stateEnv),
    });
    expect(cfg.shadowOnlyUses).toEqual(["rerank"]);
    expect(cfg.uses["rerank"]).toBe("shadow");
  });

  test("the default reader is the machine-side one", async () => {
    const previous = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = stateEnv.env["XDG_STATE_HOME"]!;
    try {
      const before = resolveDecisionModelConfig({ env: ENV, config: CONFIG, vault });
      expect(before.shadowOnlyUses).toEqual(["rerank"]);
      await runDecisionModelEval("rerank", {
        config: evalConfig(),
        provider: new FakeDecisionProvider({ answer: byLabelRule }),
        markSource: stateEnv,
      });
      resetTuningMarkCache();
      const after = resolveDecisionModelConfig({ env: ENV, config: CONFIG, vault });
      expect(after.shadowOnlyUses).toEqual([]);
      expect(after.uses["rerank"]).toBe("enforce");
      // An explicit null reader is today's hand-edit behavior.
      const disabled = resolveDecisionModelConfig({
        env: ENV,
        config: CONFIG,
        vault,
        measuredTunedMark: null,
      });
      expect(disabled.shadowOnlyUses).toEqual(["rerank"]);
    } finally {
      if (previous === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previous;
    }
  });

  test("the uncalibrated-provider refusal stands even with a valid mark", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "llm-emulation",
        decision_model_base_url: "http://127.0.0.1:9/v1",
        decision_model_id: "fake-chat-1",
        decision_model_env_key: "O2B_TEST_EVAL_MARK_KEY",
        decision_model_uses: "rerank:enforce",
        decision_model_threshold_profile: "laya",
      },
      vault,
      measuredTunedMark: machineTunedMarkReader(stateEnv),
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join(" ")).toContain("calibrated");
  });
});
