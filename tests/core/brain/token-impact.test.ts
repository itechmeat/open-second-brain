import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  emitTokenImpact,
  isTokenCountMethod,
  listTokenImpact,
  listTokenImpactOutcomes,
  normalizeTokenCountMethod,
  recordTokenImpactOutcome,
  summarizeTokenImpact,
  TOKEN_COUNT_METHOD,
  TOKEN_COUNT_METHODS,
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
      emitTokenImpact(vault, { baselineTokens: 100, packedTokens: 40, method: "tokenizer" }, false),
    ).toBeNull();
    expect(
      emitTokenImpact(
        vault,
        { baselineTokens: 100, packedTokens: 40, method: "tokenizer" },
        undefined,
      ),
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
        method: "tokenizer",
      },
      true,
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("token_impact");
    expect(record!.payload).toMatchObject({
      host: "mcp",
      pack_id: "receipt_123",
      method: "tokenizer",
      baseline_tokens: 1000,
      packed_tokens: 320,
      delta_tokens: 680,
    });
  });

  test("delta is negative when the memory layer adds tokens", () => {
    const record = emitTokenImpact(
      vault,
      { baselineTokens: 200, packedTokens: 260, method: "heuristic" },
      true,
    );
    expect(record!.payload["delta_tokens"]).toBe(-60);
  });

  test("fail-open: an invalid method never throws and writes nothing", () => {
    expect(
      emitTokenImpact(
        vault,
        { baselineTokens: 1, packedTokens: 0, method: "bogus" as "tokenizer" },
        true,
      ),
    ).toBeNull();
    // A negative count is also swallowed.
    expect(
      emitTokenImpact(vault, { baselineTokens: -5, packedTokens: 0, method: "tokenizer" }, true),
    ).toBeNull();
    expect(listTokenImpact(vault)).toHaveLength(0);
  });

  test("modeled fields produce a separate modeled_savings figure", () => {
    const record = emitTokenImpact(
      vault,
      {
        baselineTokens: 500,
        packedTokens: 500,
        method: "tokenizer",
        modeledAvoidedInferences: 3,
        modeledTokensPerInference: 1200,
      },
      true,
    );
    expect(record!.payload).toMatchObject({
      delta_tokens: 0, // the measured delta is unaffected by the model
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
        method: "heuristic",
      },
      true,
    );
    const raw = readFileSync(join(vault, "Brain", "log", "continuity", "2026-06.jsonl"), "utf8");
    const record = JSON.parse(raw.trim());
    expect(record.payload.pack_id).toBe("hash_abc");
    expect(record.sourceRefs).toEqual([]);
    // No free-text prompt/recall keys smuggled in.
    expect(Object.keys(record.payload).toSorted()).toEqual(
      ["baseline_tokens", "delta_tokens", "method", "pack_id", "packed_tokens"].toSorted(),
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
        method: "tokenizer",
      },
      true,
    );
    emitTokenImpact(
      vault,
      {
        createdAt: "2026-06-01T00:00:01.000Z",
        baselineTokens: 20,
        packedTokens: 2,
        method: "heuristic",
        packId: "p2",
      },
      true,
    );
    const all = listTokenImpact(vault);
    expect(all).toHaveLength(2);
    expect(all[0]!.payload["baseline_tokens"]).toBe(20); // newest first
    expect(listTokenImpact(vault, { method: "tokenizer" })).toHaveLength(1);
    expect(listTokenImpact(vault, { packId: "p2" })).toHaveLength(1);
    expect(listTokenImpact(vault, { limit: 1 })).toHaveLength(1);
  });
});

describe("summarizeTokenImpact — measured vs modeled separation", () => {
  test("splits the prompt-token delta by method and never folds in the model", () => {
    emitTokenImpact(vault, { baselineTokens: 100, packedTokens: 30, method: "tokenizer" }, true); // +70
    emitTokenImpact(vault, { baselineTokens: 50, packedTokens: 80, method: "tokenizer" }, true); // -30
    emitTokenImpact(
      vault,
      {
        baselineTokens: 200,
        packedTokens: 100,
        method: "heuristic",
        modeledAvoidedInferences: 2,
        modeledTokensPerInference: 500,
      },
      true,
    ); // +100 measured, 1000 modeled

    const s = summarizeTokenImpact(vault);
    expect(s.total_samples).toBe(3);
    // Prompt-token delta ledger.
    expect(s.prompt_token_delta.net_savings_tokens).toBe(140); // 70 - 30 + 100
    expect(s.prompt_token_delta.saved_tokens).toBe(170); // 70 + 100
    expect(s.prompt_token_delta.added_tokens).toBe(30);
    expect(s.prompt_token_delta.by_method.tokenizer).toEqual({
      samples: 2,
      net_savings_tokens: 40,
    });
    expect(s.prompt_token_delta.by_method.heuristic).toEqual({
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
          method: "tokenizer",
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
        method: "tokenizer",
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
    emitTokenImpact(vault, { baselineTokens: 90, packedTokens: 10, method: "tokenizer" }, true);
    // A brand-new summarize call reads only the on-disk continuity log.
    const s = summarizeTokenImpact(vault);
    expect(s.prompt_token_delta.net_savings_tokens).toBe(80);
  });
});

describe("the ledger no longer claims exactness over caller-supplied integers", () => {
  test("the method vocabulary names provenance, not accuracy", () => {
    expect(TOKEN_COUNT_METHODS).toEqual(["tokenizer", "heuristic"]);
    expect(TOKEN_COUNT_METHOD.tokenizer).toBe("tokenizer");
    expect(TOKEN_COUNT_METHOD.heuristic).toBe("heuristic");
    expect(isTokenCountMethod("exact")).toBe(false);
    expect(isTokenCountMethod("fallback")).toBe(false);
  });

  test("records already on disk under the old labels are still classified, never dropped", () => {
    // Exactly what the pre-rename code path wrote: the two values the
    // guard now rejects. Dropping them out of the split would be a silent
    // loss of a ledger an operator already has on disk.
    appendContinuityRecord(vault, {
      kind: "token_impact",
      createdAt: "2026-05-01T10:00:00.000Z",
      sourceRefs: [],
      payload: { method: "tokenizer", baseline_tokens: 100, packed_tokens: 30, delta_tokens: 70 },
    });
    appendContinuityRecord(vault, {
      kind: "token_impact",
      createdAt: "2026-05-01T10:01:00.000Z",
      sourceRefs: [],
      payload: { method: "heuristic", baseline_tokens: 50, packed_tokens: 45, delta_tokens: 5 },
    });

    const s = summarizeTokenImpact(vault);
    expect(s.total_samples).toBe(2);
    expect(s.prompt_token_delta.by_method.tokenizer).toEqual({
      samples: 1,
      net_savings_tokens: 70,
    });
    expect(s.prompt_token_delta.by_method.heuristic).toEqual({
      samples: 1,
      net_savings_tokens: 5,
    });
    expect(normalizeTokenCountMethod("exact")).toBe(TOKEN_COUNT_METHOD.tokenizer);
    expect(normalizeTokenCountMethod("fallback")).toBe(TOKEN_COUNT_METHOD.heuristic);
    expect(normalizeTokenCountMethod("nonsense")).toBeNull();
  });

  test("no executable line still labels a caller's integers exact", async () => {
    const source = await Bun.file(
      new URL("../../../src/core/brain/token-impact.ts", import.meta.url).pathname,
    ).text();
    // Comments may (and do) explain the retired label; code may not use it
    // for anything but the documented legacy read.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain('"exact"');
    expect(code).not.toContain('"fallback"');
    expect(code).not.toContain("byMethod.exact");
  });
});
