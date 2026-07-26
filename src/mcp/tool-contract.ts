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

export type ToolScope = "full" | "writer" | "catalog";

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
  readonly handler: (
    ctx: ServerContext,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
}
