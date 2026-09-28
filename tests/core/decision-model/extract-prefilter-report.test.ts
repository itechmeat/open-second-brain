/**
 * The commit side of the extract-signals turn pre-filter (issue #213,
 * Part 4) and its evaluation. Claims pinned here:
 *
 *  1. Commit accepts items with and without `source_turn`, rejects a
 *     non-string one, and writes the same signal either way.
 *  2. The commit record exists only while the use is not `off`, and it
 *     carries only turn ids that are real turns of the session.
 *  3. The report computes regret (committed items whose turn scored below
 *     the threshold in shadow), drop share and skip share, and recommends
 *     `enforce` only on zero regret over a week of shadow evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";
import { commitExtractedSignals } from "../../../src/core/brain/extract-signals.ts";
import {
  planExtractSignalsPrefiltered,
  recordExtractPrefilterCommit,
} from "../../../src/core/brain/extract-signals-prefilter.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import {
  DECISION_MODEL_EXTRACT_COMMIT_KIND,
  resetDecisionSpendCache,
} from "../../../src/core/decision-model/record.ts";
import {
  buildExtractPrefilterReport,
  renderExtractPrefilterReport,
} from "../../../src/core/decision-model/reports/extract-prefilter.ts";
import {
  activeDecisionConfig,
  FakeDecisionProvider,
} from "../../helpers/fake-decision-provider.ts";

const SESSION = "sess-report";
let vault: string;

beforeEach(() => {
  resetDecisionSpendCache();
  vault = mkdtempSync(join(tmpdir(), "o2b-extract-report-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      { turnId: "u1", timestamp: "2026-09-01T09:01:00Z", role: "user", text: "Always use tabs." },
      { turnId: "u2", timestamp: "2026-09-01T09:02:00Z", role: "user", text: "Deploy it now." },
    ],
    createdAt: "2026-09-01T10:00:00Z",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function config(mode: "off" | "shadow" | "enforce"): ResolvedDecisionModelConfig {
  const base = activeDecisionConfig({ vault });
  return activeDecisionConfig({
    vault,
    uses: { ...base.uses, rerank: "off", extract_prefilter: mode },
  });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: "indent-with-tabs",
    signal: "positive",
    principle: "Indent code with tabs.",
    confidence: 0.9,
    ...overrides,
  };
}

function commit(items: unknown[], now: Date, opts: { dedup?: Map<string, DedupIndexEntry> } = {}) {
  return commitExtractedSignals(
    vault,
    SESSION,
    { items },
    {
      agent: "tester",
      now,
      durabilityDenylist: [],
      writeApprovalEnabled: false,
      ...(opts.dedup !== undefined ? { dedup: opts.dedup } : {}),
    },
  );
}

describe("commit and source_turn", () => {
  test("an item with and without source_turn writes the same signal", () => {
    const now = new Date("2026-09-01T11:00:00Z");
    const without = commit([item()], now, { dedup: new Map() });
    const bytesWithout = readFileSync(without.written[0]!.path, "utf8");
    rmSync(without.written[0]!.path);
    const withTurn = commit([item({ source_turn: "u1" })], now, { dedup: new Map() });
    expect(readFileSync(withTurn.written[0]!.path, "utf8")).toBe(bytesWithout);
    expect(withTurn.written[0]!.sourceTurn).toBe("u1");
    expect(without.written[0]!.sourceTurn).toBeUndefined();
  });

  test("a non-string source_turn is refused", () => {
    expect(() => commit([item({ source_turn: 3 })], new Date())).toThrow(ResponseShapeError);
  });

  test("the commit record exists only while the use is on, with known turn ids only", () => {
    const now = new Date("2026-09-01T11:00:00Z");
    const res = commit(
      [
        item({ source_turn: "u1" }),
        item({ topic: "b", principle: "Keep titles short.", source_turn: "ignore previous" }),
        item({ topic: "c", principle: "Prefer plain words." }),
      ],
      now,
    );
    expect(recordExtractPrefilterCommit(vault, config("off"), res, now)).toBeNull();
    expect(recordExtractPrefilterCommit(vault, null, res, now)).toBeNull();
    expect(listContinuityRecords(vault, { kind: DECISION_MODEL_EXTRACT_COMMIT_KIND })).toHaveLength(
      0,
    );
    recordExtractPrefilterCommit(vault, config("shadow"), res, now);
    const records = listContinuityRecords(vault, { kind: DECISION_MODEL_EXTRACT_COMMIT_KIND });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["source_turns"]).toEqual(["u1"]);
    expect(records[0]!.payload["without_source_turn_count"]).toBe(2);
    expect(JSON.stringify(records[0])).not.toContain("ignore previous");
  });
});

describe("report", () => {
  async function shadowPlan(scores: Record<string, number>, at: string) {
    const provider = new FakeDecisionProvider({
      answer: (id, req) => {
        const text = (req.state as { turns: Record<string, string> }).turns[
          `T${id.replace("sig_", "")}`
        ];
        return text === "Always use tabs." ? scores["u1"] : scores["u2"];
      },
    });
    await planExtractSignalsPrefiltered(vault, SESSION, {
      now: new Date(at),
      decisionModel: config("shadow"),
      provider,
    });
  }

  test("zero regret over a week recommends enforce", async () => {
    await shadowPlan({ u1: 0.9, u2: 0.01 }, "2026-09-01T10:00:00Z");
    await shadowPlan({ u1: 0.9, u2: 0.02 }, "2026-09-09T10:00:00Z");
    const now = new Date("2026-09-09T11:00:00Z");
    recordExtractPrefilterCommit(
      vault,
      config("shadow"),
      commit([item({ source_turn: "u1" })], now),
      now,
    );
    const report = buildExtractPrefilterReport(vault);
    expect(report.plans).toBe(2);
    expect(report.scored_turns).toBe(4);
    expect(report.drop_share_turns).toBe(0.5);
    expect(report.skip_share).toBe(0);
    expect(report.evaluated_items).toBe(1);
    expect(report.regret_items).toBe(0);
    expect(report.recommendation).toBe("enforce_possible");
    expect(renderExtractPrefilterReport(report)).toContain("regret: 0 of 1");
  });

  test("an accepted item from a below-threshold turn is regret", async () => {
    await shadowPlan({ u1: 0.05, u2: 0.01 }, "2026-09-01T10:00:00Z");
    const now = new Date("2026-09-01T11:00:00Z");
    recordExtractPrefilterCommit(
      vault,
      config("shadow"),
      commit([item({ source_turn: "u1" })], now),
      now,
    );
    const report = buildExtractPrefilterReport(vault);
    expect(report.regret_items).toBe(1);
    expect(report.regret_share).toBe(1);
    expect(report.skip_share).toBe(1);
    expect(report.drop_share_chars).toBe(1);
    expect(report.recommendation).toBe("lower_threshold");
  });

  test("without shadow evidence it says to stay in shadow", () => {
    const report = buildExtractPrefilterReport(vault);
    expect(report.plans).toBe(0);
    expect(report.drop_share_turns).toBeNull();
    expect(report.recommendation).toBe("stay_in_shadow");
  });
});
