/**
 * Shared context and helpers of the dream-time decide pass (`decide.ts`
 * orchestrates; one file per use family: `decide-route.ts`,
 * `decide-items.ts`). Fail-closed to the deterministic plan everywhere;
 * `shadow` answers are recorded by `runDecision` and are not returned.
 *
 * Privacy (design D10, "Private data stays local"): every candidate is
 * sent only when {@link mayShareRecord} allows it, so the shared state
 * builder masks it out of the state and the deterministic result stands.
 * `<private>` regions are always stripped by the state builder.
 */

import type {
  DecisionModelUse,
  DecisionProvider,
  DecisionResponse,
} from "../decision-model/contract.ts";
import type { ResolvedDecisionModelConfig } from "../decision-model/config-types.ts";
import { TOPIC_DECISION_LIMITS } from "../decision-model/questions-topics.ts";
import { mayShareRecord, shareableHeadFields } from "../decision-model/egress-guard.ts";
import { clip, type StateCandidate } from "../decision-model/state.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { privateRegionTexts, stripPrivateRegions } from "../redactor.ts";
import { textCarriesPrivateRegion } from "../store/private-region.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { TOPIC_PERSONAL_SCOPE, TOPIC_PROJECT_SCOPE_PREFIX } from "./constants.ts";
import type { TopicCandidate } from "./candidates.ts";
import type { TopicFold } from "./fold.ts";
import type { TopicPlan } from "./plan.ts";
import type { TopicVerdictBody } from "./verdicts.ts";
import type { AskedSet } from "./decide-asked.ts";

export const DECIDE_PASS_BUDGET_MS = 20_000;

/**
 * How far back the pass asks about a record: eight ISO weeks. A subject
 * whose answer writes nothing (a routine kind, a `none` route, an answer
 * below the threshold) has no stored verdict to settle it, so the window
 * and the device-local asked set (`decide-asked.ts`) end its re-asking;
 * inside it the newest go first.
 */
export const DECIDE_LOOKBACK_MS = 8 * 7 * 24 * 60 * 60 * 1000;

/**
 * The candidates the pass may ask about: inside {@link DECIDE_LOOKBACK_MS}
 * of `nowMs`, newest first, so every per-pass cap takes the newest and a
 * new record never starves behind older ones. A record dated after
 * `nowMs` (a device with a fast clock) comes after every present one, so
 * it never holds the top of the queue. The asked set (`decide-asked.ts`)
 * then lets the older ones have their turn.
 */
export function askableCandidates(
  candidates: ReadonlyArray<TopicCandidate>,
  nowMs: number,
): TopicCandidate[] {
  // Ties keep the newest id first: the order below is stable.
  return newestPresentFirst(
    candidates
      .filter((c) => nowMs - c.at <= DECIDE_LOOKBACK_MS)
      .toSorted((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)),
    nowMs,
  );
}

/**
 * The order every use takes its subjects in: newest first, so a per-pass
 * or per-request cap takes the newest, and an item dated after `nowMs`
 * (a device with a fast clock) after every present one, so it never
 * holds the top of the queue. Stable: ties keep their order.
 */
export function newestPresentFirst<T extends { readonly at: number }>(
  items: ReadonlyArray<T>,
  nowMs: number,
): T[] {
  const future = (item: T): number => (item.at > nowMs ? 1 : 0);
  return items.toSorted((x, y) => future(x) - future(y) || y.at - x.at);
}

/**
 * The moment the next use must stop starting requests: an even share of
 * what is left of the pass budget among the uses still to run, so a long
 * queue of one use never leaves the later ones nothing. Time a use does
 * not spend rolls over to the next.
 */
export function useShareUntil(nowMs: number, passUntil: number, usesLeft: number): number {
  const left = Math.max(0, passUntil - nowMs);
  return Math.min(passUntil, nowMs + Math.ceil(left / Math.max(1, usesLeft)));
}

/** A subject id that belongs to a private record or topic, in record details. */
export const WITHHELD_ID = "(withheld)";

