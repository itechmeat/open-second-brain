/**
 * `topic_route` and `topic_new` of the dream-time decide pass (design
 * D10): the routing and create-veto questions, built from the fold and
 * the deterministic plan the orchestrator (`decide.ts`) read. One file
 * per use family; the shared context lives in `decide-shared.ts`.
 */

import {
  TOPIC_DECISION_LIMITS,
  TOPIC_NEW_QUESTIONS,
  TOPIC_ROUTE_QUESTIONS,
} from "../decision-model/questions-topics.ts";
import { mayShareRecord } from "../decision-model/egress-guard.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import { runDecision } from "../decision-model/run.ts";
import { stripPrivateRegions } from "../redactor.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { buildCandidateState, clip } from "../decision-model/state.ts";
import type { TopicCandidate } from "./candidates.ts";
import { rankedRouteTopics, type TopicPlan } from "./plan.ts";
import {
  choiceConfidence,
  headFields,
  headIsPrivateInput,
  holderOf,
  noulProbability,
  requestOptions,
  recordCandidate,
  scopeOf,
  WITHHELD_ID,
  type PassContext,
  requestTimeoutMs,
} from "./decide-shared.ts";
import { topicGroupKey, verdictBody } from "./verdicts.ts";

// ----- topic_route ---------------------------------------------------------

/** The head fields a route question sends for each offered topic. */
const HEAD_FIELDS = ["title", "description", "goal"] as const;

interface RouteEntry {
  readonly candidate: TopicCandidate;
  readonly optionIds: string[];
}

/**
 * `topic_route` (design D10): `choice` per unassigned candidate, batched
 * one scope per request and at most `recordsPerRequest` records per
 * request, the options the deterministic ranking (best first) plus
 * `none`, capped at `topicOptionsPerQuestion`. A chosen topic at or
 * above `route_min` becomes a route verdict; `none` at or above it
 * leaves the record free for grouping; everything else - off, shadow,
 * timeout, invalid answer, below threshold - keeps the deterministic
 * route.
 */
export async function decideRoutes(ctx: PassContext): Promise<void> {
  const use = "topic_route" as const;
  const entries: RouteEntry[] = [];
  for (const candidate of ctx.candidates) {
    if (holderOf(ctx.fold, candidate) !== null) continue;
    // A record the egress rule keeps home is skipped before the cap; an
    // enforce `none` an earlier pass gave it is applied all the same.
    const shareable = mayShareRecord(ctx.cfg, use, candidate.private);
    if (ctx.asked.has(use, candidate.id)) {
      // An enforce `none` an earlier pass gave keeps the record free.
      const kept = ctx.asked.verdict(use, candidate.id);
      if (kept !== undefined) {
        ctx.out.routes.set(candidate.id, { topic: null, privateInput: false, verdict: kept });
      }
      continue;
    }
    if (!shareable) continue;
    // A topic the egress rule keeps home takes no option slot either.
    const optionIds = rankedRouteTopics(ctx.fold, candidate)
      .filter((id) => mayShareRecord(ctx.cfg, use, ctx.fold.topics.get(id)?.private ?? true))
      .slice(0, TOPIC_DECISION_LIMITS.topicOptionsPerQuestion);
    if (optionIds.length > 0) entries.push({ candidate, optionIds });
  }
  if (entries.length > TOPIC_DECISION_LIMITS.recordsPerPass) {
    entries.length = TOPIC_DECISION_LIMITS.recordsPerPass;
  }
  const byScope = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const scope = scopeOf(entry.candidate);
    const bucket = byScope.get(scope);
    if (bucket === undefined) byScope.set(scope, [entry]);
    else bucket.push(entry);
  }
  for (const entriesOfScope of byScope.values()) {
    for (let i = 0; i < entriesOfScope.length; i += TOPIC_DECISION_LIMITS.recordsPerRequest) {
      if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
      // Sequential by design: the budget is checked before every request.
      // oxlint-disable-next-line no-await-in-loop
      await runRouteRequest(
        ctx,
        use,
        entriesOfScope.slice(i, i + TOPIC_DECISION_LIMITS.recordsPerRequest),
      );
    }
  }
}

