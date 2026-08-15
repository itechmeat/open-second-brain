/**
 * The progress spine at the MCP boundary (nothing-runs-unwatched, U2).
 *
 * A client asks for liveness by putting a token on the request:
 * `params._meta.progressToken`. Until this module `handleToolsCall` read
 * exactly two keys from `params` - `name` and `arguments` - so the token
 * was accepted by the wire and then discarded without a word. That is the
 * silent drop this release exists to remove, and there are only two
 * honest answers to it: carry the events, or say why they cannot be
 * carried.
 *
 * Which answer a transport gives is decided by whether it can write an
 * unsolicited frame at all, not by a flag. stdio reads and writes a
 * newline-delimited duplex stream, so it hands the server a notification
 * writer and the events go out ahead of the response. The HTTP transport
 * answers one request with one response and closes
 * (`res.end` in `http.ts`), so it hands over nothing, and a token that
 * arrives there is refused by name with
 * {@link PROGRESS_REASON.transportSingleResponse} rather than accepted
 * and dropped - accepting it would advertise liveness support that does
 * not exist.
 *
 * The refusal rides on `result._meta`, which is where MCP reserves room
 * for implementation metadata, and it is the exact reciprocal of where
 * the request carried the token. The two alternatives are both wrong for
 * reasons this repository has already written down: `structuredContent`
 * is validated against the tool's `outputSchema`, so a transport fact
 * there would break the contract a caller parses, and `content[0].text`
 * is that same payload rendered - the advisory rail's rule that a
 * machine-readable stream is not a place to put a remark applies
 * verbatim. `_meta` is absent entirely when no token was sent, so a
 * client that did not ask sees a byte-identical response.
 */

import {
  PROGRESS_KIND,
  PROGRESS_SCHEMA,
  type ProgressEvent,
  type ProgressReason,
  type ProgressSink,
} from "../core/brain/progress.ts";
import { INVALID_PARAMS, JSONRPC_VERSION, MCPError } from "./protocol.ts";
import type { JsonRpcNotification } from "./protocol.ts";

/** Spec method name for a progress notification. */
export const PROGRESS_NOTIFICATION_METHOD = "notifications/progress";

/**
 * The `_meta` member both directions of this feature travel under.
 * Namespaced because `_meta` is a shared extension point: a key without a
 * prefix would collide with the next implementation that wants one.
 */
export const PROGRESS_META_KEY = "open-second-brain/progress";

/**
 * What the MCP specification allows a progress token to be: a string or
 * an integer. Deliberately not `number` - a fractional token is a client
 * defect, and coercing it would hand back a value the client cannot match
 * to the request it sent.
 */
export type ProgressToken = string | number;

/**
 * Why no progress could be carried, addressed to the token that asked.
 *
 * A distinct shape from {@link ProgressEvent} rather than a `refused`
 * event with invented fields: the refusal happens before any operation
 * has spoken, so there is no `operation`, no `stage` and no count to
 * report, and filling those in with zeroes would describe a run that
 * never started.
 */
export interface ProgressRefusal {
  readonly schema: typeof PROGRESS_SCHEMA;
  readonly kind: typeof PROGRESS_KIND.refused;
  readonly reason: ProgressReason;
  readonly progressToken: ProgressToken;
}

/** Names the JSON shape of a rejected value, for an error that must say what was wrong. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "number" : "fractional number";
  return typeof value;
}

/**
 * The client's progress token, or `undefined` when it asked for none.
 *
 * Throws {@link MCPError} rather than coercing or ignoring: a token the
 * server silently rewrote could not be matched back to the request that
 * carried it, and a token the server silently dropped is the defect this
 * module exists to remove. An absent `_meta`, and a `_meta` carrying
 * other members but no `progressToken`, both mean "nobody asked" and are
 * not errors.
 */
export function readProgressToken(params: Record<string, unknown>): ProgressToken | undefined {
  const meta = params["_meta"];
  if (meta === undefined) return undefined;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new MCPError(
      INVALID_PARAMS,
      `tools/call _meta must be an object, got ${describeValue(meta)}`,
    );
  }
  const token = (meta as Record<string, unknown>)["progressToken"];
  if (token === undefined) return undefined;
  if (typeof token === "string") return token;
  if (typeof token === "number" && Number.isInteger(token)) return token;
  throw new MCPError(
    INVALID_PARAMS,
    `tools/call _meta.progressToken must be a string or an integer, got ${describeValue(token)}`,
  );
}

/**
 * One `notifications/progress` frame.
 *
 * `progress` and `total` are the spec's own numeric fields, so a client
 * that knows nothing about this repository still renders a bar; the typed
 * event travels beside them under {@link PROGRESS_META_KEY}, so a client
 * that does gets the stage identifier and the operation name without the
 * server having to render a sentence for either.
 */
export function progressNotification(
  token: ProgressToken,
  event: ProgressEvent,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: PROGRESS_NOTIFICATION_METHOD,
    params: {
      progressToken: token,
      progress: event.completed,
      ...(event.total === undefined ? {} : { total: event.total }),
      _meta: { [PROGRESS_META_KEY]: event },
    },
  };
}

/**
 * A sink that turns each event into a notification frame, or `undefined`
 * when there is nothing to turn them into - no token, or no writer.
 *
 * Synchronous by construction, because the spine's sink is: `dream` and
 * its peers are synchronous functions and cannot await a write inside
 * their own loops.
 */
export function progressSink(
  token: ProgressToken | undefined,
  send: ((notification: JsonRpcNotification) => void) | undefined,
): ProgressSink | undefined {
  if (token === undefined || send === undefined) return undefined;
  return (event: ProgressEvent) => send(progressNotification(token, event));
}

/** The typed refusal a single-response transport answers a token with. */
export function progressRefusal(token: ProgressToken, reason: ProgressReason): ProgressRefusal {
  return {
    schema: PROGRESS_SCHEMA,
    kind: PROGRESS_KIND.refused,
    reason,
    progressToken: token,
  };
}

/**
 * Attach a refusal to a `tools/call` result. With no refusal the result
 * is returned untouched - not cloned with an empty `_meta` - so a call
 * that asked for no progress is byte-identical to the one the previous
 * release answered.
 */
export function withProgressRefusal(
  result: Record<string, unknown>,
  refusal: ProgressRefusal | undefined,
): Record<string, unknown> {
  if (refusal === undefined) return result;
  return { ...result, _meta: { [PROGRESS_META_KEY]: refusal } };
}
