/**
 * The decision model chain as an executor of the dream work queue
 * (change `dream-closed-questions`, design D4): it takes ready items of
 * the closed questions, asks one question per item through `runDecision`
 * and answers the item with the model named.
 *
 *  - A configuration that is not active takes nothing (`not-configured`).
 *  - A use set to `off` is left for another executor: its items are not
 *    taken.
 *  - A private item the chain may not receive (`mayShareRecord`) is
 *    released as `egress-refused`, with no failed attempt, and is not
 *    taken again by this executor while that holds.
 *  - In `enforce` the answer is submitted to the queue; a use in `shadow`
 *    releases the item as `shadow`. An untuned shadow fallback under an
 *    enforce use fails with backoff, since that entry may not decide.
 *  - A timeout, a network or reply failure and a state over the token
 *    limit are failed attempts (backoff, then parking); the daily cost
 *    gate releases the item and stops the loop.
 *
 * The chain's privacy checks, cost gate and fallback are `runDecision`'s
 * own and stay unchanged. The loop stops at its deadline.
 */

import { randomUUID } from "node:crypto";

import { discoverConfig, resolveVault } from "../../config.ts";
import { decisionModelModeFor, resolveDecisionModelConfig } from "../../decision-model/config.ts";
import type { ResolvedDecisionModelConfig } from "../../decision-model/config-types.ts";
import type {
  DecisionChoiceQuestion,
  DecisionProvider,
  DecisionQuestion,
} from "../../decision-model/contract.ts";
import { mayShareRecord } from "../../decision-model/egress-guard.ts";
import {
  EVENT_KIND_QUESTIONS,
  HUMAN_READABLE_QUESTIONS,
  MILESTONE_DONE_QUESTIONS,
  QUESTION_RESOLVED_QUESTIONS,
  TOPIC_DECISION_LIMITS,
  TOPIC_NEW_QUESTIONS,
  TOPIC_ROUTE_QUESTIONS,
  TOPIC_SAME_QUESTIONS,
} from "../../decision-model/questions-topics.ts";
import { PAIR_VERDICT_LIMITS } from "../../decision-model/questions.ts";
import { mayStartRequest } from "../../decision-model/request-floor.ts";
import { runDecision } from "../../decision-model/run.ts";
import { clip, estimateTokens } from "../../decision-model/state.ts";
import { appliedThreshold } from "../../decision-model/use-thresholds.ts";
import { stripPrivateRegions } from "../../redactor.ts";
import {
  CLOSED_OPERATIONS,
  isChoiceOperation,
  THRESHOLD_NAME,
  useOfOperation,
  type ClosedOperation,
  type ClosedUse,
} from "../../topics/decide-operations.ts";
import type { DreamWorkItem } from "./fold.ts";
import {
  answerWork,
  failWork,
  releaseWork,
  takeWork,
  type DreamQueue,
  type TakenItem,
} from "./queue.ts";

/** The agent an answer of this executor names. */
export const DECISION_EXECUTOR_AGENT = "decision-model";

/** Release reasons of this executor (kept by the fold with the item's input). */
export const RELEASE_SHADOW = "shadow";
export const RELEASE_EGRESS_REFUSED = "egress-refused";
export const RELEASE_COST_GATE = "cost_gate";

export interface DecisionExecutorOptions {
  /** No request starts at or after this moment of `clock`. */
  readonly until: number;
  /** Wall clock (default `Date.now`). */
  readonly clock?: () => number;
  /** The machine config the decision model is configured in. */
  readonly configPath?: string;
  /** Config environment override (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected provider (tests): replaces the whole chain. */
  readonly provider?: DecisionProvider;
  /** The run the leases name (default: a fresh id). */
  readonly run?: string;
}

export type DecisionExecutorResult =
  | { readonly status: "not-configured" }
  | {
      readonly status: "ran";
      /** Requests sent, per operation. */
      readonly asked: Readonly<Record<ClosedOperation, number>>;
      /** Items answered in enforce. */
      readonly answered: number;
      /** Items asked in shadow and released. */
      readonly shadow: number;
      /** Private items released for a local executor. */
      readonly refused: number;
      /** Failed attempts. */
      readonly failed: number;
      /** Why the loop ended. */
      readonly stopped: "empty" | "deadline" | "cost_gate" | "busy";
    };

