/**
 * Decision-model turn pre-filter before the `extract-signals` envelope
 * (issue #213, Part 4, use `extract_prefilter`). Claims pinned here:
 *
 *  1. Off (no config, disabled, no key, vault opt-out, invalid, use off):
 *     the plan is exactly `planExtractSignals`, no request, no record.
 *  2. Shadow: the envelope and `turnsMined` are the full ones, the only
 *     difference from off is the optional `source_turn` schema hint, and
 *     each request writes one record with turn ids, probabilities and the
 *     session id, never turn text.
 *  3. Enforce: a turn is dropped only below the threshold, kept turns stay
 *     in record order, an invalid item keeps its turn, and all dropped
 *     gives `llmStep: null` with `skipped`.
 *  4. A budget split sends as few requests as fit and never drops an
 *     unscored turn.
 *  5. Every failure kind sends all turns and names the reason.
 *  6. `<private>` regions never reach the provider.
 *  7. `token_impact` records baseline versus packed, and the skipped round
 *     trip as a modeled avoided inference.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { planExtractSignals } from "../../../src/core/brain/extract-signals.ts";
import {
  EXTRACT_PREFILTER_SKIP_REASON,
  EXTRACT_PREFILTER_TOKEN_SOURCE,
  planExtractSignalsPrefiltered,
  resolveExtractPrefilterConfig,
} from "../../../src/core/brain/extract-signals-prefilter.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import type { DecisionDegradeReason } from "../../../src/core/decision-model/contract.ts";
import { EXTRACT_PREFILTER_DROP_BELOW } from "../../../src/core/decision-model/questions.ts";
import {
  estimateTokens,
  QUESTION_TOKEN_ALLOWANCE,
} from "../../../src/core/decision-model/state.ts";
import {
  listDecisionModelCalls,
  resetDecisionSpendCache,
} from "../../../src/core/decision-model/record.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  activeDecisionConfig,
  FakeDecisionProvider,
  type ScriptedAnswer,
} from "../../helpers/fake-decision-provider.ts";

const NOW = new Date("2026-09-20T10:00:00Z");
const SESSION = "sess-prefilter";
const TURN_TEXTS: Record<string, string> = {
  t1: "Always name the release theme in the heading.",
  t3: "Run the migration on staging now.",
  t5: "Never abbreviate module names in docs.",
  t7: "What does this error mean?",
};

let tmp: string;
let vault: string;

let clock = 0;
function turn(id: string, role: SessionTurn["role"], text: string): SessionTurn {
  clock += 1;
  return {
    turnId: id,
    timestamp: `2026-09-20T09:${String(clock).padStart(2, "0")}:00Z`,
    role,
    text,
  };
}

beforeEach(() => {
  clock = 0;
  resetDecisionSpendCache();
  tmp = mkdtempSync(join(tmpdir(), "o2b-extract-prefilter-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      turn("t1", "user", TURN_TEXTS["t1"]!),
      turn("t2", "assistant", "Understood."),
      turn("t3", "user", TURN_TEXTS["t3"]!),
      turn("t4", "assistant", "Done."),
      turn("t5", "user", TURN_TEXTS["t5"]!),
      turn("t6", "assistant", "Noted."),
      turn("t7", "user", TURN_TEXTS["t7"]!),
    ],
    createdAt: NOW.toISOString(),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function config(
  mode: "off" | "shadow" | "enforce",
  overrides: Partial<ResolvedDecisionModelConfig> = {},
): ResolvedDecisionModelConfig {
  const base = activeDecisionConfig({ vault });
  return activeDecisionConfig({
    vault,
    uses: { ...base.uses, rerank: "off", extract_prefilter: mode },
    ...overrides,
  });
}

/** Scores each masked turn by its text, so answers follow the turn across chunks. */
function byText(scores: Record<string, ScriptedAnswer>) {
  return (id: string, req: { state: unknown }): ScriptedAnswer | undefined => {
    const k = Number(id.replace("sig_", ""));
    const text = (req.state as { turns: Record<string, string> }).turns[`T${k}`]!;
    const turnId = Object.entries(TURN_TEXTS).find(([, t]) => t === text)?.[0];
    return turnId !== undefined ? scores[turnId] : undefined;
  };
}

