/**
 * `report --use skills` metrics (issue #213, Part 3): offer-hit and
 * needless-offer rates of the decision set against BM25, over synthetic
 * `decision_model_call` and `skill_invoked` records.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { emitDecisionModelCall } from "../../../src/core/decision-model/record.ts";
import {
  buildSkillsDecisionReport,
  renderSkillsDecisionReport,
} from "../../../src/core/decision-model/reports/skills.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-skills-report-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function selection(
  id: string,
  details: Record<string, unknown>,
  opts: { final?: boolean; origin?: "eval" } = {},
): void {
  emitDecisionModelCall(vault, {
    use: "skills",
    mode: "shadow",
    provider: "fake",
    model: "fake-model-1",
    calibrated: true,
    questionCount: 2,
    candidateCount: 3,
    inputPriceUsdPerMtok: null,
    latencyMs: 5,
    outcome: "ok",
    details: { correlation_id: id, final: opts.final ?? true, ...details },
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  });
}

function invoked(skill: string, offerId: string): void {
  appendContinuityRecord(vault, {
    kind: "skill_invoked",
    createdAt: new Date().toISOString(),
    sourceRefs: [],
    payload: { skill, offer_id: offerId },
  });
}

test("hit and needless rates, next to BM25", () => {
  // 1: agent used a skill both sets contain.
  selection("c1", {
    deterministic_offered: ["a", "b"],
    decision_offered: ["a"],
    offer_id: "0000000000000001",
  });
  invoked("a", "0000000000000001");
  // 2: agent used a skill the decision dropped.
  selection("c2", {
    deterministic_offered: ["a", "b"],
    decision_offered: ["a"],
    offer_id: "0000000000000002",
  });
  invoked("b", "0000000000000002");
  // 3: nothing used; the decision offered nothing.
  selection("c3", {
    deterministic_offered: ["c"],
    decision_offered: [],
    offer_id: "0000000000000003",
  });
  // 4: nothing used; both offered something.
  selection("c4", {
    deterministic_offered: ["c"],
    decision_offered: ["c"],
    offer_id: "0000000000000004",
  });
  // 5: fell back, not compared; the stage-1 record of a two-stage run is not final.
  selection("c5", { deterministic_offered: ["a"], offer_id: "0000000000000005" });
  selection("c6", { deterministic_offered: ["a"] }, { final: false });
  // 7: eval-origin records are ignored.
  selection("c7", { deterministic_offered: ["a"], decision_offered: [] }, { origin: "eval" });

  const report = buildSkillsDecisionReport(vault);
  expect(report.compared).toBe(4);
  expect(report.fallback).toBe(1);
  expect(report.invoked).toBe(2);
  expect(report.decision).toEqual({ offer_hit_rate: 0.5, needless_offer_rate: 0.25 });
  expect(report.bm25).toEqual({ offer_hit_rate: 1, needless_offer_rate: 0.5 });
  expect(report.enforce_recommended).toBe(false);
  expect(renderSkillsDecisionReport(report)).toContain(
    "needless-offer rate: decision 25.0%, BM25 50.0%",
  );
});

test("enforce is recommended only when hits hold and needless offers fall", () => {
  selection("c1", {
    deterministic_offered: ["a", "b"],
    decision_offered: ["a"],
    offer_id: "0000000000000001",
  });
  invoked("a", "0000000000000001");
  selection("c2", {
    deterministic_offered: ["c"],
    decision_offered: [],
    offer_id: "0000000000000002",
  });
  expect(buildSkillsDecisionReport(vault).enforce_recommended).toBe(true);
});

test("no records: empty rates and no recommendation", () => {
  const report = buildSkillsDecisionReport(vault);
  expect(report.compared).toBe(0);
  expect(report.decision.offer_hit_rate).toBeNull();
  expect(report.enforce_recommended).toBe(false);
});
