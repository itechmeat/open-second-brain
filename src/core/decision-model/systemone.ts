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
 *   - one retry at most, only on 408, 409, 429 and any 5xx (529
 *     included), honouring `retry-after`, and only within the remaining
 *     timeout. Never after a network error or an aborted request: that
 *     call may already be billed. A wait the timeout cuts short reports
 *     `timeout`;
 *   - the reply body is read up to {@link MAX_REPLY_BYTES}; a larger one
 *     is an `invalid_reply` and is not read further.
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

/** 408, 409 and 429 are retried; so is every 5xx (see {@link isRetryable}). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/** Largest reply body accepted, in bytes. A real reply is a few KiB. */
export const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * Read a body up to `limit` bytes. Returns null when it is larger; the
 * rest is cancelled unread.
 */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // eslint-disable-next-line no-await-in-loop -- leaves the loop right after
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

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
      if (isRetryable(first.status)) {
        const wait = parseRetryAfterMs(first.retryAfter) ?? 0;
        // Retry once, and only when the wait plus a request still fits.
        if (Date.now() + wait < deadline - 50) {
          await sleep(wait, controller.signal);
          if (controller.signal.aborted) {
            // The timeout (or the caller) cut the wait short: the request
            // ran out of time, whatever the first status was.
            throw new DecisionProviderError(
              "timeout",
              `decision request timed out after ${opts.timeoutMs}ms`,
            );
          }
          const second = await this.send(body, controller.signal, opts.timeoutMs);
          if (second.kind === "ok") return second.json;
          throw this.httpError(second.status);
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
      let text: string | null;
      try {
        text = await readCapped(response, MAX_REPLY_BYTES);
      } catch {
        if (signal.aborted) throw timedOut();
        throw new DecisionProviderError("network", "decision reply could not be read");
      }
      if (text === null) {
        throw new DecisionProviderError(
          "invalid_reply",
          `decision reply is larger than ${MAX_REPLY_BYTES} bytes`,
        );
      }
      try {
        return { kind: "ok", json: JSON.parse(text) as unknown };
      } catch {
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
