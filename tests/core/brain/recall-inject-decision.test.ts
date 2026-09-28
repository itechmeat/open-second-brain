/**
 * The recall-inject decision-model filter (issue #213, Part 9) over the
 * pure decision core, with an in-process fake provider. The real hook
 * entry is driven against a loopback fake server in
 * `tests/hooks/recall-inject-decision-model.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  decideRecallInject,
  RECALL_INJECT_TIME_BUDGET_MS,
  recallInjectAuditDetails,
  recallInjectFilterOutcome,
  recallInjectTelemetryMetadata,
  type RecallCandidate,
  type RecallInjectDecision,
  type RecallInjectFilter,
  type RecallRetriever,
} from "../../../src/core/brain/recall-inject.ts";
import { createRecallInjectDecisionFilter } from "../../../src/core/brain/recall-inject-decision.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import { resolveDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import { DECISION_MODEL_USES } from "../../../src/core/decision-model/contract.ts";
import type { DecisionDegradeReason } from "../../../src/core/decision-model/contract.ts";
import {
  emitDecisionModelCall,
  listDecisionModelCalls,
} from "../../../src/core/decision-model/record.ts";
import {
  buildRecallInjectUseReport,
  renderRecallInjectUseReport,
} from "../../../src/core/decision-model/reports/recall-inject.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  activeDecisionConfig,
  FakeDecisionProvider,
  type FakeDecisionProviderOptions,
} from "../../helpers/fake-decision-provider.ts";

const PROMPT = "how does the heron migration schedule work";
const NOTE_TEXT = {
  a: "Heron migration schedule: the herons leave in October.",
  b: "Grocery list with bread and milk, nothing about herons.",
  c: "Heron nesting sites along the river, used every spring.",
  s: "Secret heron counts kept for the landowner only.",
};

const vaults: string[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) rmSync(v, { recursive: true, force: true });
});

function tempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "o2b-recall-dm-"));
  vaults.push(vault);
  const write = (rel: string, text: string): void => {
    const abs = join(vault, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  write("notes/a.md", `# Heron schedule\n\n${NOTE_TEXT.a}\n`);
  write("notes/b.md", `# Groceries\n\n${NOTE_TEXT.b}\n`);
  write("notes/c.md", `# Heron nests\n\n${NOTE_TEXT.c}\n`);
  write("notes/s.md", `---\nvisibility: private\n---\n# Counts\n\n${NOTE_TEXT.s}\n`);
  return vault;
}

function note(key: keyof typeof NOTE_TEXT, score: number): RecallCandidate {
  return {
    path: `notes/${key}.md`,
    title: `Title ${key}`,
    score,
    searchType: "hybrid",
    startLine: 1,
    endLine: 3,
    content: NOTE_TEXT[key],
  };
}

function retriever(
  notes: ReadonlyArray<RecallCandidate>,
  opts: { delayMs?: number; coverage?: number | null } = {},
): RecallRetriever {
  return async () => {
    if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      candidates: notes,
      total: notes.length,
      idfWeightedCoverage: opts.coverage === undefined ? 0.9 : opts.coverage,
    };
  };
}

function config(
  vault: string,
  mode: "shadow" | "enforce",
  overrides: Partial<ResolvedDecisionModelConfig> = {},
): ResolvedDecisionModelConfig {
  const uses = Object.fromEntries(DECISION_MODEL_USES.map((u) => [u, "off"])) as Record<
    string,
    string
  >;
  const all = { ...uses, recall_inject: mode } as ResolvedDecisionModelConfig["uses"];
  return activeDecisionConfig({ vault, uses: all, configuredUses: all, ...overrides });
}

/** helps_<k> by the note text the fake sees in `notes.N<k>`. */
function answerBy(
  helps: Partial<Record<keyof typeof NOTE_TEXT, number>>,
  injectAny = 0.9,
): FakeDecisionProviderOptions["answer"] {
  return (id, req) => {
    if (id === "inject_any") return injectAny;
    const k = id.slice("helps_".length);
    const state = req.state as { notes: Record<string, string> };
    const text = state.notes[`N${k}`] ?? "";
    for (const [key, p] of Object.entries(helps)) {
      if (text.includes(NOTE_TEXT[key as keyof typeof NOTE_TEXT])) return p;
    }
    return 0.9;
  };
}

