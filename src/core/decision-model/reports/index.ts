/**
 * Per-use evaluation reports behind `o2b decision-model report --use <use>`.
 *
 * Every use has one entry. The generic summary in `diagnostics.ts` (calls,
 * outcome mix, latency, tokens, cost) covers every use; the entry adds the
 * use's own evaluation metric, the number `enforce` is judged by. The
 * rerank entry is the shadow agreement the generic summary already
 * computes, so it has no separate builder here.
 *
 * Every report is read-only and reads identifiers, closed values and
 * numbers only; no record carries text.
 */

import type { DecisionModelUse } from "../contract.ts";
import { buildAnswerableReport, renderAnswerableReport } from "./answerable.ts";
import { buildExtractPrefilterReport, renderExtractPrefilterReport } from "./extract-prefilter.ts";
import { buildLabelsReport, renderLabelsReport } from "./labels.ts";
import { buildPairVerdictReport, renderPairVerdictReport } from "./pair-verdict.ts";
import { buildRecallInjectUseReport, renderRecallInjectUseReport } from "./recall-inject.ts";
import { buildSkillsDecisionReport, renderSkillsDecisionReport } from "./skills.ts";

export interface UseReportOptions {
  readonly since?: string;
}

/**
 * One use's report: `build` reads the vault, `render` turns what it built
 * into the text form. `render` accepts only what `build` of the same
 * entry returned.
 */
export interface UseReportEntry {
  readonly build: (vault: string, opts: UseReportOptions) => unknown;
  readonly render: (report: unknown) => string;
}

function entry<R>(
  build: (vault: string, opts: UseReportOptions) => R,
  render: (report: R) => string,
): UseReportEntry {
  return { build, render: (report) => render(report as R) };
}

/**
 * The per-use report builders; `null` for `rerank`, whose metric (shadow
 * agreement) is part of the generic summary.
 */
export const USE_REPORTS: Readonly<Record<DecisionModelUse, UseReportEntry | null>> = Object.freeze(
  {
    rerank: null,
    skills: entry(buildSkillsDecisionReport, renderSkillsDecisionReport),
    extract_prefilter: entry(buildExtractPrefilterReport, renderExtractPrefilterReport),
    dedup: entry(
      (vault, opts) => buildPairVerdictReport(vault, "dedup", opts),
      renderPairVerdictReport,
    ),
    tension: entry(
      (vault, opts) => buildPairVerdictReport(vault, "tension", opts),
      renderPairVerdictReport,
    ),
    labels: entry(buildLabelsReport, renderLabelsReport),
    answerable: entry(buildAnswerableReport, renderAnswerableReport),
    recall_inject: entry(buildRecallInjectUseReport, renderRecallInjectUseReport),
  },
);
