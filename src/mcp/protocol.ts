/**
 * MCP / JSON-RPC 2.0 protocol constants and shared error type.
 *
 * Mirrors the constants exposed by the legacy Python `open_second_brain.mcp`
 * module so cross-runtime tooling (clients, integration tests) can re-use the
 * same JSON-RPC error codes.
 */

import { OPEN_SECOND_BRAIN_VERSION } from "../core/version.ts";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "open-second-brain";
export const JSONRPC_VERSION = "2.0";
export const SERVER_VERSION: string = OPEN_SECOND_BRAIN_VERSION;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * The closed set of JSON-RPC error codes this server answers with. Every
 * error response is built from one of these, so the boundary registry can
 * map each to a stable string code with a total table and no fallback.
 */
export type JsonRpcErrorCode =
  | typeof PARSE_ERROR
  | typeof INVALID_REQUEST
  | typeof METHOD_NOT_FOUND
  | typeof INVALID_PARAMS
  | typeof INTERNAL_ERROR;

/**
 * A frame the server writes without having been asked for it, addressed
 * to no request id.
 *
 * It lives beside the constants rather than next to `JsonRpcResponse` in
 * `server.ts` because the transports need the shape and the server needs
 * it too: putting it in this leaf keeps the dependency direction
 * downward and leaves `progress.ts` able to build a frame without
 * importing the dispatcher that will send it.
 */
export interface JsonRpcNotification {
  readonly jsonrpc: string;
  readonly method: string;
  readonly params?: unknown;
}

export class MCPError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "MCPError";
    this.code = code;
    this.data = data;
  }
}