async function decide(
  notes: ReadonlyArray<RecallCandidate>,
  filter: RecallInjectFilter | null,
  opts: { delayMs?: number; coverage?: number | null; prompt?: string } = {},
): Promise<RecallInjectDecision> {
  return decideRecallInject(
    opts.prompt ?? PROMPT,
    retriever(notes, opts),
    filter !== null ? { decisionFilter: filter } : {},
  );
}

const THREE = [note("a", 0.9), note("b", 0.8), note("c", 0.7)];

function allText(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoText(value: unknown): void {
  const text = allText(value);
  expect(text).not.toContain("heron migration");
  expect(text).not.toContain(PROMPT);
  for (const t of Object.values(NOTE_TEXT)) expect(text).not.toContain(t);
  for (const k of ["a", "b", "c", "s"]) expect(text).not.toContain(`Title ${k}`);
}

describe("recall_inject off: no filter, no request, no field", () => {
  test("every inactive configuration builds no filter", () => {
    const vault = tempVault();
    const env = { KEY_VAR: FAKE_DECISION_KEY };
    const base = {
      decision_model_provider: "compatible",
      decision_model_threshold_profile: "jev-1.13",
      decision_model_base_url: "https://decisions.example.test",
      decision_model_id: "fake-model-1",
      decision_model_env_key: "KEY_VAR",
      decision_model_uses: "recall_inject:enforce",
    };
    const cases: Array<ResolvedDecisionModelConfig | null> = [
      null,
      // 1. no key, no decision config
      resolveDecisionModelConfig({ env: {}, config: {}, vault }),
      // 2. key set, feature not enabled
      resolveDecisionModelConfig({ env, config: base, vault }),
      // 3. enabled, key variable not set
      resolveDecisionModelConfig({
        env: {},
        config: { ...base, decision_model_enabled: "true" },
        vault,
      }),
      // enabled with a key, but the use is off
      resolveDecisionModelConfig({
        env,
        config: { ...base, decision_model_enabled: "true", decision_model_uses: "rerank:shadow" },
        vault,
        vaultOptOut: () => false,
      }),
    ];
    for (const cfg of cases) {
      expect(createRecallInjectDecisionFilter({ config: cfg, vault })).toBeNull();
    }
    // 4. enabled AND the key: a filter exists.
    const active = resolveDecisionModelConfig({
      env,
      config: { ...base, decision_model_enabled: "true" },
      vault,
      vaultOptOut: () => false,
    });
    expect(active.status).toBe("active");
    expect(createRecallInjectDecisionFilter({ config: active, vault })?.mode).toBe("enforce");
  });

  test("without a filter the decision, telemetry and audit carry no decision_model field", async () => {
    const decision = await decide(THREE, null);
    expect(decision.kind).toBe("inject");
    expect("decisionModel" in decision).toBe(false);
    expect(recallInjectTelemetryMetadata(decision)["decision_model"]).toBeUndefined();
    expect(recallInjectAuditDetails(decision)["decision_model"]).toBeUndefined();
  });
});

describe("recall_inject shadow", () => {
  test("today's brief goes out byte for byte, one record with paths and probabilities", async () => {
    const vault = tempVault();
    const today = await decide(THREE, null);
    const provider = new FakeDecisionProvider({ answer: answerBy({ b: 0.05 }) });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "shadow"),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject" || today.kind !== "inject") return;
    expect(decision.brief).toBe(today.brief);
    expect(decision.noteCount).toBe(today.noteCount);
    expect(provider.requests).toHaveLength(1);
    expect(Object.keys(provider.requests[0]!.questions).toSorted()).toEqual([
      "helps_0",
      "helps_1",
      "helps_2",
      "inject_any",
    ]);
    // Shadow reports what enforce would have done.
    expect(decision.decisionModel).toMatchObject({
      mode: "shadow",
      outcome: "ok",
      notesDropped: 1,
      abstained: false,
      charsRemoved: 0,
    });
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    const p = records[0]!.payload;
    expect(p["use"]).toBe("recall_inject");
    expect(p["mode"]).toBe("shadow");
    expect(p["note_paths"]).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    expect(p["helps"]).toEqual([0.9, 0.05, 0.9]);
    expect(p["inject_any"]).toBe(0.9);
    expect(p["notes_dropped"]).toBe(1);
    expect(p["abstained"]).toBe(false);
    expectNoText(p);
  });
});

