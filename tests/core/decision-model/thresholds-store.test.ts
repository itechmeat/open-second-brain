/**
 * The local per-model thresholds store (issue #264): file shape,
 * append-only history, per-vault overrides, and the enforce gate keyed by
 * the model id - never the provider preset - so a swapped model inherits
 * nothing and switching back needs no re-tuning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import {
  decisionThresholdsPath,
  effectiveThresholds,
  EMPTY_THRESHOLD_STORE,
  parseThresholdsStore,
  readThresholdsStore,
  resetThresholdsStoreCache,
  storedThresholdEntry,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import {
  fitThresholdAgainstTarget,
  runThresholdFit,
} from "../../../src/core/decision-model/thresholds-fit.ts";
import { emitDecisionModelCall } from "../../../src/core/decision-model/record.ts";

function tempVault(): string {
  const v = mkdtempSync(join(tmpdir(), "osb-dm-thr-vault-"));
  extraDirs.push(v);
  mkdirSync(join(v, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(v, "Brain", "retired"), { recursive: true });
  return v;
}

/**
 * Writes one pair's sides: both active in preferences, or `bRetired`
 * moves b to the retired directory, which the report reads as merged.
 */
function preferencePair(vault: string, id: string, aActive: boolean, bRetired: boolean): void {
  if (aActive) {
    writeFileSync(
      join(vault, "Brain", "preferences", `pref-${id}a.md`),
      `---\nid: pref-${id}a\n---\n`,
    );
  }
  if (bRetired) {
    writeFileSync(join(vault, "Brain", "retired", `ret-${id}b.md`), `---\nid: ret-${id}b\n---\n`);
  } else {
    writeFileSync(
      join(vault, "Brain", "preferences", `pref-${id}b.md`),
      `---\nid: pref-${id}b\n---\n`,
    );
  }
}

let tmp: string;
let configPath: string;
let storePath: string;
const extraDirs: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-thr-"));
  configPath = join(tmp, "config.yaml");
  storePath = decisionThresholdsPath(configPath);
  resetThresholdsStoreCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetThresholdsStoreCache();
});

const COMPATIBLE_ENFORCE = {
  decision_model_enabled: "true",
  decision_model_provider: "compatible",
  decision_model_base_url: "http://127.0.0.1:9",
  decision_model_id: "self-hosted-1",
  decision_model_env_key: "O2B_TEST_THR_KEY",
  decision_model_uses: "dedup:enforce,tension:enforce,labels:enforce",
};

function resolveWithStore(config: Record<string, string>, vault: string | null = null) {
  return resolveDecisionModelConfig({
    env: { O2B_TEST_THR_KEY: "unused" } as NodeJS.ProcessEnv,
    config,
    vault,
    thresholdsPath: storePath,
    measuredTunedMark: null,
  });
}

