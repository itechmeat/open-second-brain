/**
 * Report metrics of the advisory uses (issue #213, Parts 5 and 6):
 * verdict bands joined to later operator actions, and label suggestion
 * acceptance joined to later `assign` operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoteContradictionFinding } from "../../../src/core/brain/health/contradiction.ts";
import { assignNoteLabel } from "../../../src/core/brain/labels.ts";
import { suggestNoteLabels } from "../../../src/core/brain/label-suggest.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import {
  dismissTension,
  persistTension,
  resolveTension,
} from "../../../src/core/brain/tensions.ts";
import { emitDecisionModelCall } from "../../../src/core/decision-model/record.ts";
import { buildLabelsReport } from "../../../src/core/decision-model/reports/labels.ts";
import { buildPairVerdictReport } from "../../../src/core/decision-model/reports/pair-verdict.ts";
import { activeDecisionConfig } from "../../helpers/fake-decision-provider.ts";
import { FakeChoiceProvider } from "../../helpers/fake-choice-decision.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dm-reports-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function record(use: string, pairKind: string, pairs: Array<Record<string, unknown>>, extra = {}) {
  emitDecisionModelCall(vault, {
    use: use as "dedup",
    mode: "shadow",
    provider: "fake",
    model: "m",
    calibrated: true,
    questionCount: pairs.length,
    candidateCount: pairs.length,
    inputPriceUsdPerMtok: null,
    latencyMs: 1,
    outcome: "ok",
    details: { pair_kind: pairKind, pairs },
    ...extra,
  });
}

function tension(aId: string, bId: string): string {
  const finding: NoteContradictionFinding = {
    aId,
    bId,
    subject: "s",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "a",
    bQuote: "b",
    action: "ask_user",
  };
  return persistTension(vault, finding, { agent: "t" }).record.slug;
}

describe("buildPairVerdictReport", () => {
  test("tension bands count what the operator did later", () => {
    const resolved = tension("n/a.md", "n/b.md");
    const dismissed = tension("n/c.md", "n/d.md");
    const open = tension("n/e.md", "n/f.md");
    record("tension", "tension", [
      { id: resolved, a: "n/a.md", b: "n/b.md", verdict: "contradicts", probability: 0.95 },
      { id: dismissed, a: "n/c.md", b: "n/d.md", verdict: "compatible", probability: 0.92 },
      { id: open, a: "n/e.md", b: "n/f.md", verdict: "contradicts", probability: 0.7 },
      { id: "gone", a: "x", b: "y", verdict: "unrelated", probability: 0.4 },
    ]);
    // Eval-origin and degraded records never count.
    record(
      "tension",
      "tension",
      [{ id: open, a: "a", b: "b", verdict: "unrelated", probability: 1 }],
      {
        origin: "eval",
      },
    );
    resolveTension(vault, resolved, { agent: "t" });
    dismissTension(vault, dismissed, { agent: "t" });
    const report = buildPairVerdictReport(vault, "tension");
    expect(report.pairs).toBe(4);
    const band = (name: string) => report.bands.find((b) => b.band === name)!;
    expect(band("contradicts:high").outcomes.resolved).toBe(1);
    expect(band("compatible:high").outcomes.dismissed).toBe(1);
    expect(band("contradicts:mid").outcomes.open).toBe(1);
    expect(band("unrelated:low").outcomes.missing).toBe(1);
  });

  test("preference pairs count as merged once one side was retired; latest verdict wins", () => {
    writeFileSync(join(vault, "Brain", "preferences", "pref-a.md"), "---\nid: pref-a\n---\n");
    writeFileSync(join(vault, "Brain", "retired", "ret-b.md"), "---\nid: ret-b\n---\n");
    writeFileSync(join(vault, "Brain", "preferences", "pref-c.md"), "---\nid: pref-c\n---\n");
    writeFileSync(join(vault, "Brain", "preferences", "pref-d.md"), "---\nid: pref-d\n---\n");
    record(
      "dedup",
      "preference",
      [{ id: "f1", a: "pref-a", b: "pref-b", verdict: "different", probability: 0.99 }],
      { createdAt: "2026-06-01T00:00:00.000Z" },
    );
    record(
      "dedup",
      "preference",
      [
        { id: "f1", a: "pref-a", b: "pref-b", verdict: "same", probability: 0.95 },
        { id: "f2", a: "pref-c", b: "pref-d", verdict: "different", probability: 0.93 },
      ],
      { createdAt: "2026-06-02T00:00:00.000Z" },
    );
    const report = buildPairVerdictReport(vault, "dedup");
    expect(report.pairs).toBe(2);
    expect(report.bands).toEqual([
      {
        band: "different:high",
        pairs: 1,
        outcomes: { merged: 0, resolved: 0, dismissed: 0, confirmed: 0, open: 1, missing: 0 },
      },
      {
        band: "same:high",
        pairs: 1,
        outcomes: { merged: 1, resolved: 0, dismissed: 0, confirmed: 0, open: 0, missing: 0 },
      },
    ]);
  });
});

describe("buildLabelsReport", () => {
  const PACK = parseSchemaPack(
    [
      "schema_version: 1",
      "schema:",
      "  labels:",
      "    - priority=low",
      "    - priority=high",
      "    - area=work",
      "    - area=home",
    ].join("\n") + "\n",
  );

  test("acceptance against later assign operations on the same note and dimension", async () => {
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "---\ntitle: A\n---\n\nbody a\n");
    writeFileSync(join(vault, "notes", "b.md"), "---\ntitle: B\n---\n\nbody b\n");
    const provider = new FakeChoiceProvider((_id, options) =>
      options.includes("high") ? { choice: "high", p: 0.95 } : { choice: "work", p: 0.95 },
    );
    const config = activeDecisionConfig({
      vault,
      uses: { ...activeDecisionConfig().uses, rerank: "off", labels: "enforce" },
    });
    await suggestNoteLabels(vault, "notes/a.md", { pack: PACK, config, provider });
    await suggestNoteLabels(vault, "notes/b.md", { pack: PACK, config, provider });
    const now = new Date("2026-06-01T00:00:00Z");
    // a: priority accepted, area overridden; b: nothing assigned.
    assignNoteLabel(vault, "notes/a.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "t",
      now,
    });
    assignNoteLabel(vault, "notes/a.md", {
      dimension: "area",
      value: "home",
      pack: PACK,
      agent: "t",
      now,
    });
    const report = buildLabelsReport(vault);
    expect(report.suggestions).toBe(4);
    const enforce = report.by_mode.find((m) => m.mode === "enforce")!;
    expect(enforce.outcomes).toEqual({
      accepted: 1,
      overridden: 1,
      unchanged: 2,
      already: 0,
      missing: 0,
    });
    expect(enforce.acceptance).toBe(0.5);
  });
});
