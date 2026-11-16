/**
 * The record-item uses of the dream-time decide pass (design D10):
 * `event_kind` derives one item record per held record, and the
 * `question_resolved` and `milestone_done` proposals, built from the
 * fold and the deterministic plan the orchestrator (`decide.ts`) read.
 * One file per use family; the shared context lives in
 * `decide-shared.ts`, the writes happen under the planning lock
 * (`verdict-writes.ts`).
 */

import type { DecisionChoiceQuestion, DecisionNoulQuestion } from "../decision-model/contract.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import {
  EVENT_KIND_QUESTIONS,
  MILESTONE_DONE_QUESTIONS,
  QUESTION_RESOLVED_QUESTIONS,
  TOPIC_DECISION_LIMITS,
} from "../decision-model/questions-topics.ts";
import { mayShareRecord } from "../decision-model/egress-guard.ts";
import { runDecision } from "../decision-model/run.ts";
import { stripPrivateRegions } from "../redactor.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { buildCandidateState, clip } from "../decision-model/state.ts";
import type { TopicCandidate } from "./candidates.ts";
import type { TopicFold } from "./fold.ts";
import {
  choiceConfidence,
  headFields,
  headIsPrivateInput,
  holderOf,
  itemIsPrivateInput,
  noulProbability,
  requestOptions,
  recordCandidate,
  WITHHELD_ID,
  type PassContext,
  requestTimeoutMs,
} from "./decide-shared.ts";
import { verdictBody } from "./verdicts.ts";

/**
 * The topic holding each candidate this pass: the fold's assignments,
 * else the route `topic_route` accepted earlier in this pass (a `none`
 * keeps the record free), else the deterministic plan's route.
 */
function holdingTopic(ctx: PassContext, candidate: TopicCandidate): string | null {
  const held = holderOf(ctx.fold, candidate);
  if (held !== null) return held;
  const accepted = ctx.out.routes.get(candidate.id);
  if (accepted !== undefined) return accepted.topic;
  const routed = ctx.plan.routes.find((route) => route.record === candidate.id);
  return routed?.topic ?? null;
}

/**
 * Whether the topic already carries the derived item of `recordId` (item
 * id = record id), or carried it until a split moved it away: the id
 * still names that item, so no second one is derived.
 */
function hasDerivedItem(fold: TopicFold, topicId: string, recordId: string): boolean {
  return (
    (fold.topics.get(topicId)?.items.some((item) => item.id === recordId) ?? false) ||
    fold.movedAway(topicId, recordId)
  );
}

/**
 * An item by its owner and id: item ids are a topic's own, and a merged
 * topic shows the items of the topics merged into it, so the id alone
 * can name two items.
 */
function ownedItemKey(item: { readonly owner: string; readonly id: string }): string {
  return `${item.owner}/${item.id}`;
}

/** The asked-set subject of a resolution question: the record and the questions offered. */
function resolutionSubject(
  recordId: string,
  questions: ReadonlyArray<{ readonly owner: string; readonly id: string }>,
): string {
  return `${recordId}:${questions.map(ownedItemKey).join(",")}`;
}

/** The asked-set subject of a milestone question: the milestone and its evidence. */
function completionSubject(
  milestone: { readonly owner: string; readonly id: string },
  members: ReadonlyArray<{ readonly id: string }>,
): string {
  return `${ownedItemKey(milestone)}:${members.map((m) => m.id).join(",")}`;
}

// ----- event_kind ------------------------------------------------------------

/**
 * `event_kind` (design D10): `choice` per candidate held by a topic
 * (assigned earlier or routed this pass) with no derived item yet,
 * batched one scope per request and at most `recordsPerRequest` records
 * per request, the state `{ records: { R0..: { topic, text } } }` with
 * the topic title. A non-routine answer at or above `kind_min` becomes a
 * kinds verdict; the derived item record is written under the planning
 * lock (`verdict-writes.ts`), the item id equal to the record id, which
 * makes the pass idempotent. Routine answers and every failure keep
 * today's behaviour (no page item).
 */
