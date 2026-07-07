import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitTokenImpact,
  listTokenImpact,
  listTokenImpactOutcomes,
  recordTokenImpactOutcome,
  summarizeTokenImpact,
} from "../../../src/core/brain/token-impact.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-token-impact-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("emitTokenImpact gating", () => {
  test("gate off writes nothing and returns null", () => {
    expect(
      emitTokenImpact(vault, { baselineTokens: 100, packedTokens: 40, method: "exact" }, false),
    ).toBeNull();
    expect(
      emitTokenImpact(vault, { baselineTokens: 100, packedTokens: 40, method: "exact" }, undefined),
    ).toBeNull();
    expect(listTokenImpact(vault)).toHaveLength(0);
  });

  test("gate on writes one record with a signed delta", () => {
    const record = emitTokenImpact(
      vault,
      {
        createdAt: "2026-06-01T00:00:00.000Z",
        host: "mcp",
        packId: "receipt_123",
        baselineTokens: 1000,
        packedTokens: 320,
        method: "exact",
      },
      true,
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("token_impact");
    expect(record!.payload).toMatchObject({
      host: "mcp",
      pack_id: "receipt_123",
      method: "exact",
      baseline_tokens: 1000,
      packed_tokens: 320,
      delta_tokens: 680,
    });
  });

  test("delta is negative when the memory layer adds tokens", () => {
    const record = emitTokenImpact(
      vault,
      { baselineTokens: 200, packedTokens: 260, method: "fallback" },
      true,
    );
    expect(record!.payload["delta_tokens"]).toBe(-60);
  });

  test("fail-open: an invalid method never throws and writes nothing", () => {
    expect(
      emitTokenImpact(
        vault,
        { baselineTokens: 1, packedTokens: 0, method: "bogus" as "exact" },
        true,
      ),
    ).toBeNull();
    // A negative count is also swallowed.
    expect(
      emitTokenImpact(vault, { baselineTokens: -5, packedTokens: 0, method: "exact" }, true),
    ).toBeNull();
    expect(listTokenImpact(vault)).toHaveLength(0);
  });

  test("modeled fields produce a separate modeled_savings figure", () => {
    const record = emitTokenImpact(
      vault,
      {
        baselineTokens: 500,
        packedTokens: 500,
        method: "exact",
        modeledAvoidedInferences: 3,
        modeledTokensPerInference: 1200,
      },
      true,
    );
    expect(record!.payload).toMatchObject({
      delta_tokens: 0, // exact ledger unaffected by the model
      modeled_avoided_inferences: 3,
      modeled_tokens_per_inference: 1200,
      modeled_savings_tokens: 3600,
    });
  });
});

describe("token-impact privacy", () => {
  test("only counts and an opaque pack id land on disk", () => {
    emitTokenImpact(
      vault,
      {
        createdAt: "2026-06-01T00:00:00.000Z",
        packId: "hash_abc",
        baselineTokens: 10,
        packedTokens: 4,
        method: "fallback",
      },
      true,
    );
    const raw = readFileSync(join(vault, "Brain", "log", "continuity", "2026-06.jsonl"), "utf8");
    const record = JSON.parse(raw.trim());
    expect(record.payload.pack_id).toBe("hash_abc");
    expect(record.sourceRefs).toEqual([]);
    // No free-text prompt/recall keys smuggled in.
    expect(Object.keys(record.payload).sort()).toEqual(
      ["baseline_tokens", "delta_tokens", "method", "pack_id", "packed_tokens"].sort(),
    );
  });
});

describe("listTokenImpact", () => {
  test("newest-first, filterable, limited", () => {
    emitTokenImpact(
      vault,
      {
        createdAt: "2026-06-01T00:00:00.000Z",
        baselineTokens: 10,
        packedTokens: 1,
        method: "exact",
      },
      true,
    );
    emitTokenImpact(
      vault,
      {
        createdAt: "2026-06-01T00:00:01.000Z",
        baselineTokens: 20,
        packedTokens: 2,
        method: "fallback",
        packId: "p2",
      },
      true,
    );
    const all = listTokenImpact(vault);
    expect(all).toHaveLength(2);
    expect(all[0]!.payload["baseline_tokens"]).toBe(20); // newest first
    expect(listTokenImpact(vault, { method: "exact" })).toHaveLength(1);
    expect(listTokenImpact(vault, { packId: "p2" })).toHaveLength(1);
    expect(listTokenImpact(vault, { limit: 1 })).toHaveLength(1);
  });
});

