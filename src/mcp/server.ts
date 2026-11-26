/**
 * MCP server: JSON-RPC 2.0 dispatcher exposing the five Open Second Brain
 * tools over the `2025-06-18` MCP protocol. Mirrors the Python `MCPServer`
 * class, including handshake instructions and error semantics.
 */

import {
  ConfigReadError,
  discoverConfig,
  resolveAgentName,
  resolveMcpRouteMetricsEnabled,
} from "../core/config.ts";
import {
  dreamDayCheck,
  dreamDayRecordStamp,
  dreamOwnerCheckForgotten,
} from "../core/brain/dream-trigger/check.ts";
import type { ConfigDiscovery } from "../core/types.ts";
import { emitMcpRouteLatency, type McpRouteStatus } from "../core/brain/mcp-route-metrics.ts";
import { createRouteScope } from "../core/route-scope.ts";
import { assertKnownArguments } from "./argument-guard.ts";
import { VaultFrozenError } from "../core/brain/freeze-marker.ts";
import {
  MigrationInProgressError,
  type MigrationRefusalRecorder,
  recordMigrationRefusals,
} from "../core/migration-gate.ts";
import {
  migrationInProgressRefusal,
  UNRESOLVED_AGENT,
  vaultFrozenRefusal,
} from "./frozen-refusal.ts";
import { StaleServerGuard } from "./stale-server.ts";
import { assertNoCallerSuppliedReach } from "./reach-refusal.ts";
import { withPrivateWithheld } from "../core/store/caller-reach.ts";
import { configuredVaultMissing, servedVault, type ServedVault } from "../core/store/store-only.ts";
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
import type { JsonRpcErrorCode, JsonRpcNotification, MCPErrorData } from "./protocol.ts";
import {
  codeForError,
  errorDetailFor,
  isToolErrorCode,
  defaultCodeForRpc,
  TOOL_ERROR_META_KEY,
  TOOL_ERROR_CODE,
  toolErrorMeta,
  type ToolErrorCode,
  type ToolErrorDetail,
} from "./tool-error-codes.ts";
import {
  META_MEMBER,
  PROGRESS_META_KEY,
  progressRefusal,
  progressSink,
  readProgressToken,
  withProgressRefusal,
  type ProgressRefusal,
} from "./progress.ts";
import { PROGRESS_REASON, type ProgressSink } from "../core/brain/progress.ts";
import { listResources, listResourceTemplates, readResource } from "./resources.ts";
import { buildToolTable, findTool } from "./tools.ts";
import {
  VAULT_REQUIRED_CODE,
  vaultRequiredToolMessage,
  type RequestIdentity,
  type RuleScopeSources,
  type ServerContext,
  type ToolCapabilityReport,
  type ToolDefinition,
  type ToolScope,
  type VaultMissing,
} from "./tool-contract.ts";
import { noVaultRoot } from "../core/platform-dirs.ts";
import { assertOutputContract } from "./output-contract.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { applyPreviewBudget } from "./preview-budget.ts";
import { evaluateToolCapabilities, type RuntimeCapabilityWindow } from "./capabilities.ts";
import { pathsForCaller } from "./brain/device-path.ts";
import { redactErrorForCaller } from "./error-redaction.ts";
import { resolvedSecretLiterals } from "../core/secret-resolver.ts";
import type { InstallTargetId } from "../core/runtime/host-facts.ts";
import type { HarnessId } from "../core/brain/scoped-rules.ts";
import { resolveHarnessScope } from "../core/brain/scope-identity.ts";
import {
  resolvedTransportReach,
  TRANSPORT_REACH,
  type TransportReach,
} from "../core/graph/transport-reach.ts";

