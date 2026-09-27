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
 *   - one retry at most, only on 408, 409, 429, 5xx and 529, honouring
 *     `retry-after`, and only within the remaining timeout. Never after a
 *     network error or an aborted request: that call may already be
 *     billed.
 *
 * Errors name the env var that holds the key, never its value, and no
 * response body is ever logged or put into an error message.
 */

import { sha256Hex } from "../integrity/digest.ts";
import { redactForEgress } from "../egress/guard.ts";
import { assertHttpEgressEndpoint, parseRetryAfterMs } from "../search/embeddings/http-util.ts";
import { questionLimitViolation, validateAnswer } from "./answers.ts";
import {
  DecisionProviderError,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionPingResult,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionUsage,
} from "./contract.ts";

/** The registry id this module is declared under in `EGRESS_SITES`. */
export const SYSTEMONE_EGRESS_SITE = "decision-model-systemone";

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readUsage(raw: unknown): DecisionUsage {
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
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
    this.url = `${base.replace(/\/+$/, "")}/v1/systemone`;
  }

  async decide(req: DecisionRequest, opts: DecideOptions): Promise<DecisionResponse> {
    const limit = questionLimitViolation(req.questions);
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
      questions: verdict.payload.questions,
    });
    const stateHash = sha256Hex(JSON.stringify(verdict.payload.state));

    const json = await this.post(body, opts);
    return this.parse(json, req, stateHash);
  }

  private async post(body: string, opts: DecideOptions): Promise<unknown> {
    const deadline = Date.now() + opts.timeoutMs;
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const first = await this.send(body, controller.signal, opts.timeoutMs);
      if (first.kind === "ok") return first.json;
      if (RETRYABLE_STATUSES.has(first.status)) {
        const wait = parseRetryAfterMs(first.retryAfter) ?? 0;
        // Retry once, and only when the wait plus a request still fits.
        if (Date.now() + wait < deadline - 50) {
          await sleep(wait, controller.signal);
          if (!controller.signal.aborted) {
            const second = await this.send(body, controller.signal, opts.timeoutMs);
            if (second.kind === "ok") return second.json;
            throw this.httpError(second.status);
          }
        }
      }
      throw this.httpError(first.status);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  private httpError(status: number): DecisionProviderError {
    const keyHint =
      status === 401 && this.endpoint.envKey !== null
        ? `; check the key in ${this.endpoint.envKey}`
        : "";
    return new DecisionProviderError(
      `http_${status}`,
      `decision provider answered HTTP ${status}${keyHint}`,
    );
  }

  /** One HTTP attempt. Throws on transport failure; returns the status otherwise. */
  private async send(
    body: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "ok"; readonly json: unknown }
    | { readonly kind: "status"; readonly status: number; readonly retryAfter: string | null }
  > {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.endpoint.apiKey !== null && this.endpoint.apiKey !== "") {
      headers["authorization"] = `Bearer ${this.endpoint.apiKey}`;
    }
    const timedOut = (): DecisionProviderError =>
      new DecisionProviderError("timeout", `decision request timed out after ${timeoutMs}ms`);
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
      if (signal.aborted) throw timedOut();
      // A reset or refused connection, or a refused redirect. Never
      // retried: the provider may already have billed the call.
      const name = e instanceof Error ? e.name : "Error";
      throw new DecisionProviderError("network", `decision request failed (${name})`);
    }
    if (response.ok) {
      try {
        return { kind: "ok", json: await response.json() };
      } catch {
        if (signal.aborted) throw timedOut();
        throw new DecisionProviderError("invalid_reply", "decision reply is not JSON");
      }
    }
    // Drain without reading the body into any message.
    await response.body?.cancel().catch(() => undefined);
    return {
      kind: "status",
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
    };
  }

  private parse(json: unknown, req: DecisionRequest, stateHash: string): DecisionResponse {
    if (!isRecord(json) || !isRecord(json["answers"])) {
      throw new DecisionProviderError("invalid_reply", "decision reply has no answers map");
    }
    const rawAnswers = json["answers"];
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(req.questions)) {
      answers[id] = validateAnswer(question, rawAnswers[id]);
    }
    const model =
      typeof json["model"] === "string" && json["model"] !== "" ? json["model"] : this.model;
    return Object.freeze({
      model,
      answers: Object.freeze(answers),
      usage: Object.freeze(readUsage(json["usage"])),
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
        return { ok: false, reason: "invalid_reply", latencyMs: Date.now() - started };
      }
      return { ok: true, model: res.model, latencyMs: Date.now() - started };
    } catch (e) {
      const reason = e instanceof DecisionProviderError ? e.reason : "network";
      return { ok: false, reason, latencyMs: Date.now() - started };
    }
  }
}