export interface DecideTopicPlanOptions {
  /** The machine config naming the store (absent: the process's own). */
  readonly configPath?: string;
  /** Wall clock (default `Date.now`): the pass's budget runs on it. */
  readonly now?: () => number;
  /**
   * The date the dream run is for (its `now`), when it has one: the
   * writer gate, the store read, the plan and the history window follow
   * it, as planning does under the lock, while the budget stays on the
   * wall clock. Absent: the wall clock.
   */
  readonly runAt?: Date;
  /** Injected provider (tests): replaces the whole chain. */
  readonly provider?: DecisionProvider;
  /** Config environment override (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The pass's whole budget in ms (default {@link DECIDE_PASS_BUDGET_MS}). */
  readonly deadlineMs?: number;
}

/** Per-use mutable accumulators during one decide pass. */
export interface PassState {
  routes: Map<string, { topic: string | null; privateInput: boolean; verdict: TopicVerdictBody }>;
  kinds: Map<
    string,
    { kind: string; topic: string; privateInput: boolean; verdict: TopicVerdictBody }
  >;
  vetoes: Map<string, { verdict: TopicVerdictBody; veto: boolean }>;
  sameTopics: { a: string; b: string; option: string; verdict: TopicVerdictBody }[];
  resolutions: Map<
    string,
    {
      topic: string;
      question: string;
      owner: string;
      privateInput: boolean;
      verdict: TopicVerdictBody;
    }
  >;
  completions: {
    topic: string;
    milestone: string;
    owner: string;
    privateInput: boolean;
    verdict: TopicVerdictBody;
  }[];
  hidden: Map<string, TopicVerdictBody>;
  kept: Map<string, TopicVerdictBody>;
}

export interface PassContext {
  readonly store: StoreHandle;
  readonly cfg: ResolvedDecisionModelConfig;
  /** Wall clock: no request starts after {@link PassContext.until}. */
  readonly clock: () => number;
  /** The date the run is for (`runAt`, else the wall clock): record ages follow it. */
  readonly at: () => number;
  readonly options: DecideTopicPlanOptions;
  readonly fold: TopicFold;
  readonly candidates: ReadonlyArray<TopicCandidate>;
  readonly byId: ReadonlyMap<string, TopicCandidate>;
  readonly plan: TopicPlan;
  /**
   * No request of the running use starts after this moment: its share of
   * the pass budget (`decide.ts`), never past the pass's whole budget.
   */
  readonly until: number;
  readonly out: PassState;
  /** The subjects whose answer wrote nothing on an earlier pass (`decide-asked.ts`). */
  readonly asked: AskedSet;
}

/** The scope key of a candidate, as the planner derives it. */
export function scopeOf(candidate: TopicCandidate): string {
  return candidate.project === null
    ? TOPIC_PERSONAL_SCOPE
    : `${TOPIC_PROJECT_SCOPE_PREFIX}${candidate.project}`;
}

/** The canonical topic that holds `candidate`, or `null`, as the planner reads it. */
export function holderOf(fold: TopicFold, candidate: TopicCandidate): string | null {
  const assigned = fold.assignments.get(candidate.id);
  if (assigned !== undefined) return assigned;
  return candidate.topic === null ? null : (fold.canonical(candidate.topic) ?? null);
}

/**
 * The time one request of the running use may take: the configured
 * timeout, never past {@link PassContext.until}, so a request started
 * late in a use's share cannot run past the pass's budget.
 */
export function requestTimeoutMs(ctx: PassContext): number {
  return Math.max(1, Math.min(ctx.cfg.timeoutMs, ctx.until - ctx.clock()));
}

/** The state candidate of one store record, guarded by the egress rule. */
export function recordCandidate(
  ctx: PassContext,
  use: DecisionModelUse,
  candidate: TopicCandidate,
): StateCandidate {
  const text = candidate.text;
  return {
    text,
    visibility: mayShareRecord(ctx.cfg, use, candidate.private)
      ? []
      : [REMOTE_DENY_VISIBILITY_TOKEN],
    privateRegions: privateRegionTexts(text),
  };
}

