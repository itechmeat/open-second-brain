/**
 * The HTTP rules every decision-model adapter shares, without the request
 * itself. Each adapter module calls `fetch` on its own (so the egress
 * census sees every module that sends a body) and hands the response to
 * these helpers:
 *
 *   - {@link readAttempt}: a success body is read up to
 *     {@link MAX_REPLY_BYTES} and parsed as JSON; any other status is
 *     drained unread, so no response body ever reaches a message or log;
 *   - {@link fetchFailure}: a thrown `fetch` becomes `timeout` when the
 *     signal fired and `network` otherwise (a reset, a refused connection
 *     or a refused redirect);
 *   - {@link withOneRetry}: one retry at most, only on 408, 409, 429 and
 *     any 5xx (529 included), honouring `retry-after`, and only within the
 *     remaining timeout. Never after a network error or an aborted
 *     request: that call may already be billed. A wait the timeout cuts
 *     short reports `timeout`.
 */

import { parseRetryAfterMs } from "../search/embeddings/http-util.ts";
import { DecisionProviderError, type DecideOptions } from "./contract.ts";

/** Largest reply body accepted, in bytes. A real reply is a few KiB. */
export const MAX_REPLY_BYTES = 1024 * 1024;

/** 408, 409 and 429 are retried; so is every 5xx (see {@link isRetryable}). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

export function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/** One HTTP attempt: a parsed success body, or the status to act on. */
export type DecisionAttempt =
  | { readonly kind: "ok"; readonly json: unknown }
  | { readonly kind: "status"; readonly status: number; readonly retryAfter: string | null };

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

function timedOut(timeoutMs: number): DecisionProviderError {
  return new DecisionProviderError("timeout", `decision request timed out after ${timeoutMs}ms`);
}

/** The typed failure for a thrown `fetch`. Never retried by the caller. */
export function fetchFailure(
  e: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): DecisionProviderError {
  if (signal.aborted) return timedOut(timeoutMs);
  const name = e instanceof Error ? e.name : "Error";
  return new DecisionProviderError("network", `decision request failed (${name})`);
}

/** Turn a response into an attempt; see the module header. */
export async function readAttempt(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DecisionAttempt> {
  if (response.ok) {
    let text: string | null;
    try {
      text = await readCapped(response, MAX_REPLY_BYTES);
    } catch {
      if (signal.aborted) throw timedOut(timeoutMs);
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
  // Drain without reading the body into any message: an error body
  // (`{message, error_type}` on the Vercel route, `{error: {...}}` on chat
  // routes) may echo the request.
  await response.body?.cancel().catch(() => undefined);
  return {
    kind: "status",
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
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

/**
 * Run `attempt` under the request timeout, retrying once where the module
 * header allows. Returns the parsed success body; throws the typed
 * failure otherwise (`httpError` builds the one for a final status).
 */
export async function withOneRetry(
  attempt: (signal: AbortSignal) => Promise<DecisionAttempt>,
  opts: DecideOptions,
  httpError: (status: number) => DecisionProviderError,
): Promise<unknown> {
  const deadline = Date.now() + opts.timeoutMs;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const first = await attempt(controller.signal);
    if (first.kind === "ok") return first.json;
    if (isRetryable(first.status)) {
      const wait = parseRetryAfterMs(first.retryAfter) ?? 0;
      // Retry once, and only when the wait plus a request still fits.
      if (Date.now() + wait < deadline - 50) {
        await sleep(wait, controller.signal);
        if (controller.signal.aborted) {
          // The timeout (or the caller) cut the wait short: the request
          // ran out of time, whatever the first status was.
          throw timedOut(opts.timeoutMs);
        }
        const second = await attempt(controller.signal);
        if (second.kind === "ok") return second.json;
        throw httpError(second.status);
      }
    }
    throw httpError(first.status);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** The HTTP failure message: the status and, on 401, the key variable's NAME. */
export function decisionHttpError(status: number, envKey: string | null): DecisionProviderError {
  const keyHint = status === 401 && envKey !== null ? `; check the key in ${envKey}` : "";
  return new DecisionProviderError(
    `http_${status}`,
    `decision provider answered HTTP ${status}${keyHint}`,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Longest answering-model id kept from a reply. */
export const MAX_MODEL_ID_CHARS = 128;

/**
 * The answering model a reply names, for the accounting record. The
 * reply is the provider's text, so only a short identifier of printable
 * characters is kept; anything else falls back to the pinned id.
 */
export function answeringModel(raw: unknown, pinned: string): string {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_MODEL_ID_CHARS) return pinned;
  return /^[\x21-\x7e]+$/.test(raw) ? raw : pinned;
}