async function decideEventKinds(ctx: PassContext): Promise<void> {
  const use = "event_kind" as const;
  const entries: Array<{ candidate: TopicCandidate; topic: string }> = [];
  for (const candidate of ctx.candidates) {
    const topic = holdingTopic(ctx, candidate);
    if (topic === null) continue;
    if (hasDerivedItem(ctx.fold, topic, candidate.id)) continue;
    if (ctx.asked.has(use, candidate.id)) continue;
    // A record the egress rule keeps home is skipped before the cap.
    if (!mayShareRecord(ctx.cfg, use, candidate.private)) continue;
    entries.push({ candidate, topic });
  }
  if (entries.length > TOPIC_DECISION_LIMITS.recordsPerPass) {
    entries.length = TOPIC_DECISION_LIMITS.recordsPerPass;
  }
  for (let i = 0; i < entries.length; i += TOPIC_DECISION_LIMITS.recordsPerRequest) {
    if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
    // Sequential by design: the budget is checked before every request.
    // oxlint-disable-next-line no-await-in-loop
    await runKindRequest(ctx, use, entries.slice(i, i + TOPIC_DECISION_LIMITS.recordsPerRequest));
  }
}

async function runKindRequest(
  ctx: PassContext,
  use: "event_kind",
  entries: ReadonlyArray<{ candidate: TopicCandidate; topic: string }>,
): Promise<void> {
  // Each masked record carries its holding topic's title beside its text,
  // inside the state the builder measures against `maxStateTokens`.
  const built = buildCandidateState({
    candidates: entries.map((entry) => ({
      ...recordCandidate(ctx, use, entry.candidate),
      fields: { topic: headFields(ctx, use, entry.topic)?.title ?? "" },
    })),
    prefix: EVENT_KIND_QUESTIONS.recordPrefix,
    clipChars: TOPIC_DECISION_LIMITS.recordClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    frame: (texts) => ({ records: texts }),
  });
  if (built.kind !== "ok") return;
  const state = built.state;
  const context = {
    /** `map[k]` is the entry behind mask `R<k>`. */
    map: new Map<number, (typeof entries)[number]>(),
  };
  built.included.forEach((candidateIndex, k) => context.map.set(k, entries[candidateIndex]!));
  const questions: Record<string, DecisionChoiceQuestion> = {};
  for (const [k] of context.map) {
    questions[EVENT_KIND_QUESTIONS.kindId(k)] = EVENT_KIND_QUESTIONS.kind(k);
  }
  const result = await runDecision<{ map: Map<number, (typeof entries)[number]> }>(
    use,
    () => ({
      kind: "ok",
      state,
      candidateCount: built.included.length,
      context,
    }),
    () => questions,
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response, builtContext) => {
        const details: Record<string, unknown> = {
          record_ids: entries.map((entry) =>
            mayShareRecord(ctx.cfg, use, entry.candidate.private)
              ? entry.candidate.id
              : WITHHELD_ID,
          ),
        };
        if (response === null || builtContext === null) return details;
        const chosen: Array<string | null> = [];
        const probabilities: Array<number | null> = [];
        for (const [k] of (builtContext as { map: Map<number, (typeof entries)[number]> }).map) {
          const a = response.answers[EVENT_KIND_QUESTIONS.kindId(k)];
          const pick = a?.valid === true ? choiceConfidence(a) : null;
          chosen.push(pick?.key ?? null);
          probabilities.push(pick?.confidence ?? null);
        }
        details["chosen"] = chosen;
        details["probabilities"] = probabilities;
        return details;
      }),
    },
  );
  if (result.status !== "ok") return;
  const answered = { model: result.answeredBy.model, mode: result.mode };
  const kindMin = appliedThreshold(ctx.cfg, use, result.answeredBy.model, "kind_min");
  // Every answer reads the whole request: each record sent and the topic
  // title beside it (another record's too) is an input of every item.
  const requestPrivate = [...context.map.values()].some(
    (entry) => entry.candidate.private || headIsPrivateInput(ctx, use, entry.topic, ["title"]),
  );
  for (const [k, entry] of context.map) {
    const a = result.response.answers[EVENT_KIND_QUESTIONS.kindId(k)];
    if (a?.valid !== true) continue;
    const pick = choiceConfidence(a);
    // An answer that writes nothing (shadow, below the threshold, a
    // routine kind) is entered in the asked set: not asked again.
    if (
      result.mode !== "enforce" ||
      pick === null ||
      pick.confidence < kindMin ||
      pick.key === "routine"
    ) {
      ctx.asked.add(use, entry.candidate.id, answered, entry.candidate.at);
      continue;
    }
    ctx.out.kinds.set(entry.candidate.id, {
      kind: pick.key,
      topic: entry.topic,
      privateInput: requestPrivate,
      verdict: verdictBody(use, result.response, result.answeredBy.provider, pick.confidence),
    });
  }
}