describe("recall_inject enforce", () => {
  test("drops a note below the note floor and re-renders with the same renderer", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({ answer: answerBy({ b: 0.05 }) });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    const expected = await decide([note("a", 0.9), note("c", 0.7)], null, {});
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject" || expected.kind !== "inject") return;
    expect(decision.noteCount).toBe(2);
    expect(decision.brief).not.toContain("notes/b.md");
    expect(decision.brief).toContain("notes/a.md");
    expect(decision.brief).toContain("notes/c.md");
    // Same renderer and caps over the survivors (the hint's total differs
    // only through `total`, which both calls set to the candidate count).
    expect(decision.brief.split("\n").filter((l) => l.startsWith("- "))).toEqual(
      expected.brief.split("\n").filter((l) => l.startsWith("- ")),
    );
    expect(decision.decisionModel).toMatchObject({
      mode: "enforce",
      outcome: "ok",
      notesDropped: 1,
      abstained: false,
    });
    expect(decision.decisionModel!.charsRemoved).toBeGreaterThan(0);
    expect(decision.decisionModel!.tokensAfter!).toBeLessThan(
      decision.decisionModel!.tokensBefore!,
    );
  });

  test("inject_any below its floor abstains with decision_model_abstain", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({ answer: answerBy({}, 0.1) });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    expect(decision).toMatchObject({ kind: "abstain", reason: "decision_model_abstain" });
    if (decision.kind !== "abstain") return;
    expect(decision.decisionModel).toMatchObject({ abstained: true, notesDropped: 3 });
    expect(recallInjectTelemetryMetadata(decision)).toMatchObject({
      decision: "abstain",
      reason: "decision_model_abstain",
      decision_model: { mode: "enforce", outcome: "ok", abstained: true, notes_dropped: 3 },
    });
  });

  test("every note below the note floor abstains", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({
      answer: answerBy({ a: 0.1, b: 0.1, c: 0.1 }, 0.5),
    });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    expect(decision).toMatchObject({ kind: "abstain", reason: "decision_model_abstain" });
  });

  test("invalid answers keep their note; nothing is ever added", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({
      answer: () => ({ invalid: true }),
    });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const today = await decide(THREE, null);
    const decision = await decide(THREE, filter);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject" || today.kind !== "inject") return;
    expect(decision.brief).toBe(today.brief);
    expect(decision.decisionModel).toMatchObject({ notesDropped: 0, abstained: false });
  });

  test("a private note is never sent, keeps its place, and blocks an inject_any abstain", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({ answer: answerBy({ b: 0.05 }, 0.05) });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const notes = [note("a", 0.9), note("s", 0.85), note("b", 0.8)];
    const decision = await decide(notes, filter);
    expect(allText(provider.requests)).not.toContain(NOTE_TEXT.s);
    expect(Object.keys(provider.requests[0]!.questions)).toHaveLength(3); // two notes + inject_any
    // inject_any judged only the sent notes, so it cannot withhold the private one.
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.brief).toContain("notes/s.md");
    expect(decision.brief).not.toContain("notes/b.md");
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["note_paths"]).toEqual(["notes/a.md", "(withheld)", "notes/b.md"]);
    expect(record["withheld_count"]).toBe(1);
  });

  test("notes from another origin and every note private: nothing sent, today's brief", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const notes = [{ ...note("a", 0.9), origin: "source/other" }, note("s", 0.8)];
    const today = await decide(notes, null);
    const decision = await decide(notes, filter);
    expect(provider.requests).toHaveLength(0);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject" || today.kind !== "inject") return;
    expect(decision.brief).toBe(today.brief);
    expect(decision.decisionModel).toMatchObject({ outcome: "not_sent" });
  });

  test("the prompt's own <private> regions are stripped before sending", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    await decide(THREE, filter, { prompt: `${PROMPT} <private>pin 4321</private>` });
    expect(allText(provider.requests[0]!.state)).not.toContain("4321");
  });
});

