/**
 * The `head_select` decision use (task 4.2, design D10): one `noul`
 * question per candidate head, the state `{ project, branch, topics }`.
 * The deterministic fallback is the recency and scope ranking the hook
 * glue computed; `enforce` reorders the heads by p(yes) descending (the
 * fallback order on ties) and leaves the heads below `drop_below` out
 * (counted in the digest's cut line). Never adds a head outside the
 * candidate set. No store record: recorded in `decision_model_call`
 * only.
 *
 * Budget: `min(cfg.hookBudgetMs, remaining hook budget)`, enforced
 * again around the call, as `recall-inject-decision.ts` does.
 */

import { decisionModelModeFor } from "../decision-model/config.ts";
import type { ResolvedDecisionModelConfig } from "../decision-model/config-types.ts";
import type { DecisionProvider, DecisionNoulQuestion } from "../decision-model/contract.ts";
import {
  HEAD_SELECT_QUESTIONS,
  TOPIC_DECISION_LIMITS,
} from "../decision-model/questions-topics.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import { runDecision } from "../decision-model/run.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { buildCandidateState, type StateCandidate } from "../decision-model/state.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { privateRegionTexts } from "../redactor.ts";
import type { TopicState } from "../topics/fold.ts";
import { mayShareRecord, shareableHeadFields } from "../decision-model/egress-guard.ts";

export interface HeadSelectRequest {
  /** The session's project key (the scoped-rule key), or null without a project. */
  readonly project: string | null;
  /** The workspace's branch from `.git/HEAD`, or null. */
  readonly branch: string | null;
}

export interface HeadSelectOutcome {
  /** The candidate heads, reordered or filtered (enforce) or as given (fallback). */
  readonly heads: ReadonlyArray<TopicState>;
  /** How many heads the use left out below `drop_below` (enforce only). */
  readonly droppedBelow: number;
  /** Whether the model answered (enforce applied). */
  readonly applied: boolean;
}

/** The state candidate of one head, guarded like every other use's. */
function headCandidate(
  cfg: ResolvedDecisionModelConfig,
  use: "head_select",
  topic: TopicState,
): StateCandidate {
  // A private field of a shared topic stays home unless private records may leave.
  const head = shareableHeadFields(cfg, use, topic);
  const text = [head.title, head.description, head.goal].filter((v) => v !== "").join(" - ");
  return {
    text,
    visibility: mayShareRecord(cfg, use, topic.private) ? [] : [REMOTE_DENY_VISIBILITY_TOKEN],
    privateRegions: privateRegionTexts(text),
  };
}

/**
 * The heads one request carries, in order: up to `headsPerRequest` heads
 * the egress rule lets leave, with the withheld heads among them riding
 * along (recorded as withheld, never sent), so a run of private heads
 * never keeps a shared one from being asked.
 */
function cappedHeads(
  cfg: ResolvedDecisionModelConfig,
  use: "head_select",
  heads: ReadonlyArray<TopicState>,
): TopicState[] {
  const out: TopicState[] = [];
  let shareable = 0;
  for (const topic of heads) {
    if (shareable >= TOPIC_DECISION_LIMITS.headsPerRequest) break;
    out.push(topic);
    if (mayShareRecord(cfg, use, topic.private)) shareable += 1;
  }
  return out;
}

/**
 * Ask the model which heads matter for this session. Returns the
 * fallback order unless `head_select` answered in `enforce`.
 */