// ----- question_resolved -----------------------------------------------------

/** The topic's open questions without a pending proposal, oldest first. */
function openQuestions(
  ctx: PassContext,
  use: "question_resolved",
  topicId: string,
): Array<{ id: string; owner: string; text: string; createdAt: number; privateInput: boolean }> {
  const topic = ctx.fold.topics.get(topicId);
  return (
    (topic?.items ?? [])
      .filter(
        (item) =>
          item.kind === "open-question" &&
          item.resolved === undefined &&
          item.resolveProposed === undefined &&
          // A private question (or one of a private topic) is no option
          // when its text may not leave the machine.
          mayShareRecord(ctx.cfg, use, item.private || topic!.private),
      )
      // Side texts: `<private>` regions are stripped, as from every candidate.
      .map((item) => ({
        id: item.id,
        owner: item.owner,
        text: stripPrivateRegions(item.text),
        createdAt: item.createdAt,
        privateInput: itemIsPrivateInput(ctx, use, item, topic!.private),
      }))
      .toSorted((a, b) => a.createdAt - b.createdAt)
  );
}

/**
 * `question_resolved` (design D10): `choice` per record held by a topic
 * that has open questions, the record newer than the question; the
 * options are that topic's open questions without a pending proposal
 * (capped, oldest first) plus `none`. A chosen question at or above
 * `resolved_min` becomes a resolution verdict; the `question-resolved`
 * proposal record is written under the planning lock, and the fold
 * shows it as "looks answered". Everything else proposes nothing.
 */
async function decideResolutions(ctx: PassContext): Promise<void> {
  const use = "question_resolved" as const;
  const entries: Array<{
    candidate: TopicCandidate;
    topic: string;
    questions: Array<{ id: string; owner: string; text: string; privateInput: boolean }>;
  }> = [];
  for (const candidate of ctx.candidates) {
    // A record the egress rule keeps home is skipped before the cap.
    if (!mayShareRecord(ctx.cfg, use, candidate.private)) continue;
    const topic = holdingTopic(ctx, candidate);
    if (topic === null) continue;
    const questions = openQuestions(ctx, use, topic)
      .filter((question) => question.createdAt < candidate.at)
      .slice(0, TOPIC_DECISION_LIMITS.topicOptionsPerQuestion);
    if (questions.length === 0) continue;
    if (ctx.asked.has(use, resolutionSubject(candidate.id, questions))) continue;
    entries.push({ candidate, topic, questions });
  }
  if (entries.length > TOPIC_DECISION_LIMITS.recordsPerPass) {
    entries.length = TOPIC_DECISION_LIMITS.recordsPerPass;
  }
  for (const entry of entries) {
    if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
    // One request per record: each record's option set is its own.
    // oxlint-disable-next-line no-await-in-loop
    await runResolutionRequest(ctx, use, entry);
  }
}

