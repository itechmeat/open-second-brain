/**
 * Shared MCP tool contract types. Extracted from `./tools.ts` so that
 * leaf tool modules (and `./capabilities.ts`) depend only on this pure
 * leaf for the handler / definition shape, instead of importing back
 * from the `tools.ts` aggregator that assembles them — which formed one
 * large import cycle spanning the whole `src/mcp` tool surface.
 *
 * `ToolScope` and the capability-report shapes live here rather than in
 * `./capabilities.ts` because `ServerContext.capabilityReport` references
 * `ToolCapabilityReport`, and `./capabilities.ts` in turn needs
 * `ToolDefinition`; keeping the report types below both preserves a
 * single downward dependency direction.
 */

import type { OutputSchema } from "./output-contract.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { ProgressSink } from "../core/brain/progress.ts";

/**
 * The tool surfaces a server process can advertise.
 *
 * A closed vocabulary rather than a bare union because the members were
 * hand-copied into four places - the union, the `second_brain_capabilities`
 * output schema, the `--scope` validity check and the `--scope` error
 * message - with nothing asserting the four agreed. Every one of those
 * sites now derives from this object.
 */
export const TOOL_SCOPE = Object.freeze({
  /** Every tool advertised. */
  full: "full",
  /** The always-loaded Brain writer/reader set, and nothing else. */
  writer: "writer",
  /** Two-pass catalog: a compact advertised set, everything still callable. */
  catalog: "catalog",
} as const);

/** Closed union over {@link TOOL_SCOPE}. */
export type ToolScope = (typeof TOOL_SCOPE)[keyof typeof TOOL_SCOPE];

/** Membership list, in widest-surface-first order. */
export const TOOL_SCOPES: ReadonlyArray<ToolScope> = Object.freeze([
  TOOL_SCOPE.full,
  TOOL_SCOPE.writer,
  TOOL_SCOPE.catalog,
]);

/** Narrow a scope name arriving from argv, a config file or a profile. */
export function isToolScope(value: unknown): value is ToolScope {
  return typeof value === "string" && (TOOL_SCOPES as ReadonlyArray<string>).includes(value);
}

export interface ToolCapabilityEntry {
  readonly name: string;
  readonly reason: string;
}

export interface ToolCapabilityReport {
  readonly scope: ToolScope;
  readonly server_name: string;
  readonly static_tool_count: number;
  readonly available_tool_count: number;
  readonly available: ToolCapabilityEntry[];
  readonly withheld: ToolCapabilityEntry[];
}

export interface ServerContext {
  readonly vault: string;
  readonly configPath: string | null;
  readonly repoRoot: string | null;
  readonly capabilityReport?: ToolCapabilityReport;
  /**
   * Per-process preview-artifact store (v0.18.0). Present on the live MCP
   * server context; `brain_artifact_get` reads parked tool-result payloads
   * back through it. Optional so manually-built contexts stay valid.
   */
  readonly artifactStore?: ArtifactStore;
  /**
   * Resolved agent identity for this server process
   * (context-integrity-gates, Unit A), from `resolveAgentName`.
   *
   * It exists because `brain_context` — the documented session-bootstrap
   * surface — takes NO arguments at all (`{properties:{},
   * additionalProperties:false}`), so it has no other way to learn who
   * is asking. It is the fallback scope for the GATED preference-backed
   * surfaces only: those cannot narrow anything unless the operator has
   * set `integrity.owner_scope_delivery` to `fail`. The ungated
   * search-backed surfaces deliberately do NOT fall back to it, because
   * defaulting a scope there would narrow every search in every vault.
   *
   * Optional so a manually-built context stays valid and unscoped.
   */
  readonly agentName?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: OutputSchema;
  /**
   * Optional MCP preview budget in characters (v0.18.0). When set and
   * the serialized result exceeds it, the JSON-RPC `tools/call` path
   * parks the full payload in the artifact store and returns a bounded
   * preview envelope in `content[0].text` instead, leaving
   * `structuredContent` intact. A tool with no budget is never truncated
   * - opt-in only. The CLI bridge ignores the budget entirely.
   */
  readonly previewBudget?: number;
  /**
   * When true the tool stays callable via `tools/call` but is omitted
   * from `tools/list` (token-diet): deprecated aliases keep working
   * for old clients without re-paying their schema in every list.
   */
  readonly hidden?: boolean;
  /**
   * The tool's implementation.
   *
   * The third parameter is per-REQUEST, which is exactly why it is a
   * parameter and not a `ServerContext` field: the context is built once
   * per server (`MCPServer.context`), while a progress token belongs to
   * the single `tools/call` that carried it.
   *
   * It is optional in the type, and TypeScript lets a function of fewer
   * parameters satisfy a type declaring more, so none of the registered
   * tools needed editing to gain it - a handler that cannot report
   * progress simply keeps its two-parameter signature. `undefined` means
   * the client asked for no progress, or the transport could not carry
   * it; in both cases the handler behaves exactly as it did before,
   * because `onProgress` is the same optional-observer idiom the core
   * options interfaces already use.
   */
  readonly handler: (
    ctx: ServerContext,
    args: Record<string, unknown>,
    onProgress?: ProgressSink,
  ) => Promise<unknown> | unknown;
}