describe("recall_inject failures keep today's decision", () => {
  const reasons: DecisionDegradeReason[] = ["timeout", "network", "invalid_reply", "http_529"];
  for (const reason of reasons) {
    test(`${reason}: today's brief, the reason only on the local audit line`, async () => {
      const vault = tempVault();
      const provider = new FakeDecisionProvider({ fail: reason });
      const filter = createRecallInjectDecisionFilter({
        config: config(vault, "enforce"),
        vault,
        provider,
      });
      const today = await decide(THREE, null);
      const decision = await decide(THREE, filter);
      expect(decision.kind).toBe("inject");
      if (decision.kind !== "inject" || today.kind !== "inject") return;
      expect(decision.brief).toBe(today.brief);
      const telemetry = recallInjectTelemetryMetadata(decision);
      expect(telemetry["decision_model"]).toMatchObject({ outcome: "degraded" });
      expect(allText(telemetry)).not.toContain(reason);
      expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
        outcome: "degraded",
        degrade_reason: reason,
      });
      expect(listDecisionModelCalls(vault).map((r) => r.payload["outcome"])).toEqual([reason]);
    });
  }

  test("cost gate: no request, today's brief", async () => {
    const vault = tempVault();
    emitDecisionModelCall(vault, {
      use: "recall_inject",
      mode: "enforce",
      provider: "fake",
      model: "m",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: 0.6 },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
    });
    const provider = new FakeDecisionProvider();
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce", { dailyCostGateUsd: 0.5 }),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    expect(provider.requests).toHaveLength(0);
    expect(decision.kind).toBe("inject");
    expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
      degrade_reason: "cost_gate",
    });
  });

  test("state budget: no request, today's brief", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce", { maxStateTokens: 10 }),
      vault,
      provider,
    });
    const decision = await decide(THREE, filter);
    expect(provider.requests).toHaveLength(0);
    expect(decision.kind).toBe("inject");
    expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
      degrade_reason: "budget",
    });
  });

  test("a throwing filter degrades like a failed request, never a thrown decision", async () => {
    const decision = await decide(THREE, {
      mode: "enforce",
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(decision.kind).toBe("inject");
    expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
      degrade_reason: "network",
    });
  });

  test("a slow fake beyond the sub-budget returns today's decision within the sub-budget", async () => {
    const vault = tempVault();
    // The abandoned request settles after the test; with no record vault
    // its late record cannot recreate the removed temp vault.
    const provider = new FakeDecisionProvider({ latencyMs: 5_000 });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce", { hookBudgetMs: 150, vault: null }),
      vault,
      provider,
    });
    const today = await decide(THREE, null);
    const started = Date.now();
    const decision = await decide(THREE, filter);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject" || today.kind !== "inject") return;
    expect(decision.brief).toBe(today.brief);
    expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
      degrade_reason: "timeout",
    });
  });

  test("the sub-budget never extends the total retrieval budget", async () => {
    const vault = tempVault();
    // The abandoned request settles after the test; with no record vault
    // its late record cannot recreate the removed temp vault.
    const provider = new FakeDecisionProvider({ latencyMs: 5_000 });
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce", { hookBudgetMs: 700, vault: null }),
      vault,
      provider,
    });
    const started = Date.now();
    // Retrieval eats all but ~200 ms of the 2,500 ms budget.
    const decision = await decide(THREE, filter, {
      delayMs: RECALL_INJECT_TIME_BUDGET_MS - 200,
    });
    const elapsed = Date.now() - started;
    expect(decision.kind).toBe("inject");
    expect(elapsed).toBeLessThan(RECALL_INJECT_TIME_BUDGET_MS + 100);
    expect(recallInjectAuditDetails(decision)["decision_model"]).toMatchObject({
      outcome: "degraded",
      degrade_reason: "timeout",
    });
  });
});

