/**
 * Rerank kind `decision-model` (issue #213, Part 2), driven through
 * `applyCrossEncoderRerank` with an injected fake decision provider.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyCrossEncoderRerank } from "../../../src/core/search/rerank/index.ts";
import { decisionRerankOrder } from "../../../src/core/search/rerank/decision-model.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";
import type { DecisionModelMode } from "../../../src/core/decision-model/contract.ts";
import {
  activeDecisionConfig,
  FakeDecisionProvider,
  type ScriptedAnswer,
} from "../../helpers/fake-decision-provider.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempVault(): string {
  const v = mkdtempSync(join(tmpdir(), "osb-dm-rerank-"));
  dirs.push(v);
  return v;
}

function result(id: number): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `note-${id}.md`,
    title: `Note ${id}`,
    content: `content of note ${id}`,
    startLine: 1,
    endLine: 2,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0.5,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
  });
}

const RESULTS = [0, 1, 2, 3, 4].map(result);

function config(
  mode: Exclude<DecisionModelMode, "off">,
  opts: { vault?: string | null; answerable?: DecisionModelMode; topK?: number } = {},
): ResolvedRerankConfig {
  const base = activeDecisionConfig({ vault: opts.vault ?? null });
  return {
    enabled: true,
    kind: "decision-model",
    baseUrl: null,
    model: null,
    envKey: null,
    apiKey: null,
    topK: opts.topK ?? 4,
    minScore: 0,
    decisionModel: {
      ...base,
      uses: { ...base.uses, rerank: mode, answerable: opts.answerable ?? "off" },
    },
  };
}

/** Relevance by passage text: the note number maps to a probability. */
function byNote(
  rel: Record<number, ScriptedAnswer>,
  inj: Record<number, number> = {},
  answerable?: number,
) {
  return (id: string, req: { state: unknown }): ScriptedAnswer | undefined => {
    const passages = (req.state as { passages: Record<string, string> }).passages;
    const m = /^(rel|inj)_(\d+)$/.exec(id);
    if (m === null) return id === "answerable" ? answerable : undefined;
    const text = passages[`P${m[2]}`]!;
    const note = Number(/note (\d+)/.exec(text)![1]);
    return m[1] === "rel" ? rel[note] : (inj[note] ?? 0.01);
  };
}

const PUBLIC = (): ReadonlyArray<string> => [];
const NO_REGIONS = (): ReadonlyArray<string> => [];

