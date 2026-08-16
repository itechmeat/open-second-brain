/**
 * MCP server: JSON-RPC 2.0 dispatcher exposing the five Open Second Brain
 * tools over the `2025-06-18` MCP protocol. Mirrors the Python `MCPServer`
 * class, including handshake instructions and error semantics.
 */

import {
  ConfigReadError,
  resolveAgentName,
  resolveMcpRouteMetricsEnabled,
} from "../core/config.ts";
import { emitMcpRouteLatency, type McpRouteStatus } from "../core/brain/mcp-route-metrics.ts";
import { assertKnownArguments } from "./argument-guard.ts";
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
import type { JsonRpcNotification } from "./protocol.ts";
import {
  progressRefusal,
  progressSink,
  readProgressToken,
  withProgressRefusal,
  type ProgressRefusal,
} from "./progress.ts";
import { PROGRESS_REASON, type ProgressSink } from "../core/brain/progress.ts";
import { listResources, listResourceTemplates, readResource } from "./resources.ts";
import { buildToolTable, findTool } from "./tools.ts";
import type {
  ServerContext,
  ToolCapabilityReport,
  ToolDefinition,
  ToolScope,
} from "./tool-contract.ts";
import { assertOutputContract } from "./output-contract.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { applyPreviewBudget } from "./preview-budget.ts";
import { evaluateToolCapabilities, type RuntimeCapabilityWindow } from "./capabilities.ts";
import type { InstallTargetId } from "../core/runtime/host-facts.ts";

/** TTL after which a prior process's artifact run directory is pruned. */
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export interface MCPServerOptions {
  readonly vault: string;
  readonly configPath?: string | null;
  readonly repoRoot?: string | null;
}

export interface MCPServerRuntimeOptions {
  readonly serverName?: string;
  readonly scope?: ToolScope;
  readonly capabilityWindow?: RuntimeCapabilityWindow;
  /**
   * The runtime that launched this process, from `o2b mcp
   * --host-target` in a generated registration. Only the capability
   * report reads it, and only to name the host's published tool
   * ceiling; absent means the ceiling is reported as unchecked.
   */
  readonly hostTarget?: InstallTargetId;
  /**
   * Run id grouping this process's preview artifacts under
   * `Brain/.artifacts/<run-id>/`. Defaults to a per-process id;
   * injectable so tests get a deterministic directory.
   */
  readonly artifactRunId?: string;
  /**
   * How this transport writes a frame nobody asked for.
   *
   * Supplied by stdio, which owns a duplex newline-delimited stream and
   * can interleave notifications with responses. NOT supplied by the
   * HTTP transport, which answers one request with one response and
   * closes it - and its absence is what makes a `tools/call` carrying a
   * progress token refuse by name there instead of accepting the token
   * and dropping the events.
   *
   * Synchronous, because the progress sink it feeds is: the long
   * operations that emit are synchronous functions and cannot await a
   * write inside their own loops.
   */
  readonly sendNotification?: (notification: JsonRpcNotification) => void;
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
  private readonly serverName: string;
  private readonly scope: ToolScope;
  private readonly artifactStore: ArtifactStore;
  private readonly capabilityReport: ToolCapabilityReport;
  /**
   * Route-level latency metrics gate (config `mcp_route_metrics_enabled`),
   * resolved once at construction by {@link routeMetricsGate}. Off by
   * default; when on, every tool call is timed and a payload-safe
   * `mcp_route_latency` continuity record is emitted (fail-open).
   */
  private readonly routeMetricsEnabled: boolean;
  /** See {@link MCPServerRuntimeOptions.sendNotification}. */
  private readonly sendNotification: ((notification: JsonRpcNotification) => void) | undefined;

  constructor(opts: MCPServerOptions, runtimeOpts: MCPServerRuntimeOptions = {}) {
    this.vault = opts.vault;
    this.configPath = opts.configPath ?? null;
    this.repoRoot = opts.repoRoot ?? null;
    this.serverName = runtimeOpts.serverName ?? SERVER_NAME;
    this.scope = runtimeOpts.scope ?? "full";
    const evaluated = evaluateToolCapabilities(buildToolTable(this.scope), {
      scope: this.scope,
      serverName: this.serverName,
      window: runtimeOpts.capabilityWindow,
      hostTarget: runtimeOpts.hostTarget,
    });
    this.tools = evaluated.tools;
    this.capabilityReport = evaluated.report;
    this.routeMetricsEnabled = routeMetricsGate(this.configPath ?? undefined);
    this.sendNotification = runtimeOpts.sendNotification;
    const runId = runtimeOpts.artifactRunId ?? `run-${process.pid}-${Date.now().toString(36)}`;
    this.artifactStore = new ArtifactStore({ vault: this.vault, runId });
    // Best-effort housekeeping: clear prior processes' stale artifacts.
    // Never fatal - a missing/unwritable vault just yields zero pruned.
    try {
      this.artifactStore.prune(ARTIFACT_TTL_MS);
    } catch {
      // ignore
    }
  }