async function runResolutionRequest(
  ctx: PassContext,
  use: "question_resolved",
  entry: {
    candidate: TopicCandidate;
    topic: string;
    questions: Array<{ id: string; owner: string; text: string; privateInput: boolean }>;
  },
): Promise<void> {
  const questionsState = Object.fromEntries(
    entry.questions.map((question, i) => [
      `Q${i}`,
      clip(question.text, TOPIC_DECISION_LIMITS.headFieldClipChars),
    ]),
  );
  const criteriaKeys = entry.questions.map((question, i) => `Q${i}`);
  // The state carries the record beside the topic's question texts, and
  // the budget is measured over both.
  const built = buildCandidateState({
    candidates: [recordCandidate(ctx, use, entry.candidate)],
    prefix: QUESTION_RESOLVED_QUESTIONS.recordPrefix,
    clipChars: TOPIC_DECISION_LIMITS.recordClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    frame: (texts) => ({
      records: {
        R0: { topic: headFields(ctx, use, entry.topic)?.title ?? "", text: texts["R0"] ?? "" },
      },
      questions: questionsState,
    }),
  });
  if (built.kind !== "ok") return;
  const state = built.state;
  const result = await runDecision<{ recordId: string }>(
    use,
    () => ({
      kind: "ok",
      state,
      candidateCount: 1,
      context: { recordId: entry.candidate.id },
    }),
    () => ({
      [QUESTION_RESOLVED_QUESTIONS.answersId(0)]: QUESTION_RESOLVED_QUESTIONS.answers(
        0,
        criteriaKeys,
      ),
    }),
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response) => {
        const details: Record<string, unknown> = {
          record_ids: [
            mayShareRecord(ctx.cfg, use, entry.candidate.private)
              ? entry.candidate.id
              : WITHHELD_ID,
          ],
          question_ids: entry.questions.map((question) => question.id),
        };
        if (response !== null) {
          const a = response.answers[QUESTION_RESOLVED_QUESTIONS.answersId(0)];
          const pick = a?.valid === true ? choiceConfidence(a) : null;
          details["chosen"] = pick?.key ?? null;
          details["probability"] = pick?.confidence ?? null;
        }
        return details;
      }),
    },
  );
  if (result.status !== "ok") return;
  const a = result.response.answers[QUESTION_RESOLVED_QUESTIONS.answersId(0)];
  if (a?.valid !== true) return;
  const pick = choiceConfidence(a);
  // An answer that proposes nothing is entered in the asked set.
  if (
    result.mode !== "enforce" ||
    pick === null ||
    pick.confidence < appliedThreshold(ctx.cfg, use, result.answeredBy.model, "resolved_min") ||
    pick.key === QUESTION_RESOLVED_QUESTIONS.noneOption
  ) {
    ctx.asked.add(
      use,
      resolutionSubject(entry.candidate.id, entry.questions),
      { model: result.answeredBy.model, mode: result.mode },
      entry.candidate.at,
    );
    return;
  }
  const chosen = entry.questions[Number(pick.key.slice(1))]!;
  ctx.out.resolutions.set(entry.candidate.id, {
    topic: entry.topic,
    question: chosen.id,
    owner: chosen.owner,
    // Every question offered and the topic title are inputs of the answer.
    privateInput:
      entry.questions.some((question) => question.privateInput) ||
      headIsPrivateInput(ctx, use, entry.topic, ["title"]),
    verdict: verdictBody(use, result.response, result.answeredBy.provider, pick.confidence),
  });
}

// ----- milestone_done --------------------------------------------------------

/** The topic's open milestones: nothing proposed or marked done yet. */
function openMilestones(
  ctx: PassContext,
  use: "milestone_done",
  topicId: string,
): Array<{ id: string; owner: string; text: string; createdAt: number; privateInput: boolean }> {
  const topic = ctx.fold.topics.get(topicId);
  return (topic?.items ?? [])
    .filter(
      (item) =>
        item.kind === "milestone" &&
        item.done === undefined &&
        item.doneProposed === undefined &&
        // A private milestone (or one of a private topic) is not asked
        // about when its text may not leave the machine.
        mayShareRecord(ctx.cfg, use, item.private || topic!.private),
    )
    .map((item) => ({
      id: item.id,
      owner: item.owner,
      text: stripPrivateRegions(item.text),
      createdAt: item.createdAt,
      privateInput: itemIsPrivateInput(ctx, use, item, topic!.private),
    }));
}

/**
 * `milestone_done` (design D10): `noul` per open milestone of a topic
 * with held records newer than the milestone, one request per
 * milestone; the state carries the milestone text and up to 5 of the
 * newest held record texts. p(yes) at or above `done_min` becomes a
 * completion verdict; the `milestone-done` proposal record is written
 * under the planning lock, never with evidence, so the fold shows
 * "looks done, confirm" and the milestone stays open. Everything else
 * proposes nothing.
 */