describe("the thresholds store file", () => {
  test("a missing file reads as the empty store and gates everything off", () => {
    expect(readThresholdsStore(storePath)).toEqual(EMPTY_THRESHOLD_STORE);
    expect(existsSync(storePath)).toBe(false);
  });

  test("a malformed file reads as empty (fail closed), never throws", () => {
    writeFileSync(storePath, "{not json", "utf8");
    expect(readThresholdsStore(storePath)).toEqual(EMPTY_THRESHOLD_STORE);
    expect(parseThresholdsStore("[]")).toEqual(EMPTY_THRESHOLD_STORE);
  });

  test("write then read round-trips; an entry keeps its history on rewrite", () => {
    writeThresholdEntry(
      storePath,
      "self-hosted-1",
      "dedup",
      { values: { low_priority_min: 0.7 }, source: "set" },
      null,
      new Date("2026-10-20T10:00:00Z"),
    );
    writeThresholdEntry(
      storePath,
      "self-hosted-1",
      "dedup",
      { values: { low_priority_min: 0.9 }, source: "fit", target: 0.05, samples: 12 },
      null,
      new Date("2026-10-21T10:00:00Z"),
    );
    const store = readThresholdsStore(storePath);
    const entry = storedThresholdEntry(store, "self-hosted-1", "dedup", null);
    expect(entry?.values).toEqual({ low_priority_min: 0.9 });
    expect(entry?.source).toBe("fit");
    expect(entry?.target).toBe(0.05);
    expect(entry?.samples).toBe(12);
    expect(entry?.history).toEqual([
      { value: 0.7, source: "set", updated_at: "2026-10-20T10:00:00.000Z" },
    ]);
  });

  test("entries of every model ever tuned are kept; nothing is deleted on a switch", () => {
    writeThresholdEntry(storePath, "model-a", "dedup", {
      values: { low_priority_min: 0.8 },
      source: "set",
    });
    writeThresholdEntry(storePath, "model-b", "dedup", {
      values: { low_priority_min: 0.6 },
      source: "set",
    });
    // The operator moves to model-b; model-a's entry survives untouched.
    expect(
      storedThresholdEntry(readThresholdsStore(storePath), "model-a", "dedup", null)?.values,
    ).toEqual({
      low_priority_min: 0.8,
    });
    expect(
      storedThresholdEntry(readThresholdsStore(storePath), "model-b", "dedup", null)?.values,
    ).toEqual({
      low_priority_min: 0.6,
    });
  });

  test("history is capped", () => {
    for (let i = 0; i < 25; i++) {
      writeThresholdEntry(
        storePath,
        "m",
        "dedup",
        { values: { low_priority_min: 0.5 + i / 100 }, source: "set" },
        null,
        new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      );
    }
    const entry = storedThresholdEntry(readThresholdsStore(storePath), "m", "dedup", null);
    expect(entry?.history?.length).toBe(20);
  });

  test("a per-vault override wins for that vault and leaves the global entry", () => {
    writeThresholdEntry(storePath, "m", "dedup", {
      values: { low_priority_min: 0.8 },
      source: "set",
    });
    writeThresholdEntry(
      storePath,
      "m",
      "dedup",
      { values: { low_priority_min: 0.6 }, source: "set" },
      "/vaults/work",
    );
    const store = readThresholdsStore(storePath);
    expect(storedThresholdEntry(store, "m", "dedup", "/vaults/work")?.values).toEqual({
      low_priority_min: 0.6,
    });
    expect(storedThresholdEntry(store, "m", "dedup", "/vaults/other")?.values).toEqual({
      low_priority_min: 0.8,
    });
    expect(storedThresholdEntry(store, "m", "dedup", null)?.values).toEqual({
      low_priority_min: 0.8,
    });
  });

  test("effectiveThresholds merges stored values over the built-in defaults", () => {
    expect(effectiveThresholds(EMPTY_THRESHOLD_STORE, "m", "dedup", null)).toEqual({
      low_priority_min: 0.9,
    });
    writeThresholdEntry(storePath, "m", "dedup", {
      values: { low_priority_min: 0.75 },
      source: "fit",
    });
    expect(effectiveThresholds(readThresholdsStore(storePath), "m", "dedup", null)).toEqual({
      low_priority_min: 0.75,
    });
  });
});