  get context(): ServerContext {
    const configPath = this.configPath ?? undefined;
    return {
      vault: this.vault,
      configPath: this.configPath,
      repoRoot: this.repoRoot,
      capabilityReport: this.capabilityReport,
      artifactStore: this.artifactStore,
      // Owner-scope isolation (context-integrity-gates, Unit A): the
      // only source of identity for `brain_context`, which takes no
      // arguments. Resolved per access, like `resolveAgentName`'s other
      // callers, so a config edit takes effect without a restart.
      //
      // A GETTER, not a value, and that is the whole separation this
      // context makes. `resolveAgentName` raises on a config that is
      // present but unreadable, and it is right to: the alternative is a
      // guessed identity, and every write path that takes one records
      // under it. Resolved eagerly here, that refusal ran before EVERY
      // handler, including the two read-only diagnostics whose entire job
      // is to name the file that is broken - so the payload naming it was
      // computed and then discarded by the condition it described.
      // Deferred to the point of use, the refusal reaches exactly the
      // handlers that need an identity (as a tool-level error carrying the
      // file name), and the handlers that never ask answer normally.
      get agentName(): string {
        return resolveAgentName(configPath);
      },
    };
  }

  /** Public method for CLI tool-call bridge — the legacy code reached into `_tools`. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = findTool(this.tools, name);
    return toolResult(tool, await this.invokeToolHandler(tool, args));
  }

  /**
   * Single seam through which every tool handler runs, for both the CLI
   * bridge (`callTool`) and the JSON-RPC `tools/call` path. With route
   * metrics off it is a transparent pass-through; with them on it times
   * the handler and emits one payload-safe `mcp_route_latency` record
   * (status `error` on throw), then re-raises so error handling upstream
   * is unchanged. The emit is gated and fail-open, so it can never fail
   * or slow-fail the call beyond one synchronous continuity append.
   *
   * The unknown-argument gate runs FIRST, before the timer and before the
   * handler, because a refused call is not a route to measure. Placing it
   * here rather than in `handleToolsCall` is what makes it cover the CLI
   * bridge too, while leaving the many tests that call `tool.handler`
   * directly exactly as they were.
   *
   * `onProgress` is the per-request half of the same idea: one seam, so
   * the request-scoped sink reaches every handler without editing any of
   * the registrations. The CLI bridge passes none - a `callTool` has no
   * client and therefore no token.
   */
  private async invokeToolHandler(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    onProgress?: ProgressSink,
  ): Promise<unknown> {
    assertKnownArguments(tool, args);
    if (!this.routeMetricsEnabled) return tool.handler(this.context, args, onProgress);
    const start = performance.now();
    let status: McpRouteStatus = "ok";
    try {
      return await tool.handler(this.context, args, onProgress);
    } catch (exc) {
      status = "error";
      throw exc;
    } finally {
      emitMcpRouteLatency(
        this.vault,
        {
          tool: tool.name,
          scope: this.scope,
          status,
          durationMs: performance.now() - start,
          argKeys: Object.keys(args),
        },
        this.routeMetricsEnabled,
      );
    }
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
      if (idType !== "string" && idType !== "number" && request.id !== null) {
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
      } else if (method === "resources/list") {
        result = this.handleResourcesList();
      } else if (method === "resources/templates/list") {
        result = this.handleResourcesTemplatesList();
      } else if (method === "resources/read") {
        result = this.handleResourcesRead(params);
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
    // The handshake is the third site that read the config before any
    // handler could run, and the one that mattered most: a client whose
    // `initialize` fails never issues a `tools/call` at all, so a refusal
    // here withholds the diagnostics along with everything else. It does
    // not become a guess either - `buildInstructions` renders the reason
    // in place of the identity line, so the agent is told there is no
    // identity to log under rather than handed one.
    const identity = resolveIdentityOrReason(this.configPath ?? undefined);
    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: { name: this.serverName, version: SERVER_VERSION },
      instructions: buildInstructions({
        agent: identity,
        scope: this.scope,
      }),
    };
  }