/** TTL after which a prior process's artifact run directory is pruned. */
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export interface MCPServerOptions {
  /** The vault served, or `null` for a server with no vault (design D14). */
  readonly vault: string | null;
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
   * The harness that launched this process, from `o2b mcp --harness` in a
   * packaged registration. Only the scoped standing rules read it, to pick
   * `Brain/standing-rules/harness/<id>.md`; absent falls back to
   * {@link hostTarget}, since every install target is a harness.
   */
  readonly harness?: HarnessId;
  /**
   * The working directory this process was launched in, captured once by
   * the CLI. The scoped standing rules resolve the project from the
   * nearest vault pointer above it; absent means no project.
   */
  readonly workspaceDir?: string;
  /**
   * Run id grouping this process's preview artifacts under
   * `Brain/.artifacts/<run-id>/`. Defaults to a per-process id;
   * injectable so tests get a deterministic directory.
   */
  readonly artifactRunId?: string;
  /**
   * The check that refuses writes once the install or the machine's
   * layout changed under this server (`stale-server.ts`); injectable so
   * tests drive its clock and its look.
   */
  readonly staleGuard?: StaleServerGuard;
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
  /**
   * The reach this transport establishes for every caller it accepts
   * (`src/core/graph/transport-reach.ts`).
   *
   * Absent means no transport minted one - an embedded caller, a probe,
   * a test - and that resolves to {@link TRANSPORT_REACH.remote}, the
   * narrowest. A transport that owns the fact sets it AFTER spreading a
   * caller's options, exactly as `sendNotification` is set, so a runtime
   * option cannot override what the transport established.
   */
  readonly reach?: TransportReach;
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
  readonly error?: JsonRpcErrorBody;
}

/**
 * The per-request identity a transport resolved from a credential
 * (write-side-trust, Task 7). Declared on the tool-contract leaf beside
 * {@link ServerContext.requestIdentity} - the context carries it and
 * every writer tool reads it there - and re-exported here so the
 * transport-facing spelling does not move.
 */
export type { RequestIdentity };

/**
 * The `error` member of a JSON-RPC answer. `data` is always present and
 * always carries the string code, because {@link errorResponse} is the
 * one builder and adds it when the thrower did not.
 */
export interface JsonRpcErrorBody {
  readonly code: JsonRpcErrorCode;
  readonly message: string;
  readonly data: JsonRpcErrorData;
}

/** `error.data`: the thrower's record plus the stable string code. */
export type JsonRpcErrorData = MCPErrorData & { readonly code: string };

/** The refusal a vault-adapter tool gives on a server with no vault. */
function vaultRequired(tool: string | undefined): MCPError {
  return new MCPError(INVALID_PARAMS, vaultRequiredToolMessage(tool), {
    code: VAULT_REQUIRED_CODE,
  });
}

/**
 * The refusal a tool that needs the vault gives on a switched machine whose
 * vault cannot be read or is gone: the `vault_required` shape, with the
 * `vault_unreadable` code and the reason.
 */
function vaultUnreachable(tool: string | undefined, reason: Error): MCPError {
  const subject = tool === undefined ? "this request" : `\`${tool}\``;
  return new MCPError(INVALID_PARAMS, `${subject} needs the vault: ${reason.message}`, {
    code: TOOL_ERROR_CODE.vaultUnreadable,
  });
}

