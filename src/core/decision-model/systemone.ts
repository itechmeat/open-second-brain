/**
 * `systemone` adapter: `POST <base_url>/v1/systemone`.
 *
 * The wire format TypeSafe serves for Jev, and that OpenRouter, the
 * Vercel AI Gateway compatible route, OpenCode Zen and self-hosted
 * compatible servers also speak:
 *
 *   request   { model, state, questions: { id: { type, instructions, criteria } } }
 *   response  { model, answers: { id: { type, noul | choice + probabilities +
 *               confidence | score + legend + probabilities + confidence } },
 *               usage: { input_tokens, output_tokens, cost? } }
 *
 * Raw `fetch`, no vendor SDK. Network rules:
 *   - the base URL passed `assertHttpEgressEndpoint` at config resolution
 *     and is checked again here;
 *   - `redirect: "error"`, so no redirect carries the key or the state
 *     anywhere the operator did not configure;
 *   - the whole body passes `redactForEgress` before it is sent, and a
 *     refusal degrades with `egress_refused` rather than sending part;
 *   - the bearer header is sent only when a key is set (a self-hosted
 *     loopback server may need none);
 *   - the route's own `choice` limit (52 options for OpenJev, for
 *     example) is checked before sending, and a larger question degrades
 *     with `budget`;
 *   - retries, the reply size cap and error handling follow
 *     `transport.ts`.
 *
 * The Vercel AI Gateway `/v1/evaluate` variant (`vercel-evaluate.ts`)
 * extends this class and only renames fields, so both routes send through
 * this module's single `fetch` and its egress guard call.
 *
 * Errors name the env var that holds the key, never its value, and no
 * response body is ever logged or put into an error message.
 */

import { sha256Hex } from "../integrity/digest.ts";
import { redactForEgress } from "../egress/guard.ts";
import { assertHttpEgressEndpoint } from "../search/embeddings/http-util.ts";
import { CHOICE_MAX_OPTIONS, questionLimitViolation, validateAnswer } from "./answers.ts";
import {
  DecisionProviderError,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionPingResult,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionUsage,
} from "./contract.ts";
import {
  answeringModel,
  decisionHttpError,
  fetchFailure,
  finiteNonNegative,
  isRecord,
  readAttempt,
  withOneRetry,
  type DecisionAttempt,
} from "./transport.ts";

export { MAX_REPLY_BYTES } from "./transport.ts";

/** The registry id this module is declared under in `EGRESS_SITES`. */
export const SYSTEMONE_EGRESS_SITE = "decision-model-systemone";

export interface SystemOneEndpoint {
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  /** NAME of the env var holding the key, for messages. */
  readonly envKey: string | null;
  /** Resolved at call time by the factory; never stored in config. */
  readonly apiKey: string | null;
  readonly allowInsecureHttp?: boolean;
  readonly calibrated: boolean;
  readonly timeoutMs: number;
  /** The route's own `choice` limit; defaults to the wire maximum (255). */
  readonly maxChoiceOptions?: number;
}

