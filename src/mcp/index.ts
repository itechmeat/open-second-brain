/**
 * Public MCP barrel: re-exports the API that callers (CLI, tests, OpenClaw
 * plugin) consume. Keeps the import surface stable across internal restructure.
 */

export {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  JSONRPC_VERSION,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  MCPError,
} from "./protocol.ts";
export { MCPServer, errorResponse, type JsonRpcRequest, type JsonRpcResponse } from "./server.ts";
export { serveStdio, serveStdioFromString } from "./stdio.ts";
export { buildToolTable, PLACEHOLDER_AGENT_VALUES, type ToolDefinition } from "./tools.ts";
export { evaluateToolCapabilities, type RuntimeCapabilityWindow } from "./capabilities.ts";
export { buildInstructions } from "./instructions.ts";
export { slugify } from "../core/vault.ts";