export class MCPServer {
  readonly vault: string | null;
  readonly configPath: string | null;
  private readonly staleGuard: StaleServerGuard;
  readonly repoRoot: string | null;
  readonly tools: ReadonlyArray<ToolDefinition>;
  private readonly serverName: string;
  private readonly scope: ToolScope;
  private readonly artifactStore: ArtifactStore;
  private noVaultArtifactStore: ArtifactStore | null = null;
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
  /** See {@link MCPServerRuntimeOptions.reach}; fail-closed when unminted. */
  readonly reach: TransportReach;
  /** Launch-time scope sources for the scoped standing rules. */
  private readonly ruleScope: RuleScopeSources;
  /**
   * The machine config read at construction (`null`: unreadable), kept for
   * the dream day check so the closed-day path reads only its record.
   */
  private machineConfig: ConfigDiscovery | null;
  /**
   * This server's last dream day check: its UTC day and the version of the
   * day record it left (`null`: none yet).
   */
  private dayChecked: { readonly day: string; readonly stamp: number | null } | null = null;

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
    this.machineConfig = loadMachineConfig(this.configPath ?? undefined);
    this.staleGuard =
      runtimeOpts.staleGuard ??
      new StaleServerGuard({
        vault: this.vault,
        ...(this.configPath !== null ? { configPath: this.configPath } : {}),
      });
    this.sendNotification = runtimeOpts.sendNotification;
    this.reach = resolvedTransportReach(runtimeOpts.reach);
    this.ruleScope = Object.freeze({
      workspaceDir: runtimeOpts.workspaceDir ?? null,
      harness: resolveHarnessScope(runtimeOpts.harness, runtimeOpts.hostTarget),
    });
    const runId = runtimeOpts.artifactRunId ?? `run-${process.pid}-${Date.now().toString(36)}`;
    this.artifactStore = new ArtifactStore({
      // A server with no vault keeps its payloads in this machine's
      // device-local state, as a switched machine does: the no-vault
      // stand-in is what `state/machine-state.ts` maps there (a resolved
      // state folder would read as a fresh vault of its own).
      vault: this.vault ?? noVaultRoot(),
      runId,
    });
    // Best-effort housekeeping: clear prior processes' stale artifacts.
    // Never fatal - a missing/unwritable vault just yields zero pruned.
    try {
      this.artifactStore.prune(ARTIFACT_TTL_MS);
    } catch {
      // ignore
    }
  }

  /** This server's vault after the reachability decision, looked at now (`servedVault`). */
  private servedVault(): ServedVault {
    return servedVault(this.vault, this.configPath !== null ? { configPath: this.configPath } : {});
  }

  /**
   * The notice for a configured vault whose folder is not there, on a
   * machine that has not switched (`configuredVaultMissing`), or `null`.
   * Looked at per request, like the reachability decision: the same
   * server answers normally once the folder is back.
   */
  private missingVault(): VaultMissing | null {
    const missing = configuredVaultMissing(
      this.vault,
      this.configPath !== null ? { configPath: this.configPath } : {},
    );
    return missing === null ? null : { vault: missing.vault, notice: missing.notice };
  }

  /**
   * Where a request parks a payload past its preview budget: the vault's
   * store, or with the vault served as none (a switched machine whose
   * vault cannot be reached) the device-local one a server with no vault
   * uses, so a large result never reads the vault to park itself.
   *
   * Only a switched machine's vault is ever served as none, and its
   * machine state is device-local whether or not the vault can be reached
   * (`state/machine-state.ts`): both stores name the same folder there, so
   * a handle issued on either side of a change in the vault's reach
   * resolves for the whole run.
   */
  private artifactStoreFor(served: string | null): ArtifactStore {
    if (served !== null || this.vault === null) return this.artifactStore;
    this.noVaultArtifactStore ??= new ArtifactStore({
      vault: noVaultRoot(),
      runId: this.artifactStore.runId,
    });
    return this.noVaultArtifactStore;
  }

  get context(): ServerContext {
    return this.contextFor();
  }

  /**
   * The server context for ONE request. `identity` is what the transport
   * resolved from the request's credential; when it is absent (stdio,
   * the CLI bridge, a probe) the context falls back to the process
   * config identity exactly as the plain getter always did - including
   * deferring `resolveAgentName`'s refusal to the point of use. The
   * identity rides the context as `requestIdentity`, so a writer tool
   * can answer for the credential's agent rather than the config's.
   */
  private contextFor(identity?: RequestIdentity, toolName?: string): ServerContext {
    const configPath = this.configPath ?? undefined;
    // A switched machine whose vault folder cannot be read or is gone holds
    // its brain in the store: the request is served as on a server with no
    // vault, and a tool that needs the vault refuses with the reason
    // (`vault_unreadable`). Looked at per request, so the same server
    // answers normally once the vault is back.
    const { vault: served, unreachable } = this.servedVault();
    // A configured vault whose folder is not there, on a machine that has
    // not switched: the brain is not a fresh installation, and every
    // surface that would say "there is nothing here yet" says this
    // instead.
    const missing = this.missingVault();
    return {
      // With no vault, reading `vault` is the uniform refusal (design D14):
      // a vault-adapter tool refuses at its first use, every other tool
      // reads `vaultOrNull` or never asks.
      get vault(): string {
        if (unreachable !== null) throw vaultUnreachable(toolName, unreachable.error);
        if (served === null) throw vaultRequired(toolName);
        return served;
      },
      vaultOrNull: served,
      // The reason the vault is out of reach, for the surfaces that report
      // what they could not read instead of refusing (the operator's rules
      // in `brain_context`).
      ...(unreachable !== null
        ? { vaultUnreachable: { vault: unreachable.vault, reason: unreachable.reason } }
        : {}),
      ...(missing !== null ? { vaultMissing: missing } : {}),
      configPath: this.configPath,
      repoRoot: this.repoRoot,
      capabilityReport: this.capabilityReport,
      artifactStore: this.artifactStoreFor(served),
      reach: this.reach,
      ruleScope: this.ruleScope,
      // Present only when a transport minted one: the two nulls (no
      // credential, no identity) stay spelled as absence, and a
      // hand-built context keeps its validity.
      ...(identity !== undefined ? { requestIdentity: identity } : {}),
      // Owner-scope isolation (context-integrity-gates, Unit A): the
      // only source of identity for `brain_context`, which takes no
      // arguments. A transport-minted credential wins; otherwise the
      // config is resolved per access, like `resolveAgentName`'s other
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
        return identity?.agent ?? resolveAgentName(configPath);
      },
    };
  }

  /** Public method for CLI tool-call bridge — the legacy code reached into `_tools`. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = findTool(this.tools, name);
    // The same scope `tools/call` runs in: below local reach the readers
    // answer without what only the `private` partition knows.
    return withPrivateWithheld(this.reach !== TRANSPORT_REACH.local, async () =>
      toolResult(
        tool,
        this.forCaller(await this.invokeToolHandler(tool, args, undefined, undefined)),
      ),
    );
  }

  /**
   * Whether this request must run behind the stdio transport's write
   * gate rather than on the concurrent read path.
   *
   * Everything that is not a `tools/call` is a read. A `tools/call` is a
   * write when its tool's `kind` is `write` - and every failure to KNOW
   * is a write too, because the gate only ever costs serialization while
   * guessing "read" could run a mutator beside another dispatch: a
   * malformed `params`, an unknown tool name (refused shortly, but never
   * parallelized), and a definition that carries no `kind` (a hand-built
   * one that cast the field away) all take the gate. No argument is ever
   * inspected: classification is per tool, never per call. This consults
   * the registry only - it performs none of the work `handleRequest`
   * will redo, and transport code may call it before dispatching.
   */
  classifiesWrite(request: JsonRpcRequest): boolean {
    if (request.method !== "tools/call") return false;
    const name = (request.params as { readonly name?: unknown } | null | undefined)?.["name"];
    if (typeof name !== "string") return true;
    try {
      return findTool(this.tools, name).kind !== "read";
    } catch {
      return true;
    }
  }

  /**
   * A tool result, resource body or refusal as this server's caller may
   * see it: below local reach no string names a host path
   * (`brain/device-path.ts` `pathsForCaller`).
   */
  private forCaller(result: unknown): unknown {
    return pathsForCaller(result, this.vault, this.reach, this.configPath ?? undefined);
  }

  /**
   * Single seam through which every tool handler runs, for both the CLI
   * bridge (`callTool`) and the JSON-RPC `tools/call` path. With route
   * metrics off it is a transparent pass-through; with them on it times
   * the handler and emits one payload-safe `mcp_route_latency` record
   * (status `error` on throw), then re-raises so error handling upstream
   * is unchanged. One route scope per call carries the decision time and
   * the write stages the handler notes; neither ever reaches the response.
   * The emit is gated and fail-open, so it can never fail or slow-fail the
   * call beyond one synchronous continuity append.
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
    identity?: RequestIdentity,
  ): Promise<unknown> {
    // The first call of a new UTC day checks whether a dream pass is due
    // (change `dream-session-trigger`): a long-lived server, and one whose
    // host never sent `initialize`, still starts the day's pass, and a
    // call after a verb on this machine took the dream owner role looks
    // again. A date comparison and one `stat` of the day record on every
    // other call; a tool call shows no note.
    this.checkDreamDay(false);
    // Before the unknown-argument gate: a caller naming the visibility
    // boundary is told about the boundary, not offered a typo suggestion
    // for it - and the rule holds for an open schema, which that gate
    // cannot see.
    assertNoCallerSuppliedReach(tool, args);
    assertKnownArguments(tool, args);
    // A server older than the install, or than the machine's layout,
    // writes nothing (`stale-server.ts`): it would write what its old code
    // knows, the legacy tree on a switched machine included.
    if (tool.kind !== "read") this.staleGuard.assertMayWrite(tool.name);
    // A refusal of the migration gate is recorded wherever it is met, so a
    // handler that wraps it in an error of its own still answers with the
    // structured refusal (`mapFrozen`).
    const gate: MigrationRefusalRecorder = { refused: null };
    if (!this.routeMetricsEnabled) {
      try {
        return await recordMigrationRefusals(gate, async () =>
          tool.handler(this.contextFor(identity, tool.name), args, onProgress),
        );
      } catch (exc) {
        throw this.mapFrozen(tool, exc, identity, gate.refused);
      }
    }
    const start = performance.now();
    let status: McpRouteStatus = "ok";
    const routeScope = createRouteScope();
    try {
      return await recordMigrationRefusals(gate, async () =>
        routeScope.run(async () =>
          tool.handler(this.contextFor(identity, tool.name), args, onProgress),
        ),
      );
    } catch (exc) {
      status = "error";
      throw this.mapFrozen(tool, exc, identity, gate.refused);
    } finally {
      // The route metric is a vault continuity record: none without a vault.
      if (this.vault !== null) {
        emitMcpRouteLatency(
          this.vault,
          {
            tool: tool.name,
            scope: this.scope,
            status,
            durationMs: performance.now() - start,
            argKeys: Object.keys(args),
            ...(routeScope.decisionMs() !== undefined
              ? { decisionMs: routeScope.decisionMs() }
              : {}),
            ...(routeScope.stages() !== undefined ? { stages: routeScope.stages() } : {}),
          },
          this.routeMetricsEnabled,
        );
      }
    }
  }

  /**
   * Map a frozen-vault refusal onto the structured error a caller can
   * act on, recording one `write-refused` event on the way through.
   *
   * Here rather than in each write tool because the freeze is enforced
   * at the vault guard, so ANY handler can raise it - including the
   * internal writers a tool composes - and a per-tool `catch` would
   * cover the ones somebody remembered. Every other exception passes
   * through untouched.
   */
  private mapFrozen(
    tool: ToolDefinition,
    exc: unknown,
    identity?: RequestIdentity,
    gateRefusal: MigrationInProgressError | null = null,
  ): unknown {
    // A store migration running on this machine refuses like a freeze,
    // also when the handler reported the refusal as an error of its own.
    if (exc instanceof MigrationInProgressError) return migrationInProgressRefusal(tool.name, exc);
    if (gateRefusal !== null && !(exc instanceof VaultFrozenError)) {
      return migrationInProgressRefusal(tool.name, gateRefusal);
    }
    if (!(exc instanceof VaultFrozenError) || this.vault === null) return exc;
    // `agentName` is optional on the context - a transport may supply
    // none - so an absent identity is recorded as the named absence
    // rather than as a plausible-looking name nobody claimed.
    return vaultFrozenRefusal(
      this.vault,
      tool.name,
      exc,
      () => this.contextFor(identity).agentName ?? UNRESOLVED_AGENT,
    );
  }

  /** Process one JSON-RPC request or notification. Returns null for notifications. */
  async handleRequest(
    request: JsonRpcRequest,
    identity?: RequestIdentity,
  ): Promise<JsonRpcResponse | null> {
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
        // Below local reach every reader answers without what only the
        // `private` partition knows, down to the folds' derived counters.
        result = await withPrivateWithheld(this.reach !== TRANSPORT_REACH.local, () =>
          this.handleToolsCall(params, identity),
        );
      } else if (method === "resources/list") {
        result = this.handleResourcesList();
      } else if (method === "resources/templates/list") {
        result = this.handleResourcesTemplatesList();
      } else if (method === "resources/read") {
        // A resource body is prose the brain rendered; it may name a host path.
        result = this.forCaller(
          await withPrivateWithheld(this.reach !== TRANSPORT_REACH.local, () =>
            this.handleResourcesRead(params, identity),
          ),
        );
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
        // A refusal's prose and data may name a host path too.
        const { message, data } = this.forCaller({ message: exc.message, data: exc.data }) as {
          message: string;
          data: typeof exc.data;
        };
        return errorResponse(requestId, exc.code, message, data);
      }
      // A channel that forwards raw exception prose to the caller. Node's
      // fs errors embed the absolute path of whatever the caller's last
      // bad argument named, so before this leaves the process it goes
      // through the redactor - at remote reach with the vault, home and
      // temp roots replaced too: a caller probing with traversal paths
      // learns that a file is missing, not the host layout behind it.
      return internalErrorResponse(requestId, exc, this.vault, this.reach);
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
    // The dream day check at the session's start (change
    // `dream-session-trigger`): hosts with no session start hook reach the
    // product here. Its note names device and agent names, so it is shown
    // at local reach only.
    const dayNote = this.checkDreamDay(this.reach === TRANSPORT_REACH.local);
    const instructions = buildInstructions({
      agent: identity,
      vault: this.vault,
      configPath: this.configPath,
      scope: this.scope,
      // Computed in the constructor and held on the instance, so the
      // handshake states what this runtime actually left callable
      // without evaluating the window a second time.
      capabilities: this.capabilityReport,
    });
    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: { name: this.serverName, version: SERVER_VERSION },
      instructions: dayNote === null ? instructions : `${instructions}\n\n${dayNote}`,
    };
  }

  /**
   * Run the dream day check once per UTC day of this server: at
   * `initialize` and at the first tool call of a new day. Returns the
   * note to show when `notes` and one is due. Never throws.
   */
  private checkDreamDay(notes: boolean): string | null {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dayChecked?.day === today) {
      // Checked today. Only a record written since (one `stat`) whose
      // owner check a verb on this machine cleared (taking the role,
      // setting `dream.auto`) is looked at again today.
      const stamp = dreamDayRecordStamp(this.machineConfig);
      if (stamp === this.dayChecked.stamp) return null;
      if (!dreamOwnerCheckForgotten(this.machineConfig, today)) {
        this.dayChecked = { day: today, stamp };
        return null;
      }
    }
    // A config that could not be read at the start is read again at the
    // next check, so a repaired one is found without a restart.
    if (this.machineConfig === null) {
      this.machineConfig = loadMachineConfig(this.configPath ?? undefined);
    }
    // A server the stale guard refuses must not start a dream pass: the
    // check starts a detached worker that writes the brain, and a server
    // older than the install writes it with the code it started with. The
    // guard is asked first, so the refusal is seen before any worker is
    // started - for a read call as much as for a write.
    if (this.staleGuard.reason() !== null) return null;
    // The vault this server serves, which may not be the configured one.
    const note = dreamDayCheck(this.machineConfig, { notes, vault: this.servedVault().vault }).note;
    this.dayChecked = { day: today, stamp: dreamDayRecordStamp(this.machineConfig) };
    return notes && note !== undefined ? note : null;
  }

  private handleToolsList(): Record<string, unknown> {
    // Hidden tools (the second pass of the `catalog` profile) stay
    // callable but are not advertised - the list is what every client
    // pays tokens for.
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

  private handleResourcesRead(
    params: Record<string, unknown>,
    identity?: RequestIdentity,
  ): Record<string, unknown> {
    const uri = params["uri"];
    if (typeof uri !== "string") {
      throw new MCPError(INVALID_PARAMS, "resources/read requires a string `uri`");
    }
    // TODO(task 2.10 WP2a): resources served from the folds need no vault.
    if (this.vault === null) throw vaultRequired(undefined);
    const content = readResource(
      {
        vault: this.vault,
        agentName: this.contextFor(identity).agentName,
        reach: this.reach,
        configPath: this.configPath,
      },
      uri,
    );
    return { contents: [content] };
  }

  private async handleToolsCall(
    params: Record<string, unknown>,
    identity?: RequestIdentity,
  ): Promise<Record<string, unknown>> {
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
    // out - on an isError result and on a JSON-RPC error too, because a
    // call that asked for progress and then failed still never got any.
    const refusal: ProgressRefusal | undefined =
      token !== undefined && onProgress === undefined
        ? progressRefusal(token, PROGRESS_REASON.transportSingleResponse)
        : undefined;
    try {
      const structured = this.forCaller(
        await this.invokeToolHandler(tool, args, onProgress, identity),
      );
      return withProgressRefusal(
        buildMcpToolResult(
          tool,
          structured,
          this.artifactStoreFor(this.servedVault().vault),
          (text) => this.forCaller(text) as string,
        ),
        refusal,
      );
    } catch (exc) {
      // A machine whose configured vault folder is not there is not a
      // fresh installation: every refusal it answers names the missing
      // folder FIRST, so the advice to initialise a new brain (which the
      // refusal keeps) is never the first thing the caller reads.
      const missing = this.missingVault();
      const prefix = missing === null ? "" : `${missing.notice} `;
      if (exc instanceof MCPError) {
        const message = prefix.length === 0 ? exc.message : `${prefix}${exc.message}`;
        if (refusal === undefined) throw new MCPError(exc.code, message, exc.data);
        throw new MCPError(exc.code, message, { ...exc.data, [PROGRESS_META_KEY]: refusal });
      }
      // The tool-level twin of the INTERNAL_ERROR channel: the same raw
      // exception prose, so the same host-path redaction at remote reach.
      // A local caller already holds the filesystem, and these messages
      // carry operator remediation (a config path to chmod) verbatim.
      // The missing-vault notice names the configured vault, so it is
      // redacted with the exception prose, never prefixed after it.
      const raw = `${prefix}${(exc as Error).message ?? String(exc)}`;
      const message =
        this.reach === TRANSPORT_REACH.local
          ? raw
          : redactedErrorMessage(raw, this.vault, this.reach);
      // ValueError/TypeError semantics in Python → tool-level error envelope.
      // OSError in Python → "filesystem error" prefix. We collapse both to a
      // single tool-level error since JS doesn't distinguish.
      return withProgressRefusal(
        toolError(message, codeForError(exc), errorDetailFor(exc)),
        refusal,
      );
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
/** The machine config at `configPath`, or `null` when it cannot be read. */
function loadMachineConfig(configPath: string | undefined): ConfigDiscovery | null {
  try {
    return discoverConfig(configPath);
  } catch {
    return null;
  }
}

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
  /** The caller's path redaction, for text this builder adds after it ran. */
  forCaller: (text: string) => string = (text) => text,
): Record<string, unknown> {
  assertOutputContract(tool.name, tool.outputSchema, structured);
  const serialized = JSON.stringify(structured, sortedReplacer, 2);
  const outcome = applyPreviewBudget(serialized, tool.previewBudget, store, forCaller);
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: structured,
    isError: false,
  };
}

/**
 * An `isError` tool result. The text is the message alone, as it always
 * was; the stable code rides on `_meta` because strict clients validate
 * `structuredContent` against the tool's output schema even on an error.
 */
function toolError(
  message: string,
  code: ToolErrorCode,
  detail?: ToolErrorDetail,
): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    [META_MEMBER]: { [TOOL_ERROR_META_KEY]: toolErrorMeta(code, detail) },
  };
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/** The member of `error.data` every JSON-RPC error answer carries. */
const ERROR_DATA_CODE_KEY = "code";