/**
 * Clipped topic head fields, or `null` when the topic may not leave the
 * machine; a private field of a shared topic reads empty unless private
 * records of the use may leave (`shareableHeadFields`).
 */
export function headFields(
  ctx: PassContext,
  use: DecisionModelUse,
  topicId: string,
): { readonly title: string; readonly description: string; readonly goal: string } | null {
  const topic = ctx.fold.topics.get(topicId);
  if (topic === undefined) return null;
  if (!mayShareRecord(ctx.cfg, use, topic.private)) return null;
  const max = TOPIC_DECISION_LIMITS.headFieldClipChars;
  const head = shareableHeadFields(ctx.cfg, use, topic);
  // A side text rides beside the candidates, outside the state builder:
  // `<private>` regions are stripped here, as from every candidate text.
  return {
    title: clip(stripPrivateRegions(head.title), max),
    description: clip(stripPrivateRegions(head.description), max),
    goal: clip(stripPrivateRegions(head.goal), max),
  };
}

/**
 * Whether the head fields of `topicId` the use sends ({@link headFields})
 * bring a private input into the question: the topic is private, or a
 * sent field is private on its own or carries a `<private>` region (the
 * region is stripped, the field around it is still sent). A topic or
 * field the egress rule keeps home is no input.
 */
export function headIsPrivateInput(
  ctx: PassContext,
  use: DecisionModelUse,
  topicId: string,
  fields: ReadonlyArray<"title" | "description" | "goal">,
): boolean {
  const topic = ctx.fold.topics.get(topicId);
  if (topic === undefined || !mayShareRecord(ctx.cfg, use, topic.private)) return false;
  if (topic.private) return true;
  return fields.some((name) => {
    const value = topic[name] ?? "";
    if (value === "") return false;
    // A private field the egress rule withholds is never sent.
    if (topic.privateFields[name] && !mayShareRecord(ctx.cfg, use, true)) return false;
    return topic.privateFields[name] || textCarriesPrivateRegion(value);
  });
}

/**
 * Whether a topic item (a question, a milestone) the use sends is a
 * private input: it or its topic is private, or its text carries a
 * `<private>` region. An item the egress rule keeps home is no input.
 */
export function itemIsPrivateInput(
  ctx: PassContext,
  use: DecisionModelUse,
  item: { readonly private: boolean; readonly text: string },
  topicPrivate: boolean,
): boolean {
  const isPrivate = item.private || topicPrivate;
  if (!mayShareRecord(ctx.cfg, use, isPrivate)) return false;
  return isPrivate || textCarriesPrivateRegion(item.text);
}

/** The probability of the chosen option of a valid `choice` answer. */
export function choiceConfidence(answer: {
  readonly value: unknown;
  readonly probabilities?: Readonly<Record<string, number>>;
}): {
  readonly key: string;
  readonly confidence: number;
} | null {
  if (typeof answer.value !== "string") return null;
  const confidence = answer.probabilities?.[answer.value];
  return typeof confidence === "number" ? { key: answer.value, confidence } : null;
}

/** The probability of a valid `noul` answer. */
export function noulProbability(
  answer: { readonly value: unknown; readonly valid?: boolean } | undefined,
): number | null {
  return answer !== undefined && answer.valid === true && typeof answer.value === "number"
    ? answer.value
    : null;
}

/** Shared options of every request the pass sends. */
export function requestOptions(
  ctx: PassContext,
  recordDetails: (
    response: DecisionResponse | null,
    context: unknown,
    answeredBy: { readonly provider: string; readonly model: string | null },
  ) => Record<string, unknown>,
): Record<string, unknown> {
  return {
    recordDetails,
    ...(ctx.options.provider !== undefined ? { provider: ctx.options.provider } : {}),
    ...(ctx.options.env !== undefined ? { env: ctx.options.env } : {}),
  };
}