async function runRouteRequest(
  ctx: PassContext,
  use: "topic_route",
  entries: ReadonlyArray<RouteEntry>,
): Promise<void> {
  // The request's topics, keyed T0..Tn in the entries' option order; a
  // private topic that may not leave the machine is no option at all.
  const topicKeys = new Map<string, string>();
  const topicsState: Record<string, { title: string; description: string; goal: string }> = {};
  for (const entry of entries) {
    for (const topicId of entry.optionIds) {
      if (topicKeys.has(topicId)) continue;
      const fields = headFields(ctx, use, topicId);
      if (fields === null) continue;
      const key = `T${topicKeys.size}`;
      topicKeys.set(topicId, key);
      topicsState[key] = fields;
    }
  }
  const askable = entries
    .map((entry) => ({
      ...entry,
      keys: entry.optionIds.filter((id) => topicKeys.has(id)).map((id) => topicKeys.get(id)!),
    }))
    .filter((entry) => entry.keys.length > 0);
  if (askable.length === 0) return;
  /** `map[k]` is the entry behind mask `R<k>`. */
  const context = { map: new Map<number, (typeof askable)[number]>() };
  const built = buildCandidateState({
    candidates: askable.map((entry) => recordCandidate(ctx, use, entry.candidate)),
    prefix: TOPIC_ROUTE_QUESTIONS.recordPrefix,
    clipChars: TOPIC_DECISION_LIMITS.recordClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    frame: (texts) => ({ records: texts, topics: topicsState }),
  });
  if (built.kind !== "ok") return;
  built.included.forEach((candidateIndex, k) => context.map.set(k, askable[candidateIndex]!));
  const questions: Record<string, import("../decision-model/contract.ts").DecisionChoiceQuestion> =
    {};
  for (const [k, entry] of context.map) {
    if (entry.keys.length === 0) continue;
    questions[TOPIC_ROUTE_QUESTIONS.routeId(k)] = TOPIC_ROUTE_QUESTIONS.route(k, entry.keys);
  }
  const deterministic = new Map<number, string | null>(
    [...context.map].map(([k, entry]) => [k, entry.optionIds[0] ?? null]),
  );
  const result = await runDecision<{ map: Map<number, (typeof askable)[number]> }>(
    use,
    () => ({
      kind: "ok",
      state: built.state,
      candidateCount: built.included.length,
      context,
    }),
    () => questions,
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response, builtContext) => {
        const details: Record<string, unknown> = {
          record_ids: askable.map((entry) =>
            mayShareRecord(ctx.cfg, use, entry.candidate.private)
              ? entry.candidate.id
              : WITHHELD_ID,
          ),
        };
        if (response === null || builtContext === null) return details;
        const chosen: Array<string | null> = [];
        const probabilities: Array<number | null> = [];
        for (const [k] of (builtContext as { map: Map<number, (typeof askable)[number]> }).map) {
          const pick =
            response.answers[TOPIC_ROUTE_QUESTIONS.routeId(k)]?.valid === true
              ? choiceConfidence(response.answers[TOPIC_ROUTE_QUESTIONS.routeId(k)]!)
              : null;
          chosen.push(pick?.key ?? null);
          probabilities.push(pick?.confidence ?? null);
        }
        details["chosen"] = chosen;
        details["probabilities"] = probabilities;
        details["deterministic"] = [...deterministic.values()];
        return details;
      }),
    },
  );
  if (result.status !== "ok") return;
  const answered = { model: result.answeredBy.model, mode: result.mode };
  const routeMin = appliedThreshold(ctx.cfg, use, result.answeredBy.model, "route_min");
  // Answer option keys (T0..Tn) back to topic ids.
  const keyToTopic = new Map([...topicKeys].map(([id, key]) => [key, id]));
  // Every answer reads the whole request: each record sent and every
  // topic of the shared topics state (another record's options too) is
  // an input of every route it yields.
  const requestPrivate =
    [...context.map.values()].some((entry) => entry.candidate.private) ||
    [...topicKeys.keys()].some((id) => headIsPrivateInput(ctx, use, id, HEAD_FIELDS));
  for (const [k, entry] of context.map) {
    const a = result.response.answers[TOPIC_ROUTE_QUESTIONS.routeId(k)];
    if (a?.valid !== true) continue;
    const pick = choiceConfidence(a);
    const topic =
      pick === null || pick.key === TOPIC_ROUTE_QUESTIONS.noneOption
        ? null
        : (keyToTopic.get(pick.key) ?? null);
    // Shadow and an answer below the threshold write nothing: entered in
    // the asked set. A route lands as an assign, which settles it; a
    // `none` writes nothing either and keeps the record free for grouping,
    // so it is entered with its verdict and later passes apply it again.
    if (result.mode !== "enforce" || pick === null || pick.confidence < routeMin) {
      ctx.asked.add(use, entry.candidate.id, answered, entry.candidate.at);
      continue;
    }
    if (pick.key !== TOPIC_ROUTE_QUESTIONS.noneOption && topic === null) continue;
    const verdict = verdictBody(use, result.response, result.answeredBy.provider, pick.confidence);
    if (topic === null) {
      ctx.asked.add(use, entry.candidate.id, answered, entry.candidate.at, verdict);
    }
    ctx.out.routes.set(entry.candidate.id, { topic, privateInput: requestPrivate, verdict });
  }
}