describe("abstentions and errors never trigger a request", () => {
  test("no matches, below floor, unmeasurable, empty prompt, retriever error, timeout", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    const filter = createRecallInjectDecisionFilter({
      config: config(vault, "enforce"),
      vault,
      provider,
    });
    const outcomes = [
      await decide([], filter),
      await decide(THREE, filter, { coverage: 0.05 }),
      await decide(THREE, filter, { coverage: null }),
      await decide(THREE, filter, { prompt: "   " }),
      await decideRecallInject(
        PROMPT,
        async () => {
          throw new Error("index missing");
        },
        { decisionFilter: filter! },
      ),
      await decideRecallInject(PROMPT, retriever(THREE, { delayMs: 200 }), {
        decisionFilter: filter!,
        timeBudgetMs: 50,
      }),
    ];
    expect(outcomes.map((d) => d.kind)).toEqual([
      "abstain",
      "abstain",
      "abstain",
      "abstain",
      "error",
      "error",
    ]);
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
    for (const d of outcomes)
      expect(recallInjectTelemetryMetadata(d)["decision_model"]).toBe(undefined);
  });
});

describe("telemetry, audit and record hold no prompt or note text", () => {
  test("shadow, enforce drop and enforce abstain", async () => {
    for (const [mode, injectAny] of [
      ["shadow", 0.9],
      ["enforce", 0.9],
      ["enforce", 0.05],
    ] as const) {
      const vault = tempVault();
      const provider = new FakeDecisionProvider({ answer: answerBy({ b: 0.05 }, injectAny) });
      const filter = createRecallInjectDecisionFilter({
        config: config(vault, mode),
        vault,
        provider,
      });
      // eslint-disable-next-line no-await-in-loop -- each case has its own vault
      const decision = await decide(THREE, filter);
      expectNoText(recallInjectTelemetryMetadata(decision));
      expectNoText(recallInjectAuditDetails(decision));
      expectNoText(listDecisionModelCalls(vault).map((r) => r.payload));
    }
  });
});

describe("recallInjectFilterOutcome", () => {
  test("the floors are inclusive: exactly 0.2 keeps the note and the brief", () => {
    expect(recallInjectFilterOutcome([0.2], [true], 0.2)).toEqual({ abstain: false, keep: [true] });
    expect(recallInjectFilterOutcome([0.19], [true], 0.2).abstain).toBe(true);
    expect(recallInjectFilterOutcome([0.9], [true], 0.19).abstain).toBe(true);
  });
});

describe("report --use recall_inject", () => {
  test("added latency, timeout rate, abstain rate and notes dropped next to hook telemetry", () => {
    const vault = tempVault();
    const call = (outcome: string, latencyMs: number, details: Record<string, unknown> = {}) =>
      emitDecisionModelCall(vault, {
        use: "recall_inject",
        mode: "shadow",
        provider: "fake",
        model: "m",
        calibrated: true,
        questionCount: 4,
        candidateCount: 3,
        inputPriceUsdPerMtok: null,
        latencyMs,
        outcome,
        details,
      });
    call("ok", 100, { abstained: false, notes_dropped: 1 });
    call("ok", 200, { abstained: true, notes_dropped: 3 });
    call("timeout", 700);
    call("cost_gate", 0);
    const hook = (metadata: Record<string, unknown>) =>
      emitRecallTelemetry(vault, {
        host: "recall-inject",
        channel: RECALL_CHANNEL.hook,
        mode: "search",
        status: "ok",
        durationMs: 0,
        resultCount: 0,
        metadata,
      });
    hook({ decision: "inject" });
    hook({ decision: "abstain", reason: "decision_model_abstain" });
    hook({ decision: "error", fault: "hook_ceiling_exceeded" });
    const report = buildRecallInjectUseReport(vault);
    expect(report.calls).toBe(4);
    expect(report.added_latency_p50_ms).toBe(200);
    expect(report.added_latency_p95_ms).toBe(700);
    expect(report.timeout_rate).toBeCloseTo(1 / 3, 9);
    expect(report.abstain_rate).toBe(0.5);
    expect(report.notes_dropped).toBe(4);
    expect(report.recall_telemetry).toMatchObject({
      decisions: 3,
      inject: 1,
      abstain: 1,
      decision_model_abstain: 1,
      error: 1,
      hook_ceiling_exceeded: 1,
    });
    const text = renderRecallInjectUseReport(report);
    expect(text).toContain("p95 700ms");
    expect(text).toContain("abstain rate 50.0%");
  });
});