describe("the enforce gate keys on the model id", () => {
  test("a stored entry arms enforce for its model; another model stays shadow", () => {
    writeThresholdEntry(storePath, "self-hosted-1", "dedup", {
      values: { low_priority_min: 0.85 },
      source: "fit",
    });
    const tuned = resolveWithStore(COMPATIBLE_ENFORCE);
    expect(tuned.status).toBe("active");
    expect(tuned.shadowOnlyUses).toEqual(["tension", "labels"]);
    expect(tuned.uses.dedup).toBe("enforce");
    expect(decisionModelModeFor(tuned, "dedup")).toBe("enforce");
    expect(decisionModelModeFor(tuned, "tension")).toBe("shadow");

    // The same preset pointing at a different model inherits nothing.
    const swapped = resolveWithStore({
      ...COMPATIBLE_ENFORCE,
      decision_model_id: "self-hosted-2",
    });
    expect(swapped.status).toBe("active");
    expect(swapped.shadowOnlyUses).toEqual(["dedup", "tension", "labels"]);
    expect(decisionModelModeFor(swapped, "dedup")).toBe("shadow");

    // Switching back restores the tune without re-tuning.
    const back = resolveWithStore(COMPATIBLE_ENFORCE);
    expect(back.uses.dedup).toBe("enforce");
  });

  test("the baseline family keeps enforcing with no store at all", () => {
    const cfg = resolveDecisionModelConfig({
      env: { TYPESAFE_API_KEY: "unused" } as NodeJS.ProcessEnv,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "typesafe",
        decision_model_uses: "dedup:enforce",
      },
      vault: null,
      thresholdsPath: storePath,
      measuredTunedMark: null,
    });
    expect(cfg.uses.dedup).toBe("enforce");
    expect(cfg.shadowOnlyUses).toEqual([]);
  });

  test("the store arms a use even when no threshold profile resolves", () => {
    // compatible carries no profile: before the store, every enforce use
    // silently ran as shadow on it.
    writeThresholdEntry(storePath, "self-hosted-1", "dedup", {
      values: { low_priority_min: 0.85 },
      source: "set",
    });
    const cfg = resolveWithStore(COMPATIBLE_ENFORCE);
    expect(cfg.thresholdProfile).toBeNull();
    expect(cfg.uses.dedup).toBe("enforce");
  });

  test("a per-vault override arms enforce for that vault only", () => {
    writeThresholdEntry(
      storePath,
      "self-hosted-1",
      "dedup",
      { values: { low_priority_min: 0.6 }, source: "set" },
      "/vaults/work",
    );
    const work = resolveWithStore(COMPATIBLE_ENFORCE, "/vaults/work");
    expect(work.uses.dedup).toBe("enforce");
    const other = resolveWithStore(COMPATIBLE_ENFORCE, "/vaults/other");
    expect(other.uses.dedup).toBe("shadow");
  });

  test("thresholdsPath: null disables the store entirely", () => {
    writeThresholdEntry(storePath, "self-hosted-1", "dedup", {
      values: { low_priority_min: 0.85 },
      source: "set",
    });
    const cfg = resolveDecisionModelConfig({
      env: { O2B_TEST_THR_KEY: "unused" } as NodeJS.ProcessEnv,
      config: COMPATIBLE_ENFORCE,
      vault: null,
      thresholdsPath: null,
      measuredTunedMark: null,
    });
    expect(cfg.uses.dedup).toBe("shadow");
  });
});