// ----- topic_new -----------------------------------------------------------

/**
 * `topic_new` (design D10): `noul` per group the deterministic plan
 * would create, the state the drafted title and up to
 * `groupMembersShown` member texts, one request per group. p(yes) below
 * `veto_below` vetoes the creation for this pass only; at or above it
 * the approval rides the create as its verdict. The thresholds hold
 * before anything is asked: the model can never create a group that
 * does not qualify.
 */
export async function decideNew(ctx: PassContext): Promise<void> {
  const use = "topic_new" as const;
  // Members the egress rule keeps home take none of the shown slots, and
  // a group with none to show takes no slot of the pass.
  const askable = ctx.plan.creates
    .map((create) => ({
      create,
      members: create.members
        .map((id) => ctx.byId.get(id))
        .filter((m) => m !== undefined && mayShareRecord(ctx.cfg, use, m.private))
        .slice(0, TOPIC_DECISION_LIMITS.groupMembersShown) as TopicCandidate[],
    }))
    .filter((entry) => entry.members.length > 0)
    .slice(0, TOPIC_DECISION_LIMITS.groupsPerPass);
  for (const { create, members } of askable) {
    if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
    // Sequential by design: the budget is checked before every request.
    // oxlint-disable-next-line no-await-in-loop
    await runNewRequest(ctx, use, create, members);
  }
}

async function runNewRequest(
  ctx: PassContext,
  use: "topic_new",
  create: TopicPlan["creates"][number],
  members: ReadonlyArray<TopicCandidate>,
): Promise<void> {
  // The title is drafted from every member's words, the ones beyond
  // `groupMembersShown` too: it may be sent only when every member of
  // the group may leave the machine. A member the pass cannot see counts
  // as one that may not.
  const titleShareable = create.members.every((id) => {
    const member = ctx.byId.get(id);
    return member !== undefined && mayShareRecord(ctx.cfg, use, member.private);
  });
  const built = buildCandidateState({
    candidates: members.map((m) => recordCandidate(ctx, use, m)),
    prefix: TOPIC_NEW_QUESTIONS.groupPrefix,
    clipChars: TOPIC_DECISION_LIMITS.groupMemberClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    frame: (texts) => ({
      title: titleShareable
        ? clip(stripPrivateRegions(create.title), TOPIC_DECISION_LIMITS.headFieldClipChars)
        : "",
      groups: texts,
    }),
  });
  if (built.kind !== "ok") return;
  const result = await runDecision<{ p: number | null }>(
    use,
    () => ({
      kind: "ok",
      state: built.state,
      candidateCount: built.included.length,
      context: { p: null },
    }),
    () => ({ [TOPIC_NEW_QUESTIONS.newId(0)]: TOPIC_NEW_QUESTIONS.fresh() }),
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response, _context, answeredBy) => {
        const details: Record<string, unknown> = {
          member_ids: members.map((m) =>
            mayShareRecord(ctx.cfg, use, m.private) ? m.id : WITHHELD_ID,
          ),
        };
        if (response !== null) {
          const p = noulProbability(response.answers[TOPIC_NEW_QUESTIONS.newId(0)]);
          details["p_yes"] = p;
          details["veto"] =
            p !== null && p < appliedThreshold(ctx.cfg, use, answeredBy.model, "veto_below");
        }
        return details;
      }),
    },
  );
  if (result.status !== "ok" || result.mode !== "enforce") return;
  const p = noulProbability(result.response.answers[TOPIC_NEW_QUESTIONS.newId(0)]);
  if (p === null) return;
  ctx.out.vetoes.set(topicGroupKey(create.members), {
    verdict: verdictBody(use, result.response, result.answeredBy.provider, p),
    veto: p < appliedThreshold(ctx.cfg, use, result.answeredBy.model, "veto_below"),
  });
}
