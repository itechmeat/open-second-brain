/**
 * Advisory decision-model verdicts on preference dedup findings (issue
 * #213, Part 5, use `dedup`).
 *
 * The dedup detector nominates near-duplicate preference pairs from
 * embedding cosine or Jaccard similarity. This pass asks the decision
 * model whether each pair is the `same` rule, a `related` one or a
 * `different` one, and annotates the finding in the `scan` output only.
 *
 *   - `off` or no active config: nothing is read, built or sent; the
 *     caller gets null and keeps its listing unchanged.
 *   - `shadow`: requests are sent and recorded, the listing is returned
 *     exactly as without the feature.
 *   - `enforce`: each dedup finding with a verdict gains
 *     `decision_model`; a confident `different` is listed last and marked
 *     `decision_model_low_priority: true`. Nothing is hidden or removed.
 *
 * Verdicts never reach disk: not the preference pages, not the findings
 * (`scan` writes none), and `apply` never consults them.
 */

import { join } from "node:path";

import {
  advisoryDecisionConfig,
  advisoryUseActive,
  pageEgressFacts,
  type AdvisoryDecisionOptions,
} from "../../decision-model/advisory.ts";
import {
  orderByVerdicts,
  runPairVerdicts,
  type AnnotatedItem,
  type VerdictPairInput,
} from "../../decision-model/pair-verdict.ts";
import { DEDUP_QUESTIONS } from "../../decision-model/questions.ts";
import { brainDirs } from "../paths.ts";
import { parsePreference } from "../preference.ts";
import type { HygieneFinding } from "./types.ts";

/** Path of a preference page by id, or null when the id is not a page name. */
function preferencePagePath(vault: string, id: string): string | null {
  if (!/^pref-[A-Za-z0-9._-]+$/u.test(id) || id.includes("..")) return null;
  return join(brainDirs(vault).preferences, `${id}.md`);
}

function preferenceSide(vault: string, id: string): VerdictPairInput["sideA"] {
  const path = preferencePagePath(vault, id);
  const facts = pageEgressFacts(path);
  let principle = "";
  if (path !== null && facts.visibility !== null) {
    try {
      principle = parsePreference(path).principle;
    } catch {
      return { text: "", visibility: null, privateRegions: null };
    }
  }
  return { text: principle, visibility: facts.visibility, privateRegions: facts.privateRegions };
}

/**
 * Annotate the dedup findings of a scan listing. Returns null when the
 * `dedup` use is off (the caller renders its listing as it always has);
 * otherwise every finding, in the order to show, with its verdict.
 */
export async function annotateDedupFindings(
  vault: string,
  findings: ReadonlyArray<HygieneFinding>,
  opts: AdvisoryDecisionOptions = {},
): Promise<ReadonlyArray<AnnotatedItem<HygieneFinding>> | null> {
  if (!findings.some((f) => f.detector === "dedup" && f.targets.length === 2)) return null;
  const cfg = advisoryDecisionConfig(vault, opts);
  if (!advisoryUseActive(cfg, "dedup")) return null;

  const candidates: Array<{ index: number; pair: VerdictPairInput }> = [];
  findings.forEach((finding, index) => {
    if (finding.detector !== "dedup" || finding.targets.length !== 2) return;
    const [a, b] = finding.targets as [string, string];
    candidates.push({
      index,
      pair: {
        id: finding.id,
        a,
        b,
        sideA: preferenceSide(vault, a),
        sideB: preferenceSide(vault, b),
      },
    });
  });
  const run = await runPairVerdicts(
    candidates.map((c) => c.pair),
    {
      use: "dedup",
      pairKind: "preference",
      options: DEDUP_QUESTIONS.options,
      clipChars: DEDUP_QUESTIONS.clipChars,
      question: DEDUP_QUESTIONS.preference,
    },
    {
      config: cfg,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
  );
  if (run.status === "off") return null;
  const verdicts = findings.map(() => null as (typeof run.verdicts)[number]);
  candidates.forEach((c, k) => {
    verdicts[c.index] = run.verdicts[k] ?? null;
  });
  return orderByVerdicts(findings, verdicts, run.mode, DEDUP_QUESTIONS.lowPriority);
}
