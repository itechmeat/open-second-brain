/**
 * MCP server: JSON-RPC 2.0 dispatcher exposing the five Open Second Brain
 * tools over the `2025-06-18` MCP protocol. Mirrors the Python `MCPServer`
 * class, including handshake instructions and error semantics.
 */

import { resolveAgentName } from "../core/config.ts";
import { buildInstructions } from "./instructions.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JSONRPC_VERSION,
  MCPError,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
} from "./protocol.ts";
import { buildToolTable, findTool, type ServerContext, type ToolDefinition } from "./tools.ts";

export interface MCPServerOptions {
  readonly vault: string;
  readonly configPath?: string | null;
  readonly repoRoot?: string | null;
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export class MCPServer {
  readonly vault: string;
  readonly configPath: string | null;
  readonly repoRoot: string | null;
  readonly tools: ReadonlyArray<ToolDefinition>;

  constructor(opts: MCPServerOptions) {
    this.vault = opts.vault;
    this.configPath = opts.configPath ?? null;
    this.repoRoot = opts.repoRoot ?? null;
    this.tools = buildToolTable();
  }

  get context(): ServerContext {
    return { vault: this.vault, configPath: this.configPath, repoRoot: this.repoRoot };
  }

  /** Public method for CLI tool-call bridge — the legacy code reached into `_tools`. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = findTool(this.tools, name);
    return toolResult(await tool.handler(this.context, args));
  }

  /** Process one JSON-RPC request or notification. Returns null for notifications. */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (typeof request !== "object" || request === null) {
      return errorResponse(null, INVALID_REQUEST, "request must be an object");
    }
    if (request.jsonrpc !== JSONRPC_VERSION) {
      return errorResponse(request.id ?? null, INVALID_REQUEST, "unsupported jsonrpc version");
    }
    const method = request.method;
    if (typeof method !== "string") {
      return errorResponse(request.id ?? null, INVALID_REQUEST, "method must be a string");
    }
    const paramsRaw = request.params ?? {};
    if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw)) {
      return errorResponse(request.id ?? null, INVALID_PARAMS, "params must be an object");
    }
    const params = paramsRaw as Record<string, unknown>;
    // JSON-RPC 2.0 §4.1: `id` MUST be a string, number, or null. Anything
    // else (objects, symbols, arrays) is a protocol violation — respond
    // with INVALID_REQUEST and id: null so a non-compliant client sees a
    // well-formed error frame instead of getting our object back as `id`.
    const isNotification = !("id" in request);
    if (!isNotification) {
      const idType = typeof request.id;
      if (
        idType !== "string" &&
        idType !== "number" &&
        request.id !== null
      ) {
        return errorResponse(null, INVALID_REQUEST, "id must be string, number, or null");
      }
    }
    const requestId = request.id;

    try {
      let result: unknown;
      if (method === "initialize") {
        result = this.handleInitialize(params);
      } else if (method === "notifications/initialized") {
        // No internal state to flip — protocol parity only.
        return null;
      } else if (method === "ping") {
        result = {};
      } else if (method === "tools/list") {
        result = this.handleToolsList();
      } else if (method === "tools/call") {
        result = await this.handleToolsCall(params);
      } else if (method.startsWith("notifications/")) {
        return null;
      } else {
        throw new MCPError(METHOD_NOT_FOUND, `unknown method: ${method}`);
      }

      if (isNotification) return null;
      return { jsonrpc: JSONRPC_VERSION, id: requestId, result };
    } catch (exc) {
      if (isNotification) return null;
      if (exc instanceof MCPError) {
        return errorResponse(requestId, exc.code, exc.message, exc.data);
      }
      const message = (exc as Error).message ?? String(exc);
      return errorResponse(requestId, INTERNAL_ERROR, `internal error: ${message}`);
    }
  }

  private handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
    const clientVersion = params["protocolVersion"];
    const negotiated = typeof clientVersion === "string" ? clientVersion : PROTOCOL_VERSION;
    const defaultAgent = resolveAgentName(this.configPath ?? undefined);
    return {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: buildInstructions(defaultAgent),
    };
  }

  private handleToolsList(): Record<string, unknown> {
    return {
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  private async handleToolsCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new MCPError(INVALID_PARAMS, "tools/call requires a string name");
    }
    const tool = findTool(this.tools, name);
    const argsRaw = params["arguments"] ?? {};
    if (typeof argsRaw !== "object" || argsRaw === null || Array.isArray(argsRaw)) {
      throw new MCPError(INVALID_PARAMS, "tools/call arguments must be an object");
    }
    const args = argsRaw as Record<string, unknown>;
    try {
      const structured = await tool.handler(this.context, args);
      return toolResult(structured);
    } catch (exc) {
      if (exc instanceof MCPError) throw exc;
      const message = (exc as Error).message ?? String(exc);
      // ValueError/TypeError semantics in Python → tool-level error envelope.
      // OSError in Python → "filesystem error" prefix. We collapse both to a
      // single tool-level error since JS doesn't distinguish.
      return toolError(message);
    }
  }
}

function toolResult(structured: unknown): Record<string, unknown> {
  const text = JSON.stringify(structured, sortedReplacer, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

export function errorResponse(
  requestId: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: requestId ?? null, error };
}

// Re-exports so callers that previously imported these names from
// `open_second_brain.mcp` keep working.
export { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, JSONRPC_VERSION };
