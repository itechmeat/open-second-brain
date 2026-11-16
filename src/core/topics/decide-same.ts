/**
 * `topic_same` of the dream-time decide pass (design D10): the pair
 * verdicts the dream report lists. One file per use family; the shared
 * context lives in `decide-shared.ts`.
 */

import type { StateCandidate } from "../decision-model/state.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import { TOPIC_DECISION_LIMITS, TOPIC_SAME_QUESTIONS } from "../decision-model/questions-topics.ts";
import { mayShareRecord, shareableHeadFields } from "../decision-model/egress-guard.ts";
import { runPairVerdicts } from "../decision-model/pair-verdict.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { topicPairsForSame } from "./plan.ts";
import { type PassContext } from "./decide-shared.ts";
import { verdictBody } from "./verdicts.ts";

// ----- topic_same ------------------------------------------------------------

/**
 * `topic_same` (design D10): `choice` per pair of active topics of one
 * scope whose head tokens share at least 0.2 Jaccard, at most
 * `pairsPerPass`, through the shared pair-verdict runner. `same` at or
 * above `same_min` joins the report's merge proposals; `different` at or
 * above it annotates a Jaccard proposal, which is listed last and never
 * removed. Nothing is ever merged. No batch starts once the use's share
 * of the pass budget is spent.
 */
export async function decideSameTopics(ctx: PassContext): Promise<void> {
  const use = "topic_same" as const;
  if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
  // A topic the egress rule keeps home is left out before the pair cap.
  const pairs = topicPairsForSame(
    ctx.fold,
    TOPIC_SAME_QUESTIONS.pairJaccard,
    TOPIC_DECISION_LIMITS.pairsPerPass,
    (topic) => mayShareRecord(ctx.cfg, use, topic.private),
  );
  if (pairs.length === 0) return;
  const side = (topicId: string): StateCandidate => {
    const topic = ctx.fold.topics.get(topicId);
    // A private field of a shared topic stays home unless private records may leave.
    const head = topic === undefined ? null : shareableHeadFields(ctx.cfg, use, topic);
    const text = [head?.title, head?.description, head?.goal]
      .filter((value) => typeof value === "string" && value !== "")
      .join(" - ");
    return {
      text,
      visibility: mayShareRecord(ctx.cfg, use, topic?.private === true)
        ? []
        : [REMOTE_DENY_VISIBILITY_TOKEN],
      privateRegions: [],
    };
  };
  const run = await runPairVerdicts(
    pairs.map((pair) => ({
      id: `${pair.a}..${pair.b}`,
      a: pair.a,
      b: pair.b,
      sideA: side(pair.a),
      sideB: side(pair.b),
    })),
    {
      use,
      pairKind: "topic",
      options: [...TOPIC_SAME_QUESTIONS.options],
      clipChars: TOPIC_SAME_QUESTIONS.clipChars,
      question: (i) => TOPIC_SAME_QUESTIONS.question(i),
    },
    {
      config: ctx.cfg,
      ...(ctx.options.provider !== undefined ? { provider: ctx.options.provider } : {}),
      ...(ctx.options.env !== undefined ? { env: ctx.options.env } : {}),
      // Its share of the pass budget, checked before each batch as the
      // other uses check it before each request.
      until: ctx.until,
      clock: ctx.clock,
    },
  );
  if (run.status !== "done") return;
  run.verdicts.forEach((verdict, i) => {
    // Only an answer its entry held in enforce acts: a fallback entry
    // that answers as shadow is recorded and has no effect.
    const answered = run.answered[i];
    if (verdict === null || answered === null || answered === undefined) return;
    if (answered.mode !== "enforce") return;
    const confidence = verdict.probabilities[verdict.verdict] ?? 0;
    if (confidence < appliedThreshold(ctx.cfg, use, answered.model, "same_min")) return;
    ctx.out.sameTopics.push({
      a: pairs[i]!.a,
      b: pairs[i]!.b,
      option: verdict.verdict,
      verdict: verdictBody(use, { model: verdict.model }, answered.provider, confidence),
    });
  });
}