/** Whether this executor may take `item` now under `cfg`. */
function takeable(
  cfg: ResolvedDecisionModelConfig,
  item: DreamWorkItem,
  releasedThisRun: ReadonlySet<string>,
): boolean {
  const use = useOfOperation(item.body.operation);
  if (use === null) return false;
  if (releasedThisRun.has(item.id)) return false;
  const mode = decisionModelModeFor(cfg, use);
  if (mode === "off") return false;
  const release = item.last_release;
  if (release !== null && release.input_hash === item.body.input_hash) {
    if (release.reason === RELEASE_SHADOW && mode === "shadow") return false;
    if (release.reason === RELEASE_EGRESS_REFUSED && !mayShareRecord(cfg, use, true)) return false;
  }
  return true;
}

/** A side text as it may be sent: `<private>` regions stripped, clipped. */
function text(value: unknown, max: number): string {
  return clip(stripPrivateRegions(typeof value === "string" ? value : ""), max);
}

interface Built {
  readonly state: Record<string, unknown>;
  readonly id: string;
  readonly question: DecisionQuestion;
  /** Answer option key to the item's option (choice questions). */
  readonly options?: ReadonlyMap<string, string>;
}

/** The request for one item, built from its payload. */
function buildRequest(item: TakenItem): Built {
  const p = item.payload as Record<string, unknown>;
  const records = TOPIC_DECISION_LIMITS.recordClipChars;
  const head = TOPIC_DECISION_LIMITS.headFieldClipChars;
  switch (item.operation as ClosedOperation) {
    case "topic-route": {
      const topics = (p["topics"] as Array<Record<string, unknown>>) ?? [];
      const keys = topics.map((_, i) => `T${i}`);
      const options = new Map(topics.map((t, i) => [`T${i}`, String(t["id"])]));
      options.set(TOPIC_ROUTE_QUESTIONS.noneOption, TOPIC_ROUTE_QUESTIONS.noneOption);
      return {
        state: {
          records: { R0: text(p["text"], records) },
          topics: Object.fromEntries(
            topics.map((t, i) => [
              `T${i}`,
              {
                title: text(t["title"], head),
                description: text(t["description"], head),
                goal: text(t["goal"], head),
              },
            ]),
          ),
        },
        id: TOPIC_ROUTE_QUESTIONS.routeId(0),
        question: TOPIC_ROUTE_QUESTIONS.route(0, keys),
        options,
      };
    }
    case "topic-new": {
      const members = ((p["members"] as Array<Record<string, unknown>>) ?? []).slice(
        0,
        TOPIC_DECISION_LIMITS.groupMembersShown,
      );
      return {
        state: {
          title: text(p["title"], head),
          groups: Object.fromEntries(
            members.map((m, i) => [
              `${TOPIC_NEW_QUESTIONS.groupPrefix}${i}`,
              text(m["text"], TOPIC_DECISION_LIMITS.groupMemberClipChars),
            ]),
          ),
        },
        id: TOPIC_NEW_QUESTIONS.newId(0),
        question: TOPIC_NEW_QUESTIONS.fresh(),
      };
    }
    case "topic-same": {
      const side = (s: unknown): string => {
        const t = (s ?? {}) as Record<string, unknown>;
        return [t["title"], t["description"], t["goal"]]
          .map((v) => text(v, TOPIC_SAME_QUESTIONS.clipChars))
          .filter((v) => v !== "")
          .join(" - ");
      };
      return {
        state: {
          pairs: {
            [`${PAIR_VERDICT_LIMITS.prefixA}0`]: side(p["a"]),
            [`${PAIR_VERDICT_LIMITS.prefixB}0`]: side(p["b"]),
          },
        },
        id: PAIR_VERDICT_LIMITS.questionId(0),
        question: TOPIC_SAME_QUESTIONS.question(0),
        options: new Map(TOPIC_SAME_QUESTIONS.options.map((o) => [o, o])),
      };
    }
    case "event-kind":
      return {
        state: {
          records: { R0: { topic: text(p["title"], head), text: text(p["text"], records) } },
        },
        id: EVENT_KIND_QUESTIONS.kindId(0),
        question: EVENT_KIND_QUESTIONS.kind(0),
        options: new Map(
          Object.keys((EVENT_KIND_QUESTIONS.kind(0) as DecisionChoiceQuestion).criteria).map(
            (k) => [k, k],
          ),
        ),
      };
    case "question-resolved": {
      const questions = (p["questions"] as Array<Record<string, unknown>>) ?? [];
      const keys = questions.map((_, i) => `Q${i}`);
      const options = new Map(questions.map((q, i) => [`Q${i}`, String(q["key"])]));
      options.set(QUESTION_RESOLVED_QUESTIONS.noneOption, QUESTION_RESOLVED_QUESTIONS.noneOption);
      return {
        state: {
          records: { R0: { topic: text(p["title"], head), text: text(p["text"], records) } },
          questions: Object.fromEntries(questions.map((q, i) => [`Q${i}`, text(q["text"], head)])),
        },
        id: QUESTION_RESOLVED_QUESTIONS.answersId(0),
        question: QUESTION_RESOLVED_QUESTIONS.answers(0, keys),
        options,
      };
    }
    case "milestone-done": {
      const shown = (p["records"] as Array<Record<string, unknown>>) ?? [];
      return {
        state: {
          milestones: { M0: text(p["milestone"], head) },
          records: Object.fromEntries(
            shown.map((r, i) => [
              `R${i}`,
              text(r["text"], TOPIC_DECISION_LIMITS.groupMemberClipChars),
            ]),
          ),
        },
        id: MILESTONE_DONE_QUESTIONS.doneId(0),
        question: MILESTONE_DONE_QUESTIONS.done(0),
      };
    }
    case "human-readable":
      return {
        state: { records: { R0: text(p["text"], records) } },
        id: HUMAN_READABLE_QUESTIONS.historyId(0),
        question: HUMAN_READABLE_QUESTIONS.history(0),
      };
  }
}