describe("summarizeTokenImpact — exact vs modeled separation", () => {
  test("splits the prompt-token delta by method and never folds in the model", () => {
    emitTokenImpact(vault, { baselineTokens: 100, packedTokens: 30, method: "exact" }, true); // +70
    emitTokenImpact(vault, { baselineTokens: 50, packedTokens: 80, method: "exact" }, true); // -30
    emitTokenImpact(
      vault,
      {
        baselineTokens: 200,
        packedTokens: 100,
        method: "fallback",
        modeledAvoidedInferences: 2,
        modeledTokensPerInference: 500,
      },
      true,
    ); // +100 exact, 1000 modeled

    const s = summarizeTokenImpact(vault);
    expect(s.total_samples).toBe(3);
    // EXACT-type delta ledger.
    expect(s.prompt_token_delta.net_savings_tokens).toBe(140); // 70 - 30 + 100
    expect(s.prompt_token_delta.saved_tokens).toBe(170); // 70 + 100
    expect(s.prompt_token_delta.added_tokens).toBe(30);
    expect(s.prompt_token_delta.by_method.exact).toEqual({ samples: 2, net_savings_tokens: 40 });
    expect(s.prompt_token_delta.by_method.fallback).toEqual({
      samples: 1,
      net_savings_tokens: 100,
    });
    // MODELED ledger is strictly separate.
    expect(s.modeled_inference_avoidance.samples).toBe(1);
    expect(s.modeled_inference_avoidance.raw_savings_tokens).toBe(1000);
    // No outcomes posted yet -> uncalibrated, not zero.
    expect(s.modeled_inference_avoidance.calibration.total_outcomes).toBe(0);
    expect(s.modeled_inference_avoidance.calibration.first_pass_rate).toBeNull();
    expect(s.modeled_inference_avoidance.calibrated_savings_tokens).toBeNull();
  });

  test("maxSamples bounds aggregation to the most-recent samples", () => {
    for (let i = 0; i < 5; i += 1) {
      emitTokenImpact(
        vault,
        {
          createdAt: `2026-06-01T00:00:0${i}.000Z`,
          baselineTokens: 10,
          packedTokens: 0,
          method: "exact",
        },
        true,
      );
    }
    const s = summarizeTokenImpact(vault, { maxSamples: 2 });
    expect(s.total_samples).toBe(2);
    expect(s.prompt_token_delta.net_savings_tokens).toBe(20);
  });
});

describe("outcome calibration", () => {
  test("gate off records no outcome", () => {
    expect(recordTokenImpactOutcome(vault, { outcome: "first_pass" }, false)).toBeNull();
    expect(listTokenImpactOutcomes(vault)).toHaveLength(0);
  });

  test("posted outcomes calibrate the modeled figure by first-pass rate", () => {
    emitTokenImpact(
      vault,
      {
        baselineTokens: 0,
        packedTokens: 0,
        method: "exact",
        modeledAvoidedInferences: 4,
        modeledTokensPerInference: 1000,
      },
      true,
    ); // raw modeled = 4000

    // 3 first-pass, 1 repair -> first_pass_rate = 0.75.
    recordTokenImpactOutcome(vault, { outcome: "first_pass", tokensPerInference: 800 }, true);
    recordTokenImpactOutcome(vault, { outcome: "first_pass" }, true);
    recordTokenImpactOutcome(vault, { outcome: "first_pass" }, true);
    recordTokenImpactOutcome(vault, { outcome: "repair", tokensPerInference: 1200 }, true);

    const s = summarizeTokenImpact(vault);
    const cal = s.modeled_inference_avoidance.calibration;
    expect(cal.total_outcomes).toBe(4);
    expect(cal.first_pass).toBe(3);
    expect(cal.repair).toBe(1);
    expect(cal.first_pass_rate).toBe(0.75);
    expect(cal.mean_tokens_per_inference).toBe(1000); // (800 + 1200) / 2
    expect(s.modeled_inference_avoidance.raw_savings_tokens).toBe(4000);
    expect(s.modeled_inference_avoidance.calibrated_savings_tokens).toBe(3000); // 4000 * 0.75
  });

  test("fail-open: an invalid outcome never throws", () => {
    expect(recordTokenImpactOutcome(vault, { outcome: "nope" as "repair" }, true)).toBeNull();
    expect(listTokenImpactOutcomes(vault)).toHaveLength(0);
  });
});

describe("durability across restarts", () => {
  test("aggregates are recomputed from disk (a fresh read sees prior samples)", () => {
    emitTokenImpact(vault, { baselineTokens: 90, packedTokens: 10, method: "exact" }, true);
    // A brand-new summarize call reads only the on-disk continuity log.
    const s = summarizeTokenImpact(vault);
    expect(s.prompt_token_delta.net_savings_tokens).toBe(80);
  });
});
