/**
 * The machine-side tuning mark and the measured gate (cycle 20261020,
 * card t_4e1681b3, task C3).
 *
 * The mark is the one machine-consumed summary the config resolver
 * consults when the source table says a use is untuned. It is accepted
 * ONLY when its spec hash, fixture hash and pinned threshold values
 * match the installed spec, and when its recorded endpoint - the
 * provider id, the pinned model id and the base-URL hash of the config
 * that earned it - matches the config being resolved; anything else
 * fails closed to shadow, and a mark written before the endpoint
 * binding (no endpoint fields) is no mark at all. With no mark file
 * everything behaves exactly as the hand-edit path always did. The
 * vault's grade records are review evidence; this file is the gate
 * input, and it is written solely by the eval runner, and only on a
 * promote verdict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256Hex } from "../../../src/core/integrity/digest.ts";

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
  retractTuningMark,
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
    provider: "laya",
    adapter: "systemone",
    baseUrl: "http://127.0.0.1:8000",
    model: "english",
    envKey: null,
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
      provider: "laya",
      model: "english",
      base_url_hash: sha256Hex("http://127.0.0.1:8000"),
    });
    const mark = readTuningMark(path);
    expect(mark?.profile).toBe("laya");
    expect(mark?.verdict).toBe("promote");
    expect(mark?.model).toBe("english");
    expect(mark?.base_url_hash).toBe(sha256Hex("http://127.0.0.1:8000"));
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
      provider: "laya",
      model: "english",
      base_url_hash: sha256Hex("http://127.0.0.1:8000"),
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

describe("retractTuningMark", () => {
  const registry = decisionEvalSpecFor("rerank")!;

  function markOnDisk(specHash: string): void {
    writeTuningMark(decisionModelTuningMarkPath(stateEnv, "laya", "rerank"), {
      profile: "laya",
      use: "rerank",
      spec_hash: specHash,
      fixture_hash: registry.fixture_hash,
      thresholds: {},
      metric: "counted_error_rate",
      counted_n: 30,
      counted_error: 0,
      baseline_error: 0.5,
      verdict: "promote",
      created_at: "2026-10-20T00:00:00.000Z",
      provider: "laya",
      model: "english",
      base_url_hash: sha256Hex("http://127.0.0.1:8000"),
    });
  }

  test("deletes a spec-matched mark, and the deletion is visible immediately", () => {
    const specHash = decisionEvalSpecHash(registry);
    markOnDisk(specHash);
    expect(readTuningMark(decisionModelTuningMarkPath(stateEnv, "laya", "rerank"))).not.toBeNull();
    expect(retractTuningMark(stateEnv, "laya", "rerank", specHash)).toBe(true);
    // No cache reset: a retraction must be seen by the very next read.
    expect(readTuningMark(decisionModelTuningMarkPath(stateEnv, "laya", "rerank"))).toBeNull();
  });

  test("keeps a foreign-spec mark, and reports false when there is nothing to retract", () => {
    markOnDisk("a".repeat(64));
    // A hold under another spec does not speak for this mark.
    expect(retractTuningMark(stateEnv, "laya", "rerank", "b".repeat(64))).toBe(false);
    expect(readTuningMark(decisionModelTuningMarkPath(stateEnv, "laya", "rerank"))).not.toBeNull();
    // Retracting the matching mark twice: the second is a no-op.
    expect(retractTuningMark(stateEnv, "laya", "rerank", "a".repeat(64))).toBe(true);
    expect(retractTuningMark(stateEnv, "laya", "rerank", "a".repeat(64))).toBe(false);
    // No state root, or no profile: there is no (profile, use) pair.
    expect(retractTuningMark(null, "laya", "rerank", "a".repeat(64))).toBe(false);
    expect(retractTuningMark(stateEnv, null, "rerank", "a".repeat(64))).toBe(false);
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

  test("the mark records the provider, model and base-URL hash that earned it", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const raw = JSON.parse(
      readFileSync(decisionModelTuningMarkPath(stateEnv, "laya", "rerank"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw["provider"]).toBe("laya");
    expect(raw["model"]).toBe("english");
    // A hash, never the URL itself.
    expect(raw["base_url_hash"]).toBe(sha256Hex("http://127.0.0.1:8000"));
    expect(JSON.stringify(raw)).not.toContain("127.0.0.1");
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
  /** The endpoint `evalConfig` measures on - what a mark gets bound to. */
  const ENDPOINT = {
    provider: "laya",
    model: "english",
    baseUrl: "http://127.0.0.1:8000",
  };
  // Resolves to exactly the endpoint the measurement ran on: the laya
  // preset, whose threshold profile the preset itself names (a
  // non-baseline family is never registered in the source table).
  const CONFIG = {
    decision_model_enabled: "true",
    decision_model_provider: "laya",
    decision_model_uses: "rerank:enforce",
  };

  test("with no mark the use stays shadow exactly as today", () => {
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: CONFIG,
      vault,
      thresholdsPath: null,
      measuredTunedMark: machineTunedMarkReader(ENDPOINT, stateEnv),
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
    const reader = machineTunedMarkReader(ENDPOINT, stateEnv);
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: CONFIG,
      vault,
      thresholdsPath: null,
      measuredTunedMark: reader,
    });
    expect(cfg.shadowOnlyUses).toEqual([]);
    expect(cfg.uses["rerank"]).toBe("enforce");
    expect(decisionModelModeFor(cfg, "rerank")).toBe("enforce");
    // Only the marked use is measured: an untuned use without a mark
    // stays shadow.
    const both = resolveDecisionModelConfig({
      env: {},
      config: { ...CONFIG, decision_model_uses: "rerank:enforce,dedup:enforce" },
      vault,
      measuredTunedMark: reader,
    });
    expect(both.shadowOnlyUses).toEqual(["dedup"]);
  });

  test("a mark measured on one endpoint arms enforce only for that provider, model and base URL", async () => {
    // Measure with one model, then resolve the config as if the operator
    // had switched the pinned model, the base URL, or the whole provider:
    // none of those may inherit the mark, and switching back re-arms it.
    // The default reader path is the point: config.ts must bind the
    // reader to the endpoint it just resolved.
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const previous = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = stateEnv.env["XDG_STATE_HOME"]!;
    try {
      const resolve = (config: Record<string, string>) =>
        resolveDecisionModelConfig({ env: {}, config, vault, thresholdsPath: null });
      expect(resolve(CONFIG).uses["rerank"]).toBe("enforce");

      // A model that was never measured runs shadow.
      expect(resolve({ ...CONFIG, decision_model_id: "tiny-0.5b-q2" }).uses["rerank"]).toBe(
        "shadow",
      );
      // So does the same model at another base URL - a different deployment.
      expect(
        resolve({ ...CONFIG, decision_model_base_url: "http://127.0.0.1:10" }).uses["rerank"],
      ).toBe("shadow");
      // And another provider id is a different decision surface outright.
      expect(resolve({ ...CONFIG, decision_model_provider: "openjev" }).uses["rerank"]).toBe(
        "shadow",
      );

      // Switching back to the measured endpoint re-arms enforce.
      expect(resolve(CONFIG).uses["rerank"]).toBe("enforce");
    } finally {
      if (previous === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previous;
    }
  });

  test("a mark written before the endpoint binding fails closed to shadow", async () => {
    // A pre-binding mark carries no provider/model/base-URL hash: it
    // cannot prove which endpoint earned it, so it is no mark at all.
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete legacy["provider"];
    delete legacy["model"];
    delete legacy["base_url_hash"];
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    resetTuningMarkCache();
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();
    const cfg = resolveDecisionModelConfig({
      env: {},
      config: CONFIG,
      vault,
      thresholdsPath: null,
      measuredTunedMark: machineTunedMarkReader(ENDPOINT, stateEnv),
    });
    expect(cfg.uses["rerank"]).toBe("shadow");
  });

  test("a completed hold retracts the mark; a refused run keeps it", async () => {
    const run = (provider: FakeDecisionProvider, spec?: DecisionEvalSpec) =>
      runDecisionModelEval("rerank", {
        config: evalConfig(),
        provider,
        markSource: stateEnv,
        ...(spec !== undefined ? { spec } : {}),
      });
    const reader = machineTunedMarkReader(ENDPOINT, stateEnv);
    const gated = () =>
      resolveDecisionModelConfig({
        env: {},
        config: CONFIG,
        vault,
        measuredTunedMark: reader,
        thresholdsPath: null,
      });

    // Run 1 promotes: the gate arms enforce.
    const first = await run(new FakeDecisionProvider({ answer: byLabelRule }));
    expect(first.mark_written).toBe(true);
    expect(gated().uses["rerank"]).toBe("enforce");

    // Run 2 holds: the mark is gone and the gate falls back to shadow -
    // the run says so, instead of printing that no mark was written.
    const second = await run(new FakeDecisionProvider({ answer: INVERTED }));
    expect(second.verdict).toBe("hold");
    expect(second.mark_retracted).toBe(true);
    expect(second.mark_note).toMatch(/retracted/);
    expect(gated().uses["rerank"]).toBe("shadow");

    // Run 3 promotes again: re-arming after a retraction works.
    const third = await run(new FakeDecisionProvider({ answer: byLabelRule }));
    expect(third.mark_written).toBe(true);
    expect(gated().uses["rerank"]).toBe("enforce");

    // Run 4 is refused before any measurement: the mark survives.
    const registry = decisionEvalSpecFor("rerank")!;
    const tampered: DecisionEvalSpec = {
      ...registry,
      receipt: { dev: registry.receipt.dev, counted: registry.receipt.counted.slice(1) },
    };
    await expect(run(new FakeDecisionProvider({ answer: byLabelRule }), tampered)).rejects.toThrow(
      /preregistration/,
    );
    expect(gated().uses["rerank"]).toBe("enforce");
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
      env: {},
      config: CONFIG,
      vault,
      thresholdsPath: null,
      measuredTunedMark: machineTunedMarkReader(ENDPOINT, stateEnv),
    });
    expect(cfg.shadowOnlyUses).toEqual(["rerank"]);
    expect(cfg.uses["rerank"]).toBe("shadow");
  });

  test("the default reader is the machine-side one", async () => {
    const previous = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = stateEnv.env["XDG_STATE_HOME"]!;
    try {
      const before = resolveDecisionModelConfig({ env: {}, config: CONFIG, vault });
      expect(before.shadowOnlyUses).toEqual(["rerank"]);
      await runDecisionModelEval("rerank", {
        config: evalConfig(),
        provider: new FakeDecisionProvider({ answer: byLabelRule }),
        markSource: stateEnv,
      });
      resetTuningMarkCache();
      const after = resolveDecisionModelConfig({ env: {}, config: CONFIG, vault });
      expect(after.shadowOnlyUses).toEqual([]);
      expect(after.uses["rerank"]).toBe("enforce");
      // An explicit null reader is today's hand-edit behavior.
      const disabled = resolveDecisionModelConfig({
        env: {},
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
      env: {},
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
      measuredTunedMark: machineTunedMarkReader(ENDPOINT, stateEnv),
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join(" ")).toContain("calibrated");
  });
});
