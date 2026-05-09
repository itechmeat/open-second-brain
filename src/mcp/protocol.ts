/**
 * MCP / JSON-RPC 2.0 protocol constants and shared error type.
 *
 * Mirrors the constants exposed by the legacy Python `open_second_brain.mcp`
 * module so cross-runtime tooling (clients, integration tests) can re-use the
 * same JSON-RPC error codes.
 */

import packageJson from "../../package.json" with { type: "json" };

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "open-second-brain";
export const JSONRPC_VERSION = "2.0";
export const SERVER_VERSION: string = packageJson.version;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

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
