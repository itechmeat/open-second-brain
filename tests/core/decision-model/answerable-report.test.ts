/**
 * `report --use answerable` (issue #213, Part 8): the rerank signal by
 * band, the confusion table of deterministic level against advisory band,
 * and whether disagreements predicted a poor context-pack outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postContextPackOutcome } from "../../../src/core/brain/context-pack-outcome.ts";
import { emitContextReceipt } from "../../../src/core/brain/context-receipts.ts";
import { emitGateTelemetry } from "../../../src/core/brain/gate-telemetry.ts";
import {
  assessRecallAdequacy,
  type RecallAdequacyVerdict,
} from "../../../src/core/brain/recall-adequacy.ts";
import { assessDecisionAnswerable } from "../../../src/core/decision-model/answerable.ts";
import { emitDecisionModelCall } from "../../../src/core/decision-model/record.ts";
import {
  buildAnswerableReport,
  renderAnswerableReport,
} from "../../../src/core/decision-model/reports/answerable.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-dm-answerable-report-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function rerankRecord(probability: number | null): void {
  emitDecisionModelCall(vault, {
    use: "rerank",
    mode: "shadow",
    provider: "fake",
    model: "fake-model-1",
    calibrated: true,
    questionCount: 3,
    candidateCount: 2,
    inputPriceUsdPerMtok: null,
    latencyMs: 10,
    outcome: "ok",
    details: probability === null ? {} : { answerable_probability: probability },
  });
}

function verdict(level: "sufficient" | "weak" | "insufficient"): RecallAdequacyVerdict {
  const quality = { sufficient: 0.9, weak: 0.4, insufficient: 0.1 }[level];
  const v = assessRecallAdequacy({ scores: [0.5], matchQuality: quality });
  expect(v.level).toBe(level);
  return v;
}

function gateRecord(level: "sufficient" | "weak" | "insufficient", p: number): void {
  const annotation = assessDecisionAnswerable(level, p);
  emitGateTelemetry(vault, {
    host: "test",
    prompt: "p",
    retrieve: true,
    reason: "r",
    decisionAnswerable: { level, ...annotation },
  });
}

function receipt(level: "sufficient" | "weak" | "insufficient", p: number): string {
  return emitContextReceipt(vault, {
    options: { host: "test", trigger: "context_pack" },
    items: [],
    finalText: "",
    adequacy: verdict(level),
    decisionAnswerable: assessDecisionAnswerable(level, p),
  }).id;
}

function outcome(sampleId: string, firstPassSuccess: boolean): void {
  postContextPackOutcome(vault, { sampleId, firstPassSuccess }, true);
}

describe("answerable report", () => {
  test("an empty vault reports zeros and no rates", () => {
    const report = buildAnswerableReport(vault);
    expect(report.signal.total).toBe(0);
    expect(report.confusion.total).toBe(0);
    expect(report.outcomes.disagree_poor_rate).toBeNull();
    expect(renderAnswerableReport(report)).toContain("0 rerank record(s)");
  });

  test("counts the rerank signal by band, edges in the middle band", () => {
    for (const p of [0.1, 0.3, 0.8, 0.95]) rerankRecord(p);
    rerankRecord(null);
    const report = buildAnswerableReport(vault);
    expect(report.signal).toEqual({ total: 4, bands: { low: 1, mid: 2, high: 1 } });
  });

  test("tabulates level against band over gate records and receipts", () => {
    gateRecord("sufficient", 0.1); // disagrees
    gateRecord("sufficient", 0.9);
    gateRecord("weak", 0.5);
    receipt("insufficient", 0.95); // disagrees
    receipt("insufficient", 0.2);
    // A gate record without the annotation is not counted.
    emitGateTelemetry(vault, { host: "test", prompt: "p", retrieve: true, reason: "r" });
    const report = buildAnswerableReport(vault);
    expect(report.confusion.total).toBe(5);
    expect(report.confusion.disagreements).toBe(2);
    expect(report.confusion.rows).toEqual({
      sufficient: { low: 1, mid: 0, high: 1 },
      weak: { low: 0, mid: 1, high: 0 },
      insufficient: { low: 1, mid: 0, high: 1 },
    });
  });

  test("joins receipts to their outcome rows and compares poor-outcome rates", () => {
    const disagreeing = [receipt("sufficient", 0.05), receipt("sufficient", 0.1)];
    const agreeing = [receipt("sufficient", 0.9), receipt("sufficient", 0.7)];
    receipt("sufficient", 0.2); // no outcome row: counted in the table, not joined
    outcome(disagreeing[0]!, false);
    outcome(disagreeing[1]!, false);
    outcome(agreeing[0]!, true);
    outcome(agreeing[1]!, false);
    const report = buildAnswerableReport(vault);
    expect(report.outcomes).toEqual({
      joined: 4,
      disagreeing: { total: 2, poor: 2 },
      agreeing: { total: 2, poor: 1 },
      disagree_poor_rate: 1,
      agree_poor_rate: 0.5,
    });
    const text = renderAnswerableReport(report);
    expect(text).toContain("poor when disagreeing 2/2 (100.0%)");
    expect(text).toContain("when agreeing 1/2 (50.0%)");
  });

  test("since excludes older records", () => {
    gateRecord("sufficient", 0.1);
    const report = buildAnswerableReport(vault, { since: "2999-01-01T00:00:00.000Z" });
    expect(report.confusion.total).toBe(0);
  });
});