  private handleToolsList(): Record<string, unknown> {
    // Hidden tools (deprecated aliases) stay callable but are not
    // advertised - the list is what every client pays tokens for.
    return {
      tools: this.tools
        .filter((t) => t.hidden !== true)
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        })),
    };
  }

  private handleResourcesList(): Record<string, unknown> {
    return { resources: listResources() };
  }

  private handleResourcesTemplatesList(): Record<string, unknown> {
    return { resourceTemplates: listResourceTemplates() };
  }

  private handleResourcesRead(params: Record<string, unknown>): Record<string, unknown> {
    const uri = params["uri"];
    if (typeof uri !== "string") {
      throw new MCPError(INVALID_PARAMS, "resources/read requires a string `uri`");
    }
    const content = readResource({ vault: this.vault, agentName: this.context.agentName }, uri);
    return { contents: [content] };
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
    // Read before the handler runs: a malformed token is a request
    // defect, and refusing it after the work has been done would leave
    // the caller unable to tell which half failed.
    const token = readProgressToken(params);
    const onProgress = progressSink(token, this.sendNotification);
    // A token this transport cannot honour is refused by name on the way
    // out - on the error envelope too, because a call that asked for
    // progress and then failed still never got any.
    const refusal: ProgressRefusal | undefined =
      token !== undefined && onProgress === undefined
        ? progressRefusal(token, PROGRESS_REASON.transportSingleResponse)
        : undefined;
    try {
      const structured = await this.invokeToolHandler(tool, args, onProgress);
      return withProgressRefusal(buildMcpToolResult(tool, structured, this.artifactStore), refusal);
    } catch (exc) {
      if (exc instanceof MCPError) throw exc;
      const message = (exc as Error).message ?? String(exc);
      // ValueError/TypeError semantics in Python → tool-level error envelope.
      // OSError in Python → "filesystem error" prefix. We collapse both to a
      // single tool-level error since JS doesn't distinguish.
      return withProgressRefusal(toolError(message), refusal);
    }
  }
}

/**
 * The route-metrics gate for this process, with a config that is present
 * but UNREADABLE folded to the gate's own default rather than raised.
 *
 * This is the only config read on the construction path, so raising here
 * cost the entire process - no `tools/list`, no `tools/call`, and in
 * particular no `vault_health`, the surface whose whole job is to name
 * the file that is broken. It is the same trade `appendLogEvent` makes
 * with `resolveDeviceId` (see `AppendLogEventOptions.deviceId`): a read
 * that sits in front of everything turns one bad file mode into a dead
 * runtime, and the fallback is not a neutral value invented to make a
 * broken install look healthy - it is this gate's documented default-OFF
 * state, it loses only telemetry, and nothing else absorbs the condition.
 * `second_brain_status` and `vault_health` still report the file by name,
 * and every identity-bearing write still refuses on it.
 *
 * Deliberately NOT the same answer as the identity resolvers, because it
 * is not the same class of problem: an unresolvable identity has no
 * neutral value - every candidate is a guess that gets written into the
 * vault under someone's name - while an unresolvable observability toggle
 * has exactly one, and choosing it writes nothing at all.
 *
 * Narrow on purpose: only {@link ConfigReadError} is absorbed, so an
 * unsupported platform or any other failure to locate the config at all
 * is still fatal at construction. `OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED`
 * remains the escape hatch - it is read before the file is opened, so an
 * operator who wants the metrics on can have them on a broken config.
 */
function routeMetricsGate(configPath: string | undefined): boolean {
  try {
    return resolveMcpRouteMetricsEnabled(configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return false;
    throw err;
  }
}

/**
 * The agent identity for the handshake instructions, or the error saying
 * why there is none. Never a substitute name: see
 * {@link MCPServer.context} for why `resolveAgentName`'s refusal is kept
 * rather than defaulted, and `buildInstructions` for what the caller is
 * told in its place.
 */
function resolveIdentityOrReason(configPath: string | undefined): string | ConfigReadError {
  try {
    return resolveAgentName(configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return err;
    throw err;
  }
}

function toolResult(tool: ToolDefinition, structured: unknown): Record<string, unknown> {
  assertOutputContract(tool.name, tool.outputSchema, structured);
  const text = JSON.stringify(structured, sortedReplacer, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: false,
  };
}

/**
 * MCP `tools/call` result builder. Identical to {@link toolResult} for
 * tools with no `previewBudget` or small outputs, but when a budgeted
 * tool's serialized output exceeds the budget it parks the full payload
 * in `store` and swaps `content[0].text` for a bounded preview envelope.
 * `structuredContent` is always the full, contract-validated object, so
 * programmatic consumers and `outputSchema` are untouched. Exported for
 * direct unit testing of the seam.
 */
export function buildMcpToolResult(
  tool: ToolDefinition,
  structured: unknown,
  store: ArtifactStore,
): Record<string, unknown> {
  assertOutputContract(tool.name, tool.outputSchema, structured);
  const serialized = JSON.stringify(structured, sortedReplacer, 2);
  const outcome = applyPreviewBudget(serialized, tool.previewBudget, store);
  return {
    content: [{ type: "text", text: outcome.text }],
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
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
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
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: requestId ?? null, error };
}

// Re-exports so callers that previously imported these names from
// `open_second_brain.mcp` keep working.
export { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, JSONRPC_VERSION };