function offPlan() {
  return planExtractSignals(vault, SESSION, { now: NOW });
}

describe("off", () => {
  test("every configuration short of an active use is exactly today's plan", async () => {
    const provider = new FakeDecisionProvider();
    const configs = [
      null,
      undefined,
      config("shadow", { status: "disabled" }),
      config("shadow", { status: "no_key" }),
      config("shadow", { status: "disabled_by_vault" }),
      config("shadow", { status: "invalid" }),
      config("off"),
    ];
    for (const decisionModel of configs) {
      const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
        now: NOW,
        decisionModel,
        provider,
      });
      expect(JSON.stringify(plan)).toBe(JSON.stringify(offPlan()));
    }
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
    expect(JSON.stringify(offPlan().llmStep)).not.toContain("source_turn");
  });

  test("enabled without a key resolves to no pre-filter config", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(
      configPath,
      [
        `vault: "${vault}"`,
        'decision_model_enabled: "true"',
        'decision_model_provider: "compatible"',
        'decision_model_threshold_profile: "jev-1.13"',
        'decision_model_base_url: "http://127.0.0.1:9"',
        'decision_model_id: "fake-model-1"',
        'decision_model_env_key: "O2B_TEST_DM_KEY"',
        'decision_model_uses: "extract_prefilter:enforce"',
      ].join("\n") + "\n",
    );
    expect(resolveExtractPrefilterConfig(vault, configPath, {})).toBeNull();
    const withKey = resolveExtractPrefilterConfig(vault, configPath, {
      O2B_TEST_DM_KEY: FAKE_DECISION_KEY,
    });
    expect(withKey?.uses.extract_prefilter).toBe("enforce");
    expect(resolveExtractPrefilterConfig(vault, join(tmp, "missing.yaml"), {})).toBeNull();
  });
});

describe("shadow", () => {
  test("envelope and turns are the full ones; one record per request, no text", async () => {
    const provider = new FakeDecisionProvider({
      answer: byText({ t1: 0.9, t3: 0.01, t5: 0.8, t7: 0.02 }),
    });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("shadow"),
      provider,
    });
    const full = planExtractSignals(vault, SESSION, { now: NOW, sourceTurnHint: true });
    expect(JSON.stringify(plan)).toBe(JSON.stringify(full));
    expect(plan.turnsDropped).toBeUndefined();
    expect(plan.skipped).toBeUndefined();
    // The only change against off: one optional schema hint line.
    const offHints = offPlan().llmStep.schema_hints ?? [];
    const hints = full.llmStep.schema_hints ?? [];
    expect(hints.slice(0, offHints.length)).toEqual([...offHints]);
    expect(hints.slice(offHints.length)).toHaveLength(1);
    expect(hints.at(-1)).toContain("source_turn");

    expect(provider.requests).toHaveLength(1);
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    const payload = records[0]!.payload;
    expect(payload["use"]).toBe("extract_prefilter");
    expect(payload["mode"]).toBe("shadow");
    expect(payload["session_id"]).toBe(SESSION);
    expect(payload["turn_ids"]).toEqual(["t1", "t3", "t5", "t7"]);
    expect(payload["probabilities"]).toEqual([0.9, 0.01, 0.8, 0.02]);
    const serialized = JSON.stringify(records);
    for (const text of Object.values(TURN_TEXTS)) expect(serialized).not.toContain(text);
  });
});