export async function runHeadSelect(input: {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  readonly heads: ReadonlyArray<TopicState>;
  readonly request: HeadSelectRequest;
  /** The remaining hook budget in ms; the request gets the smaller of it and `hookBudgetMs`. */
  readonly remainingMs: number;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clip of one head field in the state (default `headFieldClipChars`). */
  readonly clipChars?: number;
}): Promise<HeadSelectOutcome> {
  const use = "head_select" as const;
  const cfg = input.config;
  const mode = decisionModelModeFor(cfg, use);
  const fallback: HeadSelectOutcome = { heads: input.heads, droppedBelow: 0, applied: false };
  if (mode === "off" || cfg === null || cfg === undefined) return fallback;
  if (input.heads.length === 0) return fallback;
  const budgetMs = Math.max(0, Math.min(cfg.hookBudgetMs, input.remainingMs));
  // No request starts with less than the minimum request time left.
  if (budgetMs <= 0 || !mayStartRequest(0, input.remainingMs, cfg.hookBudgetMs)) return fallback;
  const heads = cappedHeads(cfg, use, input.heads);
  const clipChars = input.clipChars ?? TOPIC_DECISION_LIMITS.headFieldClipChars;
  const request = runDecision<{ map: Map<number, TopicState> }>(
    use,
    () => {
      const built = buildCandidateState({
        candidates: heads.map((topic) => headCandidate(cfg, use, topic)),
        prefix: HEAD_SELECT_QUESTIONS.headPrefix,
        clipChars,
        maxStateTokens: cfg.maxStateTokens,
        frame: (texts) => ({
          project: input.request.project ?? "",
          branch: input.request.branch ?? "",
          topics: texts,
        }),
      });
      if (built.kind !== "ok") return { kind: "empty" as const };
      const context = { map: new Map<number, TopicState>() };
      built.included.forEach((candidateIndex, k) => context.map.set(k, heads[candidateIndex]!));
      return {
        kind: "ok" as const,
        state: built.state,
        candidateCount: built.included.length,
        context,
      };
    },
    (built): Record<string, DecisionNoulQuestion> => {
      // One question per mask in the state: a withheld head has none.
      const questions: Record<string, DecisionNoulQuestion> = {};
      for (let k = 0; k < built.candidateCount; k++) {
        questions[HEAD_SELECT_QUESTIONS.relevantId(k)] = HEAD_SELECT_QUESTIONS.relevant(k);
      }
      return questions;
    },
    {
      config: cfg,
      timeoutMs: budgetMs,
      // The floor holds for each attempt of the chain, not only here.
      requestFloor: true,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      recordDetails: (response, context) => {
        const details: Record<string, unknown> = {
          topic_ids: heads.map((t) => (mayShareRecord(cfg, use, t.private) ? t.id : "(withheld)")),
        };
        if (response !== null && context !== null) {
          // Aligned with `topic_ids`: null for a head that was not asked.
          const probabilities: Array<number | null> = heads.map(() => null);
          for (const [k, topic] of context.map) {
            const a = response.answers[HEAD_SELECT_QUESTIONS.relevantId(k)];
            probabilities[heads.indexOf(topic)] =
              a !== undefined && a.valid === true && typeof a.value === "number" ? a.value : null;
          }
          details["probabilities"] = probabilities;
        }
        return details;
      },
    },
  );
  // A provider that outlives its own timeout must not hold the hook.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<"cutoff">((resolve) => {
    timer = setTimeout(() => resolve("cutoff"), budgetMs);
  });
  let result: Awaited<typeof request> | "cutoff";
  try {
    result = await Promise.race([request, cutoff]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (result === "cutoff") return fallback;
  if (result.status !== "ok" || result.mode !== "enforce") return fallback;
  // A shadow answer is recorded by runDecision and has no effect.
  const dropBelow = appliedThreshold(cfg, use, result.answeredBy.model, "drop_below");
  const scored: Array<{ topic: TopicState; p: number }> = [];
  const excluded = new Set<string>();
  let droppedBelow = 0;
  for (const [k, topic] of result.context.map) {
    const a = result.response.answers[HEAD_SELECT_QUESTIONS.relevantId(k)];
    const p = a !== undefined && a.valid === true && typeof a.value === "number" ? a.value : null;
    // No valid answer: the model did not judge the head, which keeps
    // its fallback place in the tail below.
    if (p === null) continue;
    if (p < dropBelow) {
      droppedBelow += 1;
      excluded.add(topic.id);
      continue;
    }
    scored.push({ topic, p });
  }
  scored.sort(
    (a, b) =>
      b.p - a.p ||
      b.topic.updatedAt - a.topic.updatedAt ||
      (a.topic.id < b.topic.id ? -1 : a.topic.id > b.topic.id ? 1 : 0),
  );
  const applied = new Set(scored.map((s) => s.topic.id));
  // The heads the model never judged (invalid answers) keep their
  // fallback order after the scored ones; the excluded ones stay out.
  const tail = input.heads.filter((t) => !applied.has(t.id) && !excluded.has(t.id));
  return { heads: [...scored.map((s) => s.topic), ...tail], droppedBelow, applied: true };
}
