/**
 * Threshold fitting: derive one use's action threshold from the use's own
 * labelled report data against a false-action target (issue #264).
 *
 * The data is what the per-use reports already join - dedup and tension
 * verdicts to the operator's later status, label suggestions to the
 * note's later acceptance, extract plans to later citations. A sample is
 * one decidable observation: the model's score and whether acting on it
 * was right. The fit sweeps the threshold over the observed scores and
 * keeps the value that acts on the most samples while holding the share
 * of false actions at or under the target. Nothing meets the target, or
 * too few samples decide, and nothing is written - the refusal names the
 * best the data could do.
 *
 * The value is written for the ANSWERING model only: a fit whose records
 * pool several models is refused by name, so one model's calibration
 * never leaks into another's thresholds.
 */

import type { DecisionModelUse } from "./contract.ts";
import { DEDUP_QUESTIONS, PRIMARY_THRESHOLD_NAME, TENSION_QUESTIONS } from "./questions.ts";
import {
  readThresholdsStore,
  storedThresholdEntry,
  writeThresholdEntry,
  type DecisionThresholdEntry,
} from "./thresholds.ts";
import { buildPairVerdictSamples } from "./reports/pair-verdict.ts";
import { buildLabelSamples } from "./reports/labels.ts";
import { buildExtractRegretSamples } from "./reports/extract-prefilter.ts";

/** Fewer decidable samples than this and a fit refuses to speak. */
export const MIN_FIT_SAMPLES = 8;

/** One decidable observation: the model's score and whether acting was wrong. */
export interface ThresholdFitSample {
  readonly score: number;
  readonly falseAction: boolean;
}

/**
 * Which side of the threshold an action lies on: `at_or_above` acts on
 * scores at or above the value (a demotion, a suggestion), `below` acts
 * on scores below it (a dropped turn).
 */
export type ThresholdFitDirection = "at_or_above" | "below";

/** A threshold the fit evaluated, feasible or not. */
export interface ThresholdFitCandidate {
  readonly threshold: number;
  readonly acted: number;
  readonly falseActions: number;
  readonly falseShare: number | null;
}

export type ThresholdFitOutcome =
  | {
      readonly ok: true;
      readonly candidate: ThresholdFitCandidate;
    }
  | {
      readonly ok: false;
      readonly note: string;
      /** The closest try, for the refusal to name. */
      readonly best: ThresholdFitCandidate | null;
    };

/**
 * Sweep the observed scores and keep the threshold that acts on the most
 * samples while holding the false-action share at or under `target`.
 * Every threshold considered needs at least `minSamples` actions behind
 * it: a share measured on two demotions says nothing.
 */
export function fitThresholdAgainstTarget(
  samples: ReadonlyArray<ThresholdFitSample>,
  direction: ThresholdFitDirection,
  target: number,
  minSamples: number = MIN_FIT_SAMPLES,
): ThresholdFitOutcome {
  const evaluate = (threshold: number): ThresholdFitCandidate => {
    const acted =
      direction === "at_or_above"
        ? samples.filter((s) => s.score >= threshold)
        : samples.filter((s) => s.score < threshold);
    const falseActions = acted.filter((s) => s.falseAction).length;
    return {
      threshold,
      acted: acted.length,
      falseActions,
      falseShare: acted.length === 0 ? null : falseActions / acted.length,
    };
  };
  const scores = [...new Set(samples.map((s) => s.score))].toSorted((a, b) => a - b);
  const candidates = direction === "at_or_above" ? scores : [...scores, Math.max(1, ...scores)];
  let best: ThresholdFitCandidate | null = null;
  let feasible: ThresholdFitCandidate | null = null;
  for (const threshold of candidates) {
    const candidate = evaluate(threshold);
    if (candidate.acted > (best?.acted ?? -1)) best = candidate;
    if (
      candidate.acted >= minSamples &&
      candidate.falseShare !== null &&
      candidate.falseShare <= target
    ) {
      // The most action is the goal; ties keep the earlier (lower or
      // tighter) threshold, which acts on exactly the same set.
      if (feasible === null || candidate.acted > feasible.acted) feasible = candidate;
    }
  }
  if (samples.length < minSamples) {
    return {
      ok: false,
      note: `only ${samples.length} decidable sample(s), ${minSamples} needed`,
      best,
    };
  }
  if (feasible === null) {
    const bestNote =
      best === null || best.acted === 0 || best.falseShare === null
        ? "no threshold in the data acts on enough samples"
        : `the closest is ${best.threshold} with ${(best.falseShare * 100).toFixed(1)}% false ` +
          `actions over ${best.acted} action(s)`;
    return {
      ok: false,
      note: `no threshold meets a ${target} false-action target: ${bestNote}`,
      best,
    };
  }
  return { ok: true, candidate: feasible };
}

/** What each use fits from, and how. The specless uses are absent. */
export const FITTABLE_USES: ReadonlyArray<DecisionModelUse> = Object.freeze([
  "dedup",
  "tension",
  "labels",
  "extract_prefilter",
]);

export function isFittableUse(use: DecisionModelUse): boolean {
  return FITTABLE_USES.includes(use);
}