describe("the threshold fit", () => {
  test("sweeps to the threshold that holds the false-action target", () => {
    const vault = tempVault();
    // Eight true negatives at or above 0.9; two false actions below 0.9
    // (a demoted pair that was later merged anyway).
    for (let i = 0; i < 8; i++) {
      preferencePair(vault, `o${i}`, true, false);
      emitDecisionModelCall(vault, {
        use: "dedup",
        mode: "shadow",
        provider: "fake",
        model: "fit-model-1",
        calibrated: true,
        questionCount: 1,
        candidateCount: 1,
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        details: {
          pair_kind: "preference",
          pairs: [
            {
              id: `o${i}`,
              a: `pref-o${i}a`,
              b: `pref-o${i}b`,
              verdict: "different",
              probability: 0.9 + i / 100,
            },
          ],
        },
      });
    }
    for (const [i, p] of [0.6, 0.65].entries()) {
      preferencePair(vault, `f${i}`, true, true); // one side retired: merged
      emitDecisionModelCall(vault, {
        use: "dedup",
        mode: "shadow",
        provider: "fake",
        model: "fit-model-1",
        calibrated: true,
        questionCount: 1,
        candidateCount: 1,
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        details: {
          pair_kind: "preference",
          pairs: [
            {
              id: `f${i}`,
              a: `pref-f${i}a`,
              b: `pref-f${i}b`,
              verdict: "different",
              probability: p,
            },
          ],
        },
      });
    }
    const result = runThresholdFit(storePath, { vault, use: "dedup" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("fit-model-1");
    expect(result.name).toBe("low_priority_min");
    // At 0.9 the demotions are the eight open pairs: zero false actions,
    // the most action any feasible threshold in this data achieves.
    expect(result.entry.values).toEqual({ low_priority_min: 0.9 });
    expect(result.entry.source).toBe("fit");
    expect(result.entry.target).toBe(0.05);
    expect(result.entry.samples).toBe(8);
  });

  test("nothing is written when no threshold meets the target", () => {
    const vault = tempVault();
    preferencePair(vault, "t", true, true);
    // Eight true negatives at 0.80-0.87 and one merged pair at 0.95: the
    // merged pair sits inside no feasible window, so no threshold both
    // acts on eight samples and keeps a 1% false share.
    emitDecisionModelCall(vault, {
      use: "dedup",
      mode: "shadow",
      provider: "fake",
      model: "fit-model-1",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
      details: {
        pair_kind: "preference",
        pairs: [{ id: "f", a: "pref-fa", b: "pref-fb", verdict: "different", probability: 0.95 }],
      },
    });
    for (let i = 0; i < 8; i++) {
      preferencePair(vault, `p${i}`, true, true);
      emitDecisionModelCall(vault, {
        use: "dedup",
        mode: "shadow",
        provider: "fake",
        model: "fit-model-1",
        calibrated: true,
        questionCount: 1,
        candidateCount: 1,
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        details: {
          pair_kind: "preference",
          pairs: [
            {
              id: `p${i}`,
              a: `pref-p${i}a`,
              b: `pref-p${i}b`,
              verdict: "different",
              probability: 0.8 + i / 100,
            },
          ],
        },
      });
    }
    const before = existsSync(storePath) ? readThresholdsStore(storePath) : EMPTY_THRESHOLD_STORE;
    const result = runThresholdFit(storePath, { vault, use: "dedup", target: 0.01 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.note).toContain("no threshold meets");
    expect(readThresholdsStore(storePath)).toEqual(before);
  });

  test("records naming several models are refused: one model's calibration per entry", () => {
    const vault = tempVault();
    preferencePair(vault, "t", true, true);
    for (const model of ["a", "b"]) {
      emitDecisionModelCall(vault, {
        use: "dedup",
        mode: "shadow",
        provider: "fake",
        model,
        calibrated: true,
        questionCount: 1,
        candidateCount: 1,
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        details: {
          pair_kind: "preference",
          pairs: [
            {
              id: `x-${model}`,
              a: "pref-ta",
              b: "pref-tb",
              verdict: "different",
              probability: 0.9,
            },
          ],
        },
      });
    }
    const result = runThresholdFit(storePath, { vault, use: "dedup" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.note).toContain("several models");
    expect(result.note).toContain("a");
    expect(result.note).toContain("b");
  });

  test("a use without a labelled report is refused by name", () => {
    const vault = tempVault();
    const result = runThresholdFit(storePath, { vault, use: "rerank" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.note).toContain("no labelled report");
    expect(result.note).toContain("dedup, tension, labels, extract_prefilter");
  });
});

describe("the fit sweep itself", () => {
  test("at_or_above keeps the most action under the target", () => {
    const samples = [
      ...Array.from({ length: 8 }, (_, i) => ({ score: 0.9 + i / 100, falseAction: false })),
      { score: 0.6, falseAction: true },
    ];
    const fit = fitThresholdAgainstTarget(samples, "at_or_above", 0.05);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.candidate.threshold).toBe(0.9);
    expect(fit.candidate.acted).toBe(8);
    expect(fit.candidate.falseShare).toBe(0);
  });

  test("below acts under the threshold and drops nothing else", () => {
    const samples = [
      ...Array.from({ length: 9 }, (_, i) => ({ score: 0.1 + i / 100, falseAction: false })),
      { score: 0.6, falseAction: true },
    ];
    const fit = fitThresholdAgainstTarget(samples, "below", 0.05);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.candidate.threshold).toBe(0.6);
    expect(fit.candidate.acted).toBe(9);
    expect(fit.candidate.falseActions).toBe(0);
  });

  test("too few samples refuse with the count", () => {
    const fit = fitThresholdAgainstTarget(
      [{ score: 0.9, falseAction: false }],
      "at_or_above",
      0.05,
    );
    expect(fit.ok).toBe(false);
    if (fit.ok) return;
    expect(fit.note).toContain("1 decidable sample(s)");
  });
});