describe("decision-model rerank", () => {
  test("enforce reorders the head by relevance and leaves the tail untouched", async () => {
    const provider = new FakeDecisionProvider({
      answer: byNote({ 0: 0.1, 1: 0.2, 2: 0.9, 3: 0.5 }),
    });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    expect(out.map((r) => r.path)).toEqual([
      "note-2.md",
      "note-3.md",
      "note-1.md",
      "note-0.md",
      "note-4.md",
    ]);
    expect(out[0]!.reasons).toContain("decision_model: 0.9000");
    expect(out[4]).toBe(RESULTS[4]!);
    // One request carrying one relevance and one injection question per candidate.
    expect(provider.requests).toHaveLength(1);
    expect(Object.keys(provider.requests[0]!.questions).toSorted()).toEqual(
      ["inj_0", "inj_1", "inj_2", "inj_3", "rel_0", "rel_1", "rel_2", "rel_3"].toSorted(),
    );
  });

  test("shadow returns the heuristic order unchanged and records both orders", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({
      answer: byNote({ 0: 0.1, 1: 0.2, 2: 0.9, 3: 0.5 }),
    });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("shadow", { vault }), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    expect(out).toBe(RESULTS);
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      use: "rerank",
      mode: "shadow",
      outcome: "ok",
      heuristic_order: ["note-0.md", "note-1.md", "note-2.md", "note-3.md"],
      decision_order: ["note-2.md", "note-3.md", "note-1.md", "note-0.md"],
    });
  });

  test("private and unresolvable candidates are never sent and keep their slot", async () => {
    const provider = new FakeDecisionProvider({ answer: byNote({ 0: 0.1, 2: 0.2, 3: 0.9 }) });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: (path) =>
        path === "note-1.md" ? ["private"] : path === "note-4.md" ? null : [],
    });
    const sent = JSON.stringify(provider.requests[0]!.state);
    expect(sent).not.toContain("note 1");
    expect(out[1]).toBe(RESULTS[1]!);
    expect(out.map((r) => r.path)).toEqual([
      "note-3.md",
      "note-1.md",
      "note-2.md",
      "note-0.md",
      "note-4.md",
    ]);
  });

  test("a private page is not named in the accounting record", async () => {
    const vault = tempVault();
    await applyCrossEncoderRerank(RESULTS, "q", config("shadow", { vault }), {
      decisionProvider: new FakeDecisionProvider({ answer: byNote({ 0: 0.1, 2: 0.2, 3: 0.9 }) }),
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: (path) => (path === "note-1.md" ? ["private"] : []),
    });
    const payload = listDecisionModelCalls(vault)[0]!.payload;
    expect(payload["heuristic_order"]).toEqual([
      "note-0.md",
      "(withheld)",
      "note-2.md",
      "note-3.md",
    ]);
    expect(JSON.stringify(payload)).not.toContain("note-1.md");
  });

  test("without a visibility resolver nothing is sent and the order is unchanged", async () => {
    const provider = new FakeDecisionProvider();
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
    });
    expect(out).toBe(RESULTS);
    expect(provider.requests).toHaveLength(0);
  });

  test("an invalid item keeps its heuristic position", async () => {
    const provider = new FakeDecisionProvider({
      answer: byNote({ 0: 0.1, 1: { invalid: true }, 2: 0.9, 3: 0.5 }),
    });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    expect(out[1]).toBe(RESULTS[1]!);
    expect(out.map((r) => r.path).slice(0, 4)).toEqual([
      "note-2.md",
      "note-1.md",
      "note-3.md",
      "note-0.md",
    ]);
  });

  test("a suspected injection is tagged but keeps its place by relevance", async () => {
    const provider = new FakeDecisionProvider({
      answer: byNote({ 0: 0.1, 1: 0.2, 2: 0.95, 3: 0.5 }, { 2: 0.85 }),
    });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    expect(out.map((r) => r.path).slice(0, 4)).toEqual([
      "note-2.md",
      "note-3.md",
      "note-1.md",
      "note-0.md",
    ]);
    expect(out[0]!.reasons).toContain("decision_model_injection_suspected");
    expect(out[1]!.reasons).not.toContain("decision_model_injection_suspected");
  });

  test("a suspected injection is tagged even when its relevance answer is invalid", async () => {
    const provider = new FakeDecisionProvider({
      answer: byNote({ 0: 0.1, 1: { invalid: true }, 2: 0.9, 3: 0.5 }, { 1: 0.9 }),
    });
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    expect(out[1]!.path).toBe("note-1.md");
    expect(out[1]!.reasons).toContain("decision_model_injection_suspected");
    expect(out[1]!.reasons.some((r) => r.startsWith("decision_model: "))).toBe(false);
  });

  test("an enforce record carries a permutation, not the paths", async () => {
    const vault = tempVault();
    await applyCrossEncoderRerank(RESULTS, "q", config("enforce", { vault }), {
      decisionProvider: new FakeDecisionProvider({
        answer: byNote({ 0: 0.1, 1: 0.2, 2: 0.9, 3: 0.5 }),
      }),
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
    });
    const payload = listDecisionModelCalls(vault)[0]!.payload;
    expect(payload["decision_permutation"]).toEqual([2, 3, 1, 0]);
    expect(payload["heuristic_order"]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("note-");
  });

  test("without a private-region resolver nothing is sent", async () => {
    const provider = new FakeDecisionProvider();
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce"), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
    });
    expect(out).toBe(RESULTS);
    expect(provider.requests).toHaveLength(0);
  });

  test("a provider failure returns the heuristic order with no warning", async () => {
    const vault = tempVault();
    const events: unknown[] = [];
    const out = await applyCrossEncoderRerank(RESULTS, "q", config("enforce", { vault }), {
      decisionProvider: new FakeDecisionProvider({ fail: "timeout" }),
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
      onTelemetry: (e) => events.push(e),
    });
    expect(out).toBe(RESULTS);
    expect(events).toEqual([]);
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("timeout");
  });

  test("the answerable question rides along only when that use is not off", async () => {
    const off = new FakeDecisionProvider({ answer: byNote({ 0: 0.5 }, {}, 0.7) });
    let extras: unknown;
    await applyCrossEncoderRerank(RESULTS, "q", config("shadow"), {
      decisionProvider: off,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
      onDecisionExtras: (e) => {
        extras = e;
      },
    });
    expect(Object.keys(off.requests[0]!.questions)).not.toContain("answerable");
    expect(extras).toBeUndefined();

    const on = new FakeDecisionProvider({ answer: byNote({ 0: 0.5 }, {}, 0.7) });
    await applyCrossEncoderRerank(RESULTS, "q", config("shadow", { answerable: "shadow" }), {
      decisionProvider: on,
      resolvePrivateRegions: NO_REGIONS,
      resolveVisibility: PUBLIC,
      onDecisionExtras: (e) => {
        extras = e;
      },
    });
    expect(Object.keys(on.requests[0]!.questions)).toContain("answerable");
    expect(extras).toEqual({
      answerable: { probability: 0.7, model: "fake-model-1", calibrated: true },
    });
  });
});

describe("decisionRerankOrder", () => {
  test("below-floor candidates keep their relative order under the qualifying ones", () => {
    expect(decisionRerankOrder([0.2, 0.9, 0.1, 0.6], 0.5)).toEqual([1, 3, 0, 2]);
  });
});