async function decideCompletions(ctx: PassContext): Promise<void> {
  const use = "milestone_done" as const;
  const entries: Array<{
    topic: string;
    milestone: { id: string; owner: string; text: string; privateInput: boolean };
    members: ReadonlyArray<TopicCandidate>;
  }> = [];
  // `ctx.candidates` is already in the pass's order (`newestPresentFirst`:
  // newest first, records dated after the run behind every present one),
  // and a filter keeps it.
  const rank = new Map(ctx.candidates.map((c, i) => [c.id, i]));
  for (const topicId of [...ctx.fold.topics.keys()].toSorted()) {
    const milestones = openMilestones(ctx, use, topicId);
    if (milestones.length === 0) continue;
    // Evidence the egress rule keeps home takes none of the shown slots.
    const members = ctx.candidates.filter(
      (c) => mayShareRecord(ctx.cfg, use, c.private) && holdingTopic(ctx, c) === topicId,
    );
    for (const milestone of milestones) {
      const newer = members.filter((c) => c.at > milestone.createdAt);
      if (newer.length === 0) continue;
      const shown = newer.slice(0, 5);
      if (ctx.asked.has(use, completionSubject(milestone, shown))) continue;
      entries.push({ topic: topicId, milestone, members: shown });
    }
  }
  // In the same order by the first record shown: a milestone with fresh
  // evidence is asked before one whose evidence is old, one with only
  // future-dated evidence last.
  const ordered = entries
    .toSorted((x, y) => rank.get(x.members[0]!.id)! - rank.get(y.members[0]!.id)!)
    .slice(0, TOPIC_DECISION_LIMITS.recordsPerPass);
  for (const entry of ordered) {
    if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
    // One request per milestone: the state is the milestone's own.
    // oxlint-disable-next-line no-await-in-loop
    await runCompletionRequest(ctx, use, entry);
  }
}

async function runCompletionRequest(
  ctx: PassContext,
  use: "milestone_done",
  entry: {
    topic: string;
    milestone: { id: string; owner: string; text: string; privateInput: boolean };
    members: ReadonlyArray<TopicCandidate>;
  },
): Promise<void> {
  const built = buildCandidateState({
    candidates: entry.members.map((m) => recordCandidate(ctx, use, m)),
    prefix: MILESTONE_DONE_QUESTIONS.recordPrefix,
    clipChars: TOPIC_DECISION_LIMITS.groupMemberClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    // The milestone text rides the state too: the budget counts it.
    frame: (texts) => ({
      milestones: { M0: clip(entry.milestone.text, TOPIC_DECISION_LIMITS.headFieldClipChars) },
      records: texts,
    }),
  });
  if (built.kind !== "ok") return;
  const questions: Record<string, DecisionNoulQuestion> = {
    [MILESTONE_DONE_QUESTIONS.doneId(0)]: MILESTONE_DONE_QUESTIONS.done(0),
  };
  const state = built.state;
  const result = await runDecision<{ milestoneId: string }>(
    use,
    () => ({
      kind: "ok",
      state,
      candidateCount: built.included.length,
      context: { milestoneId: entry.milestone.id },
    }),
    () => questions,
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response) => {
        const details: Record<string, unknown> = {
          milestone_ids: [entry.milestone.id],
          record_ids: entry.members.map((m) =>
            mayShareRecord(ctx.cfg, use, m.private) ? m.id : WITHHELD_ID,
          ),
        };
        if (response !== null) {
          details["p_yes"] = noulProbability(response.answers[MILESTONE_DONE_QUESTIONS.doneId(0)]);
        }
        return details;
      }),
    },
  );
  if (result.status !== "ok") return;
  const p = noulProbability(result.response.answers[MILESTONE_DONE_QUESTIONS.doneId(0)]);
  if (p === null) return;
  // "Not done" (or shadow, or below the threshold) proposes nothing: it is
  // entered in the asked set until newer evidence arrives.
  if (
    result.mode !== "enforce" ||
    p < appliedThreshold(ctx.cfg, use, result.answeredBy.model, "done_min")
  ) {
    ctx.asked.add(
      use,
      completionSubject(entry.milestone, entry.members),
      { model: result.answeredBy.model, mode: result.mode },
      entry.members[0]?.at ?? 0,
    );
    return;
  }
  ctx.out.completions.push({
    topic: entry.topic,
    milestone: entry.milestone.id,
    owner: entry.milestone.owner,
    // The milestone text and every evidence record the egress rule let
    // through are inputs of the answer.
    privateInput:
      entry.milestone.privateInput || built.included.some((index) => entry.members[index]!.private),
    verdict: verdictBody(use, result.response, result.answeredBy.provider, p),
  });
}

export { decideEventKinds, decideResolutions, decideCompletions };