describe("enforce", () => {
  test("drops only below the threshold and keeps record order", async () => {
    const provider = new FakeDecisionProvider({
      answer: byText({ t1: 0.9, t3: 0.05, t5: EXTRACT_PREFILTER_DROP_BELOW, t7: 0.02 }),
    });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce"),
      provider,
    });
    expect(plan.turnsMined.map((t) => t.turnId)).toEqual(["t1", "t5"]);
    expect(plan.turnsDropped).toEqual(["t3", "t7"]);
    expect(plan.skipped).toBeUndefined();
    const prompt = plan.llmStep!.prompt;
    expect(prompt).toContain("the 2 user turn(s)");
    // Every turn line carries its timestamp: `[turnId @ <timestamp>] text`.
    expect(prompt).toContain("[t1 @ ");
    expect(prompt.indexOf("[t1 @ ")).toBeLessThan(prompt.indexOf("[t5 @ "));
    expect(prompt).not.toContain("[t3 @ ");
    expect(prompt).not.toContain("[t7 @ ");
  });

  test("an invalid item keeps its turn", async () => {
    const provider = new FakeDecisionProvider({
      answer: byText({ t1: { invalid: true }, t3: 0.01, t5: 0.01, t7: 0.01 }),
    });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce"),
      provider,
    });
    expect(plan.turnsMined.map((t) => t.turnId)).toEqual(["t1"]);
    expect(plan.turnsDropped).toEqual(["t3", "t5", "t7"]);
  });

  test("every turn below the threshold skips the envelope", async () => {
    const provider = new FakeDecisionProvider({ answer: () => 0.01 });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce"),
      provider,
      tokenImpactEnabled: true,
    });
    expect(plan.llmStep).toBeNull();
    expect(plan.skipped).toEqual({ reason: EXTRACT_PREFILTER_SKIP_REASON, turnsDropped: 4 });
    expect(plan.turnsDropped).toEqual(["t1", "t3", "t5", "t7"]);
    expect(plan.turnsMined).toEqual([]);
    const samples = listContinuityRecords(vault, { kind: "token_impact" });
    expect(samples).toHaveLength(1);
    const s = samples[0]!.payload;
    expect(s["source"]).toBe(EXTRACT_PREFILTER_TOKEN_SOURCE);
    expect(s["packed_tokens"]).toBe(0);
    expect(s["baseline_tokens"] as number).toBeGreaterThan(0);
    expect(s["modeled_avoided_inferences"]).toBe(1);
    expect(s["session_id"]).toBe(SESSION);
    // A skipped envelope is never a fake generation report.
    expect(listContinuityRecords(vault, { kind: "generation_report" })).toHaveLength(0);
  });

  test("a partial drop records baseline versus packed tokens", async () => {
    const provider = new FakeDecisionProvider({
      answer: byText({ t1: 0.9, t3: 0.01, t5: 0.9, t7: 0.9 }),
    });
    await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce"),
      provider,
      tokenImpactEnabled: true,
    });
    const s = listContinuityRecords(vault, { kind: "token_impact" })[0]!.payload;
    expect(s["packed_tokens"] as number).toBeGreaterThan(0);
    expect(s["packed_tokens"] as number).toBeLessThan(s["baseline_tokens"] as number);
    expect(s["modeled_avoided_inferences"]).toBeUndefined();
  });

  test("without the ledger opt-in no token_impact sample is written", async () => {
    const provider = new FakeDecisionProvider({ answer: () => 0.01 });
    await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce"),
      provider,
    });
    expect(listContinuityRecords(vault, { kind: "token_impact" })).toHaveLength(0);
  });
});