function readSnakeUsage(raw: unknown): DecisionUsage {
  if (!isRecord(raw)) return {};
  const inputTokens = finiteNonNegative(raw["input_tokens"]);
  const outputTokens = finiteNonNegative(raw["output_tokens"]);
  const costUsd = finiteNonNegative(raw["cost"]);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export class SystemOneDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly model: string;
  readonly calibrated: boolean;
  private readonly url: string;
  private readonly endpoint: SystemOneEndpoint;

  constructor(endpoint: SystemOneEndpoint) {
    this.endpoint = endpoint;
    this.name = endpoint.name;
    this.model = endpoint.model;
    this.calibrated = endpoint.calibrated;
    const base = assertHttpEgressEndpoint(endpoint.baseUrl, "decision_model_base_url", {
      allowInsecureHttp: endpoint.allowInsecureHttp === true,
      key: "decision_model_allow_insecure_http",
    });
    this.url = `${base.replace(/\/+$/, "")}${this.path()}`;
  }

  /** The route's path below the base URL. */
  protected path(): string {
    return "/v1/systemone";
  }

  /** The questions as this route names them on the wire. */
  protected wireQuestions(
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Readonly<Record<string, unknown>> {
    return questions;
  }

  /** One reply item in the `systemone` answer shape `validateAnswer` reads. */
  protected canonicalAnswer(raw: unknown): unknown {
    return raw;
  }

  protected readUsage(json: Record<string, unknown>): DecisionUsage {
    return readSnakeUsage(json["usage"]);
  }

  async decide(req: DecisionRequest, opts: DecideOptions): Promise<DecisionResponse> {
    const limit = questionLimitViolation(
      req.questions,
      this.endpoint.maxChoiceOptions ?? CHOICE_MAX_OPTIONS,
    );
    if (limit !== null) throw new DecisionProviderError("budget", limit);

    const verdict = redactForEgress(SYSTEMONE_EGRESS_SITE, {
      state: req.state,
      questions: req.questions,
    });
    if (verdict.outcome !== "released") {
      throw new DecisionProviderError(
        "egress_refused",
        "decision request refused by the egress guard; nothing was sent",
      );
    }
    const body = JSON.stringify({
      model: this.model,
      state: verdict.payload.state,
      questions: this.wireQuestions(verdict.payload.questions),
    });
    const stateHash = sha256Hex(JSON.stringify(verdict.payload.state));

    const json = await withOneRetry(
      (signal) => this.send(body, signal, opts.timeoutMs),
      opts,
      (status) => decisionHttpError(status, this.endpoint.envKey),
    );
    return this.parse(json, req, stateHash);
  }

  /** One HTTP attempt. Throws on transport failure; returns the status otherwise. */
  private async send(
    body: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DecisionAttempt> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.endpoint.apiKey !== null && this.endpoint.apiKey !== "") {
      headers["authorization"] = `Bearer ${this.endpoint.apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body,
        // No redirect may carry the key or the state elsewhere.
        redirect: "error",
        signal,
      });
    } catch (e) {
      // A reset or refused connection, or a refused redirect. Never
      // retried: the provider may already have billed the call.
      throw fetchFailure(e, signal, timeoutMs);
    }
    return readAttempt(response, signal, timeoutMs);
  }

  private parse(json: unknown, req: DecisionRequest, stateHash: string): DecisionResponse {
    if (!isRecord(json) || !isRecord(json["answers"])) {
      throw new DecisionProviderError("invalid_reply", "decision reply has no answers map");
    }
    const rawAnswers = json["answers"];
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(req.questions)) {
      answers[id] = validateAnswer(question, this.canonicalAnswer(rawAnswers[id]));
    }
    const model = answeringModel(json["model"], this.model);
    return Object.freeze({
      model,
      answers: Object.freeze(answers),
      usage: Object.freeze(this.readUsage(json)),
      calibrated: this.calibrated,
      stateHash,
    });
  }

  /**
   * One request over a synthetic state that carries no vault content, to
   * show the route answers and which model version answered.
   */
  async ping(): Promise<DecisionPingResult> {
    const started = Date.now();
    try {
      const res = await this.decide(
        {
          use: "rerank",
          state: { text: "Open Second Brain connectivity check." },
          questions: {
            ping: {
              type: "noul",
              instructions: "Is `text` a connectivity check message?",
            },
          },
        },
        { timeoutMs: this.endpoint.timeoutMs },
      );
      if (res.answers["ping"]?.valid !== true) {
        return {
          ok: false,
          reason: "invalid_reply",
          latencyMs: Date.now() - started,
          usage: res.usage,
        };
      }
      return { ok: true, model: res.model, latencyMs: Date.now() - started, usage: res.usage };
    } catch (e) {
      const reason = e instanceof DecisionProviderError ? e.reason : "network";
      return { ok: false, reason, latencyMs: Date.now() - started };
    }
  }
}
