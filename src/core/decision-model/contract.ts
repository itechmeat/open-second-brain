/**
 * Decision-model contract: the leaf every decision-model module depends on.
 *
 * A decision model is a typed judgment model. Given a text `state` and a
 * set of questions it returns one typed answer per question with
 * probabilities, and it never generates text. Three question types exist:
 * `noul` (probability of yes), `choice` (one of 1-255 options) and `score`
 * (a position on 2-10 ordered levels). Every question in one request
 * shares one read of the state.
 *
 * How this fits "Open Second Brain never calls an LLM": a decision is a
 * judgment over candidates this product's own code built, never text.
 * The deterministic result stays canonical and is the fallback on every
 * failure, and no decision ever writes to the vault. Only a gated
 * accounting record (identifiers and numbers, never state or question
 * text) is persisted. Nothing here trains, fine-tunes or distils a model
 * on recorded answers, and nothing may: the main hosted vendor's terms
 * forbid training an imitating model on its outputs.
 *
 * Mirrors `search/rerank/contract.ts`: split out from the factory so an
 * adapter depends only on this file.
 */

/**
 * Every place a decision model may be used. Each use has its own mode in
 * `decision_model_uses`.
 */
export const DECISION_MODEL_USES = Object.freeze([
  "rerank",
  "answerable",
  "skills",
  "extract_prefilter",
  "dedup",
  "tension",
  "labels",
  "recall_inject",
] as const);

export type DecisionModelUse = (typeof DECISION_MODEL_USES)[number];

export function isDecisionModelUse(value: unknown): value is DecisionModelUse {
  return (
    typeof value === "string" && (DECISION_MODEL_USES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The `token_impact.source` attribution of a use's host-side savings,
 * `decision_model:<use>`. An identifier, never text.
 */
export function decisionTokenImpactSource(use: DecisionModelUse): string {
  return `decision_model:${use}`;
}

/**
 * Per-use mode. `off` builds no state and sends nothing. `shadow` sends
 * the request and records the answer but returns today's deterministic
 * result. `enforce` lets the use apply the answer within its own limits.
 */
export const DECISION_MODEL_MODES = Object.freeze(["off", "shadow", "enforce"] as const);

export type DecisionModelMode = (typeof DECISION_MODEL_MODES)[number];

export function isDecisionModelMode(value: unknown): value is DecisionModelMode {
  return (
    typeof value === "string" && (DECISION_MODEL_MODES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Where a recorded request came from when it is not an ordinary use call:
 * the rerank eval gate (`eval`) or `o2b decision-model check --ping`
 * (`ping`). Kept out of the shadow agreement, counted toward the gate.
 */
export type DecisionCallOrigin = "eval" | "ping";

/**
 * Why a decision was not applied. A closed set, recorded in the
 * `decision_model_call` accounting record as the outcome.
 *
 * `http_<status>` covers every non-success HTTP status the provider
 * answered with (401, 402, 422, 429, 529, ...).
 */
export type DecisionDegradeReason =
  | "cost_gate"
  | "budget"
  | "egress_refused"
  | "timeout"
  | "network"
  | "invalid_reply"
  | `http_${number}`;

/** Instructions and criteria accept a string or a structured object. */
export type DecisionText = string | Readonly<Record<string, unknown>>;

export interface DecisionNoulQuestion {
  readonly type: "noul";
  readonly instructions: DecisionText;
  readonly criteria?: { readonly true?: DecisionText; readonly false?: DecisionText };
}

export interface DecisionChoiceQuestion {
  readonly type: "choice";
  readonly instructions: DecisionText;
  /** 1-255 options; the key is the option id, the value its description or null. */
  readonly criteria: Readonly<Record<string, DecisionText | null>>;
}

export interface DecisionScoreQuestion {
  readonly type: "score";
  readonly instructions: DecisionText;
  /** 2-10 ordered levels, lowest first. */
  readonly criteria: ReadonlyArray<DecisionText>;
}

export type DecisionQuestion =
  | DecisionNoulQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;

export type DecisionState = string | Readonly<Record<string, unknown>> | ReadonlyArray<unknown>;

export interface DecisionRequest {
  readonly use: DecisionModelUse;
  readonly state: DecisionState;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/**
 * One typed answer. `value` is P(yes) for `noul`, the chosen option key
 * for `choice`, and the expected level for `score`. An item that failed
 * validation is `valid: false` and is treated by every use as absent.
 */
export interface DecisionAnswer {
  readonly type: DecisionQuestion["type"];
  readonly value: number | string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
  readonly valid: boolean;
}

export interface DecisionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface DecisionResponse {
  /** The model version that actually answered, as the provider reported it. */
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage: DecisionUsage;
  /** Whether the provider's probabilities are calibrated. */
  readonly calibrated: boolean;
  /** sha-256 of the redacted state that was sent; never the state itself. */
  readonly stateHash?: string;
}

export interface DecisionPingResult {
  readonly ok: boolean;
  /** The answering model on success. */
  readonly model?: string;
  readonly latencyMs?: number;
  /** A degrade reason on failure, never a response body. */
  readonly reason?: string;
  /** Usage of the ping request when a reply arrived, for its accounting record. */
  readonly usage?: DecisionUsage;
}

export interface DecideOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface DecisionProvider {
  readonly name: string;
  /** The pinned model id this provider requests. */
  readonly model: string;
  readonly calibrated: boolean;
  /**
   * Send one request. Throws {@link DecisionProviderError} on any
   * transport, HTTP, redaction or reply-shape failure; the caller
   * (`runDecision`) owns the fail-open.
   */
  decide(req: DecisionRequest, opts: DecideOptions): Promise<DecisionResponse>;
  ping(): Promise<DecisionPingResult>;
}

/**
 * A typed provider failure. The message never carries a response body or
 * a key value; it may name the env var that holds the key.
 */
export class DecisionProviderError extends Error {
  readonly reason: DecisionDegradeReason;

  constructor(reason: DecisionDegradeReason, message: string) {
    super(message);
    this.name = "DecisionProviderError";
    this.reason = reason;
  }
}

/**
 * The advisory `answerable` answer a decision-model rerank carries: the
 * probability that the passages together answer the query, the answering
 * model and whether the provider is calibrated (issue #213, Part 8).
 */
export interface DecisionAnswerableSignal {
  readonly probability: number;
  readonly model: string;
  readonly calibrated: boolean;
}