/** The stderr line a thrower-supplied code outside the registry is named on. */
const UNREGISTERED_CODE_WARNING = "warning: unregistered error code on the wire: ";

/** The longest quoted code that warning line repeats. */
const UNREGISTERED_CODE_LOG_MAX = 120;

/**
 * `data` with its stable string code. A thrower-supplied string code
 * always wins; otherwise the default derived from the numeric JSON-RPC
 * code is added after the thrower's own members, so a record such as the
 * argument guard's keeps its shape and gains one key.
 *
 * A supplied code outside {@link isToolErrorCode} is still sent as it
 * is - replacing it would hide which producer chose it - and is named on
 * stderr. Every producer passes a constant token, never prose, but the
 * line exists to catch one that breaks that rule, so the code is written
 * JSON-quoted and capped: a newline in it cannot forge a second line.
 */
function withDefaultCode(code: JsonRpcErrorCode, data: MCPErrorData | undefined): JsonRpcErrorData {
  const supplied: unknown = (data as { readonly [ERROR_DATA_CODE_KEY]?: unknown } | undefined)?.[
    ERROR_DATA_CODE_KEY
  ];
  if (data !== undefined && typeof supplied === "string") {
    if (!isToolErrorCode(supplied)) {
      const quoted = JSON.stringify(supplied).slice(0, UNREGISTERED_CODE_LOG_MAX);
      process.stderr.write(`${UNREGISTERED_CODE_WARNING}${quoted}\n`);
    }
    return data as JsonRpcErrorData;
  }
  return { ...data, [ERROR_DATA_CODE_KEY]: defaultCodeForRpc(code) };
}

