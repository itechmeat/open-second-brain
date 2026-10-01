/**
 * Readers for the two places an MCP failure carries its stable code.
 *
 * Channel A, a JSON-RPC error response: `error.data.code`.
 * Channel B, an `isError: true` tool result:
 * `result._meta["open-second-brain/error"].code`, beside the schema tag.
 *
 * Both readers THROW a named {@link ToolErrorEnvelopeMissing} when the
 * member is absent or malformed instead of returning `undefined`, so a
 * test asserting a code cannot pass by comparing `undefined` with a
 * missing expectation, and a failure names exactly which piece of the
 * envelope was not there. The code itself is returned as the raw string
 * the wire carried, so an unexpected value shows up in the assertion
 * diff rather than as a second, less specific error.
 */

import { TOOL_ERROR_META_KEY, TOOL_ERROR_SCHEMA } from "../../src/mcp/tool-error-codes.ts";

/** A required member of the error envelope was absent or of the wrong type. */
export class ToolErrorEnvelopeMissing extends Error {
  constructor(what: string, received: unknown) {
    super(`${what} is missing from the error envelope; received ${JSON.stringify(received)}`);
    this.name = "ToolErrorEnvelopeMissing";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `value[key]` as a record, or a named throw naming `what`. */
function recordAt(value: unknown, key: string, what: string): Readonly<Record<string, unknown>> {
  const member = isRecord(value) ? value[key] : undefined;
  if (!isRecord(member)) throw new ToolErrorEnvelopeMissing(what, value);
  return member;
}

/** `value[key]` as a string, or a named throw naming `what`. */
function stringAt(value: Readonly<Record<string, unknown>>, key: string, what: string): string {
  const member = value[key];
  if (typeof member !== "string") throw new ToolErrorEnvelopeMissing(what, value);
  return member;
}

/**
 * The code an `isError` tool result carries on `_meta`.
 *
 * Accepts the tool result itself (`response.result`), and also checks the
 * payload's schema tag, because a payload under the right key with the
 * wrong schema is a different envelope.
 */
export function readToolErrorCode(result: unknown): string {
  const meta = recordAt(result, "_meta", "result._meta");
  const payload = recordAt(meta, TOOL_ERROR_META_KEY, `result._meta["${TOOL_ERROR_META_KEY}"]`);
  const schema = stringAt(payload, "schema", `result._meta["${TOOL_ERROR_META_KEY}"].schema`);
  if (schema !== TOOL_ERROR_SCHEMA) {
    throw new ToolErrorEnvelopeMissing(
      `result._meta["${TOOL_ERROR_META_KEY}"].schema ${TOOL_ERROR_SCHEMA}`,
      payload,
    );
  }
  return stringAt(payload, "code", `result._meta["${TOOL_ERROR_META_KEY}"].code`);
}

/** The code a JSON-RPC error response carries on `error.data`. */
export function readRpcErrorCode(response: unknown): string {
  const error = recordAt(response, "error", "response.error");
  const data = recordAt(error, "data", "response.error.data");
  return stringAt(data, "code", "response.error.data.code");
}