describe("budget split", () => {
  test("splits into several requests that fit, and every turn is scored", async () => {
    // Room for about two short turns per request beside the question allowance.
    const maxStateTokens = 256 + 70;
    const provider = new FakeDecisionProvider({
      answer: byText({ t1: 0.9, t3: 0.01, t5: 0.9, t7: 0.01 }),
    });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce", { maxStateTokens }),
      provider,
    });
    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.length).toBeLessThan(4);
    for (const req of provider.requests) {
      expect(estimateTokens(req.state) + QUESTION_TOKEN_ALLOWANCE).toBeLessThanOrEqual(
        maxStateTokens,
      );
    }
    const scored = listDecisionModelCalls(vault).flatMap((r) => r.payload["turn_ids"] as string[]);
    // Records share one timestamp, so their listing order is not the send order.
    expect(scored.toSorted()).toEqual(["t1", "t3", "t5", "t7"]);
    expect(plan.turnsMined.map((t) => t.turnId)).toEqual(["t1", "t5"]);
  });

  test("a turn that does not fit even alone is unscored and kept", async () => {
    importSessionRecall(vault, {
      sessionId: "sess-big",
      turns: [
        turn("a", "user", "short one"),
        turn("big", "user", "x".repeat(1900)),
        turn("b", "user", "short two"),
      ],
      createdAt: NOW.toISOString(),
    });
    const provider = new FakeDecisionProvider({ answer: () => 0.01 });
    const plan = await planExtractSignalsPrefiltered(vault, "sess-big", {
      now: NOW,
      decisionModel: config("enforce", { maxStateTokens: 256 + 40 }),
      provider,
    });
    // The short turns are scored and dropped; the oversized one is kept.
    expect(plan.turnsMined.map((t) => t.turnId)).toEqual(["big"]);
    expect(plan.turnsDropped).toEqual(["a", "b"]);
    expect(plan.decisionModel).toBeUndefined();
    const outcomes = listDecisionModelCalls(vault).map((r) => r.payload["outcome"]);
    expect(outcomes).toContain("budget");
  });
});

describe("failure", () => {
  const reasons: DecisionDegradeReason[] = [
    "timeout",
    "network",
    "invalid_reply",
    "egress_refused",
    "http_401",
    "http_529",
  ];
  for (const reason of reasons) {
    test(`${reason}: all turns go into the envelope and the reason is named`, async () => {
      for (const mode of ["shadow", "enforce"] as const) {
        const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
          now: NOW,
          decisionModel: config(mode),
          provider: new FakeDecisionProvider({ fail: reason }),
        });
        const full = planExtractSignals(vault, SESSION, { now: NOW, sourceTurnHint: true });
        expect(plan.decisionModel).toEqual({ degraded: reason });
        expect(JSON.stringify(plan.llmStep)).toBe(JSON.stringify(full.llmStep));
        expect(plan.turnsMined).toEqual(full.turnsMined);
        expect(plan.turnsDropped).toBeUndefined();
      }
      expect(listDecisionModelCalls(vault).map((r) => r.payload["outcome"])).toEqual([
        reason,
        reason,
      ]);
    });
  }

  test("cost gate: nothing is sent and all turns are kept", async () => {
    const provider = new FakeDecisionProvider({ answer: () => 0.01 });
    const plan = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce", { dailyCostGateUsd: 1e-12 }),
      provider,
    });
    // The first plan spends; the gate then refuses the next one.
    expect(plan.llmStep).toBeNull();
    const gated = await planExtractSignalsPrefiltered(vault, SESSION, {
      now: NOW,
      decisionModel: config("enforce", { dailyCostGateUsd: 1e-12 }),
      provider,
    });
    expect(gated.decisionModel).toEqual({ degraded: "cost_gate" });
    expect(gated.turnsMined).toHaveLength(4);
    expect(provider.requests).toHaveLength(1);
  });
});

test("private regions never reach the provider", async () => {
  importSessionRecall(vault, {
    sessionId: "sess-private",
    turns: [
      turn("p1", "user", "Prefer tabs. <private>my home address is secret-lane 7</private>"),
      turn("p2", "user", "Use short commit titles."),
    ],
    createdAt: NOW.toISOString(),
  });
  const provider = new FakeDecisionProvider({ answer: () => 0.9 });
  await planExtractSignalsPrefiltered(vault, "sess-private", {
    now: NOW,
    decisionModel: config("shadow"),
    provider,
  });
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests[0]!.state)).not.toContain("secret-lane");
  expect(JSON.stringify(provider.requests[0]!.state)).toContain("Prefer tabs.");
});
