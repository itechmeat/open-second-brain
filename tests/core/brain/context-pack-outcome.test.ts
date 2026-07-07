import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  contextPackSampleId,
  emitContextPackOutcome,
  listContextPackOutcomes,
  SampleCarrier,
  summarizeContextPackOutcomes,
} from "../../../src/core/brain/context-pack-outcome.ts";
import { listTokenImpactOutcomes } from "../../../src/core/brain/token-impact.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ctx-outcome-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("emitContextPackOutcome gating", () => {
  test("gate off writes nothing and returns null", () => {
    expect(
      emitContextPackOutcome(vault, { sampleId: "s1", firstPassSuccess: true }, false),
    ).toBeNull();
    expect(
      emitContextPackOutcome(vault, { sampleId: "s1", firstPassSuccess: true }, undefined),
    ).toBeNull();
    expect(listContextPackOutcomes(vault)).toHaveLength(0);
  });

  test("fail-open: a missing sample id never throws and writes nothing", () => {
    expect(
      emitContextPackOutcome(vault, { sampleId: "  ", firstPassSuccess: true }, true),
    ).toBeNull();
    expect(listContextPackOutcomes(vault)).toHaveLength(0);
  });
});

describe("emitContextPackOutcome token-signal separation", () => {
  test("stores the three token signals as SEPARATE fields, never merged", () => {
    const record = emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-07-01T00:00:00.000Z",
        host: "mcp",
        sampleId: "receipt_abc",
        firstPassSuccess: true,
        exactPromptTokenSavings: 680,
        modeledInferenceAvoidance: 420,
        observedProviderTokens: 1200,
      },
      true,
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("context_pack_outcome");
    const payload = record!.payload;
    // three distinct keys — one per signal basis
    expect(payload["exact_prompt_token_savings"]).toBe(680);
    expect(payload["modeled_inference_avoidance"]).toBe(420);
    expect(payload["observed_provider_tokens"]).toBe(1200);
    // never conflated into a single merged headline figure
    expect(payload["token_savings"]).toBeUndefined();
    expect(payload["total_tokens"]).toBeUndefined();
    expect(payload["tokens"]).toBeUndefined();
  });
});

describe("emitContextPackOutcome privacy", () => {
  test("stores only compact counters — no raw prompt/completion/source text", () => {
    const record = emitContextPackOutcome(
      vault,
      {
        sampleId: "receipt_abc",
        firstPassSuccess: false,
        repairRequired: true,
        retryCount: 2,
        followUpTokens: 90,
        observedProviderTokens: 1500,
      },
      true,
    );
    const payload = record!.payload;
    for (const value of Object.values(payload)) {
      // no free-text field longer than an opaque id / label
      if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(64);
    }
    // the only strings are the opaque sample id (and optional labels)
    expect(payload["sample_id"]).toBe("receipt_abc");
    expect(payload["prompt"]).toBeUndefined();
    expect(payload["completion"]).toBeUndefined();
    expect(payload["text"]).toBeUndefined();
    expect(record!.redacted).toBe(false);
  });
});

describe("emitContextPackOutcome omit-don't-invent", () => {
  test("a field the caller did not supply is OMITTED, not defaulted to 0", () => {
    const record = emitContextPackOutcome(
      vault,
      { sampleId: "receipt_abc", firstPassSuccess: true },
      true,
    );
    const payload = record!.payload;
    expect(payload["sample_id"]).toBe("receipt_abc");
    expect(payload["first_pass_success"]).toBe(true);
    // none of the optional counters were invented
    expect("repair_required" in payload).toBe(false);
    expect("retry_count" in payload).toBe(false);
    expect("follow_up_tokens" in payload).toBe(false);
    expect("exact_prompt_token_savings" in payload).toBe(false);
    expect("modeled_inference_avoidance" in payload).toBe(false);
    expect("observed_provider_tokens" in payload).toBe(false);
  });
});