/**
 * The fit samples of one use from the vault's labelled records, with the
 * answering models the records name. A model of `unknown` is skipped for
 * the model identity but keeps its sample: the data still counts.
 */
export function fitSamplesForUse(
  vault: string,
  use: DecisionModelUse,
  opts: { readonly since?: string } = {},
): { readonly samples: ReadonlyArray<ThresholdFitSample>; readonly models: ReadonlyArray<string> } {
  if (use === "dedup" || use === "tension") {
    const lowPriority: ReadonlyArray<string> =
      use === "dedup" ? DEDUP_QUESTIONS.lowPriority : TENSION_QUESTIONS.lowPriority;
    const { samples } = buildPairVerdictSamples(vault, use, opts);
    const usable = samples.filter((s) => lowPriority.includes(s.verdict));
    return {
      samples: usable.map((s) => ({
        score: s.probability,
        // The action said "not this" and the operator later said it was:
        // a merged pair was the same rule, a confirmed (or resolved)
        // tension was real.
        falseAction: use === "dedup" ? s.outcome === "merged" : s.outcome === "confirmed",
      })),
      models: usable.map((s) => s.model),
    };
  }
  if (use === "labels") {
    const { samples } = buildLabelSamples(vault, opts);
    const usable = samples.filter((s) => s.suggested && s.confidence !== null);
    return {
      samples: usable.map((s) => ({
        score: s.confidence!,
        // Suggesting a value the operator later replaced was the false
        // action; accepting it was the true one. Unchanged, already and
        // missing do not decide either way and drop out of the share.
        falseAction: s.outcome === "overridden",
      })),
      models: usable.map((s) => s.model),
    };
  }
  if (use === "extract_prefilter") {
    const { samples } = buildExtractRegretSamples(vault, opts);
    return {
      samples: samples.map((s) => ({ score: s.probability, falseAction: s.cited })),
      models: samples.map((s) => s.model),
    };
  }
  return { samples: [], models: [] };
}

/** The named threshold a use fits: the one value the action reads. */
export function fittedThresholdName(use: DecisionModelUse): string {
  return PRIMARY_THRESHOLD_NAME[use];
}

export type ThresholdFitRun =
  | {
      readonly ok: true;
      readonly model: string;
      readonly use: DecisionModelUse;
      readonly name: string;
      readonly entry: DecisionThresholdEntry;
      readonly alreadyTuned: boolean;
    }
  | { readonly ok: false; readonly note: string };

/**
 * Run the fit for one use and, when it and the data agree, write the
 * entry for the answering model. `alreadyTuned` says whether the model
 * had an entry for this use before (the fit refreshed it).
 */
export function runThresholdFit(
  storePath: string,
  input: {
    readonly vault: string;
    readonly use: DecisionModelUse;
    readonly since?: string;
    /** Highest false-action share the fitted threshold may carry. */
    readonly target?: number;
  },
  now: Date = new Date(),
): ThresholdFitRun {
  if (!isFittableUse(input.use)) {
    return {
      ok: false,
      note:
        `use '${input.use}' has no labelled report to fit from; fittable uses: ` +
        FITTABLE_USES.join(", "),
    };
  }
  const target = input.target ?? DEFAULT_FIT_TARGET;
  const { samples, models } = fitSamplesForUse(input.vault, input.use, {
    since: input.since,
  });
  const named = [...new Set(models.filter((m) => m !== "unknown" && m !== ""))];
  if (named.length === 0) {
    return {
      ok: false,
      note: `no ok ordinary records for use '${input.use}' name a model; run it in shadow first`,
    };
  }
  if (named.length > 1) {
    return {
      ok: false,
      note:
        `the records pool several models (${named.join(", ")}); a threshold is one model's ` +
        "calibration, so narrow the window with --since until one model remains",
    };
  }
  const model = named[0]!;
  const fit = fitThresholdAgainstTarget(samples, fitDirection(input.use), target);
  if (!fit.ok) return { ok: false, note: fit.note };
  const alreadyTuned =
    storedThresholdEntry(readStoreFor(storePath), model, input.use, null) !== null;
  const entry = writeThresholdEntry(
    storePath,
    model,
    input.use,
    {
      values: { [fittedThresholdName(input.use)]: fit.candidate.threshold },
      source: "fit",
      target,
      samples: fit.candidate.acted,
    },
    null,
    now,
  );
  return {
    ok: true,
    model,
    use: input.use,
    name: fittedThresholdName(input.use),
    entry,
    alreadyTuned,
  };
}

/** The default false-action target: five wrong actions in a hundred. */
export const DEFAULT_FIT_TARGET = 0.05;

function fitDirection(use: DecisionModelUse): ThresholdFitDirection {
  return use === "extract_prefilter" ? "below" : "at_or_above";
}

function readStoreFor(storePath: string): ReturnType<typeof readThresholdsStore> {
  // A cache-busting read (nowMs 0 is older than any TTL window) so a fit
  // that follows a hand edit sees the file as it is on disk.
  return readThresholdsStore(storePath, 0);
}