/** Ask the decision model chain about ready closed questions until the deadline. */
export async function runDecisionExecutor(
  queue: DreamQueue,
  options: DecisionExecutorOptions,
): Promise<DecisionExecutorResult> {
  const clock = options.clock ?? Date.now;
  const cfg = resolveDecisionModelConfig({
    env: options.env ?? process.env,
    config: discoverConfig(options.configPath).data,
    vault: queue.vault ?? resolveVault(options.configPath),
  });
  if (cfg.status !== "active") return { status: "not-configured" };
  const run = options.run ?? randomUUID();
  const asked = Object.fromEntries(CLOSED_OPERATIONS.map((op) => [op, 0])) as Record<
    ClosedOperation,
    number
  >;
  const counts = { answered: 0, shadow: 0, refused: 0, failed: 0 };
  const releasedThisRun = new Set<string>();
  const done = (stopped: "empty" | "deadline" | "cost_gate" | "busy"): DecisionExecutorResult => ({
    status: "ran",
    asked,
    ...counts,
    stopped,
  });
  for (;;) {
    if (!mayStartRequest(clock(), options.until, cfg.timeoutMs)) return done("deadline");
    // Sequential by design: one item at a time, the deadline checked before each.
    const taken = takeWork(queue, {
      run,
      filter: (item) => takeable(cfg, item, releasedThisRun),
    });
    if (taken.item === null) return done(taken.reason === "busy" ? "busy" : "empty");
    const item = taken.item;
    const operation = item.operation as ClosedOperation;
    const use = useOfOperation(operation) as ClosedUse;
    const lease = {
      item: item.id,
      generation: item.generation,
      lease_token: item.lease_token,
    };
    if (item.partition === "private" && !mayShareRecord(cfg, use, true)) {
      const released = releaseWork(queue, { ...lease, reason: RELEASE_EGRESS_REFUSED }).released;
      releasedThisRun.add(item.id);
      if (released) counts.refused += 1;
      continue;
    }
    const built = buildRequest(item);
    // oxlint-disable-next-line no-await-in-loop -- one item at a time, the deadline checked before each
    const result = await runDecision<null>(
      use,
      () => {
        const state = built.state;
        if (
          estimateTokens({ state, questions: { [built.id]: built.question } }) > cfg.maxStateTokens
        ) {
          return { kind: "budget" };
        }
        return { kind: "ok", state, candidateCount: 1, context: null };
      },
      () => ({ [built.id]: built.question }),
      {
        config: cfg,
        onRequest: () => {
          asked[operation] += 1;
        },
        timeoutMs: Math.max(0, Math.min(cfg.timeoutMs, options.until - clock())),
        requestFloor: true,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        // The record of the answer (shadow too, for tuning): identifiers
        // and numbers only, the option key chosen or the probability of yes.
        recordDetails: (response) => {
          const answer = response?.answers[built.id];
          if (answer === undefined || !answer.valid) return { item: item.id, operation };
          if (typeof answer.value === "string") {
            return {
              item: item.id,
              operation,
              chosen: [answer.value],
              probabilities: [answer.probabilities?.[answer.value] ?? null],
            };
          }
          return {
            item: item.id,
            operation,
            p_yes: typeof answer.value === "number" ? answer.value : null,
          };
        },
      },
    );
    if (result.status === "off") {
      // The chain has no entry that can answer: nothing more to ask.
      releaseWork(queue, lease);
      return done("empty");
    }
    if (result.status === "degraded") {
      if (result.reason === "cost_gate") {
        releaseWork(queue, { ...lease, reason: RELEASE_COST_GATE });
        return done("cost_gate");
      }
      if (result.reason === "budget" && !mayStartRequest(clock(), options.until, cfg.timeoutMs)) {
        // The pass ran out of time after the take: no request was sent, so
        // this is not a failed attempt. The item goes back as it was.
        releaseWork(queue, lease);
        return done("deadline");
      }
      if (failWork(queue, { ...lease, reason: result.reason }).failed) counts.failed += 1;
      continue;
    }
    if (result.status === "empty") {
      if (failWork(queue, { ...lease, reason: "empty state" }).failed) counts.failed += 1;
      continue;
    }
    if (result.mode !== "enforce") {
      const answer = result.response.answers[built.id];
      if (answer === undefined || !answer.valid) {
        if (failWork(queue, { ...lease, reason: "invalid_reply" }).failed) counts.failed += 1;
        continue;
      }
      if (decisionModelModeFor(cfg, use) === "enforce") {
        // This chain entry is held to shadow, so it cannot decide an
        // enforce use. Back off instead of immediately asking it again.
        if (failWork(queue, { ...lease, reason: "shadow answer under enforce use" }).failed) {
          counts.failed += 1;
        }
      } else {
        const released = releaseWork(queue, { ...lease, reason: RELEASE_SHADOW }).released;
        releasedThisRun.add(item.id);
        if (released) counts.shadow += 1;
      }
      continue;
    }
    const answer = result.response.answers[built.id];
    const model = result.response.model;
    const author = {
      provider: result.answeredBy.provider,
      model,
      threshold: appliedThreshold(cfg, use, result.answeredBy.model, THRESHOLD_NAME[operation]),
    };
    let value: Record<string, unknown> | null = null;
    if (answer !== undefined && answer.valid) {
      if (isChoiceOperation(operation)) {
        const chosen =
          typeof answer.value === "string" ? built.options?.get(answer.value) : undefined;
        const confidence =
          typeof answer.value === "string" ? answer.probabilities?.[answer.value] : undefined;
        if (chosen !== undefined) {
          value = {
            choice: chosen,
            ...(typeof confidence === "number" ? { confidence } : {}),
            ...author,
          };
        }
      } else if (typeof answer.value === "number") {
        value = { p: answer.value, ...author };
      }
    }
    if (value === null) {
      if (failWork(queue, { ...lease, reason: "invalid_reply" }).failed) counts.failed += 1;
      continue;
    }
    const answered = answerWork(queue, {
      ...lease,
      value,
      agent: DECISION_EXECUTOR_AGENT,
      model,
    });
    if (answered.status === "accepted") counts.answered += 1;
    else if (answered.status === "failed") counts.failed += 1;
    else if (answered.status === "unavailable") {
      releaseWork(queue, { ...lease, reason: "input_unavailable" });
      releasedThisRun.add(item.id);
    }
  }
}