/**
 * The one builder every JSON-RPC error answer passes through, including
 * the transport errors of `stdio.ts` and `http.ts`, so "every error
 * response carries `error.data.code`" holds by construction.
 */
export function errorResponse(
  requestId: unknown,
  code: JsonRpcErrorCode,
  message: string,
  data?: MCPErrorData,
): JsonRpcResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: requestId ?? null,
    error: { code, message, data: withDefaultCode(code, data) },
  };
}

/**
 * The prefix of the INTERNAL_ERROR answer {@link internalErrorResponse}
 * builds for an unmapped throw. Handlers that throw their own
 * INTERNAL_ERROR keep their own message; `error.data.code` is the stable
 * signal, not this prefix.
 */
const INTERNAL_ERROR_PREFIX = "internal error: ";

/**
 * The INTERNAL_ERROR answer for a throw no handler mapped: the raw prose
 * through the redactor for the bind's reach, the code from the
 * classifier, which names an unknown class on stderr. One builder for the
 * dispatcher and the HTTP catch-all, so the two channels cannot drift.
 */
export function internalErrorResponse(
  requestId: unknown,
  exc: unknown,
  vault: string | null,
  reach: TransportReach,
): JsonRpcResponse {
  const raw = (exc as Error).message ?? String(exc);
  const message = redactedErrorMessage(raw, vault, reach);
  const detail = errorDetailFor(exc);
  return errorResponse(requestId, INTERNAL_ERROR, `${INTERNAL_ERROR_PREFIX}${message}`, {
    code: codeForError(exc),
    ...(detail === undefined ? {} : { reason: detail.reason, remedy: detail.remedy }),
  });
}

/**
 * Error prose for a caller, with the vault's KNOWN credential values
 * scrubbed. The fourth composition this redaction gained: the shapes-only
 * passes cannot see a resolved credential under a quiet key name, and an
 * exception is exactly where one travels (a fetch failure echoing the URL
 * it was handed, a refusal naming the field it rejected). The values come
 * from {@link resolvedSecretLiterals}, which contributes NOTHING when the
 * store is absent, empty, unreadable or locked - so a boundary that
 * cannot know the values answers byte-identically to the pre-literal
 * redactor instead of pretending to redact.
 */
function redactedErrorMessage(raw: string, vault: string | null, reach: TransportReach): string {
  // With no vault there is no vault path to hide and no custody store to
  // read literals from; the home and temp roots are still redacted.
  if (vault === null) return redactErrorForCaller(raw, "", reach, []);
  return redactErrorForCaller(raw, vault, reach, resolvedSecretLiterals(vault));
}

// Re-exports so callers that previously imported these names from
// `open_second_brain.mcp` keep working.
export { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, JSONRPC_VERSION };