describe("emitContextPackOutcome composes the C3 ledger", () => {
  test("a first-pass outcome also lands in the token-impact calibration ledger", () => {
    emitContextPackOutcome(
      vault,
      { sampleId: "receipt_abc", firstPassSuccess: true, observedProviderTokens: 1200 },
      true,
    );
    const outcomes = listTokenImpactOutcomes(vault);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.payload).toMatchObject({
      outcome: "first_pass",
      pack_id: "receipt_abc",
      tokens_per_inference: 1200,
    });
  });

  test("repair/retry map to the calibration outcome enum", () => {
    emitContextPackOutcome(
      vault,
      { sampleId: "r1", firstPassSuccess: false, repairRequired: true },
      true,
    );
    emitContextPackOutcome(vault, { sampleId: "r2", firstPassSuccess: false, retryCount: 3 }, true);
    const outcomes = listTokenImpactOutcomes(vault);
    const byPack = new Map(outcomes.map((r) => [r.payload["pack_id"], r.payload["outcome"]]));
    expect(byPack.get("r1")).toBe("repair");
    expect(byPack.get("r2")).toBe("retry");
  });
});

describe("summarizeContextPackOutcomes", () => {
  test("keeps the three token signals separate and reports a first-pass rate", () => {
    emitContextPackOutcome(
      vault,
      { sampleId: "a", firstPassSuccess: true, exactPromptTokenSavings: 100 },
      true,
    );
    emitContextPackOutcome(
      vault,
      {
        sampleId: "b",
        firstPassSuccess: false,
        repairRequired: true,
        modeledInferenceAvoidance: 50,
      },
      true,
    );
    emitContextPackOutcome(
      vault,
      { sampleId: "c", firstPassSuccess: true, observedProviderTokens: 900, followUpTokens: 30 },
      true,
    );
    const summary = summarizeContextPackOutcomes(vault);
    expect(summary.total).toBe(3);
    expect(summary.first_pass_success).toBe(2);
    expect(summary.repair_required).toBe(1);
    expect(summary.first_pass_rate).toBe(0.6667);
    expect(summary.token_signals.exact).toEqual({ samples: 1, prompt_token_savings: 100 });
    expect(summary.token_signals.modeled).toEqual({ samples: 1, inference_avoidance: 50 });
    expect(summary.token_signals.observed).toEqual({ samples: 1, provider_tokens: 900 });
    expect(summary.follow_up).toEqual({ samples: 1, tokens: 30 });
  });

  test("empty ledger summarizes to zeros and a null rate", () => {
    const summary = summarizeContextPackOutcomes(vault);
    expect(summary.total).toBe(0);
    expect(summary.first_pass_rate).toBeNull();
    expect(summary.token_signals.exact.samples).toBe(0);
  });
});

describe("contextPackSampleId carries the report's sample id", () => {
  test("prefers the receipt id, falls back to telemetry, else null", () => {
    expect(contextPackSampleId({ receiptId: "r1", telemetryId: "t1" })).toBe("r1");
    expect(contextPackSampleId({ telemetryId: "t1" })).toBe("t1");
    expect(contextPackSampleId({})).toBeNull();
  });

  test("feeds a carried sample id straight into an outcome post", () => {
    const carrier = new SampleCarrier();
    const sampleId = contextPackSampleId({ receiptId: "receipt_live" });
    expect(sampleId).not.toBeNull();
    carrier.remember(sampleId as string);
    const record = emitContextPackOutcome(
      vault,
      { sampleId: carrier.latest() as string, firstPassSuccess: true },
      true,
    );
    expect(record!.payload["sample_id"]).toBe("receipt_live");
  });
});

describe("SampleCarrier bounded local state", () => {
  test("carries the latest sample id and stays bounded", () => {
    const carrier = new SampleCarrier(3);
    expect(carrier.latest()).toBeNull();
    carrier.remember("s1");
    carrier.remember("s2");
    carrier.remember("s3");
    carrier.remember("s4"); // evicts s1
    expect(carrier.size).toBe(3);
    expect(carrier.latest()).toBe("s4");
    expect(carrier.has("s1")).toBe(false);
    expect(carrier.has("s2")).toBe(true);
    expect([...carrier.all()]).toEqual(["s2", "s3", "s4"]);
  });

  test("re-remembering an id moves it to most-recent without growing", () => {
    const carrier = new SampleCarrier(2);
    carrier.remember("s1");
    carrier.remember("s2");
    carrier.remember("s1"); // move-to-front, no growth
    expect(carrier.size).toBe(2);
    expect(carrier.latest()).toBe("s1");
    expect([...carrier.all()]).toEqual(["s2", "s1"]);
  });

  test("ignores blank ids", () => {
    const carrier = new SampleCarrier();
    carrier.remember("  ");
    expect(carrier.latest()).toBeNull();
    expect(carrier.size).toBe(0);
  });
});
