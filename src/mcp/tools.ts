/**
 * MCP tool registry. As of v0.10.8 the advertised surface is composed
 * from four sibling slices:
 *
 *   - Core read/health tools (`second_brain_status`,
 *     `second_brain_query`, `vault_health`) — defined inline in this
 *     file because they only need `ServerContext` and the shared
 *     coercion helpers.
 *   - Brain tools (`brain_feedback`, `brain_apply_evidence`,
 *     `brain_note`, `brain_dream`, `brain_digest`, `brain_query`,
 *     `brain_doctor`, `brain_backlinks`) — `./brain-tools.ts`
 *     (`BRAIN_TOOLS`).
 *   - Brain Search (`brain_search`) — `./search-tools.ts`
 *     (`SEARCH_TOOLS`).
 *   - Pay Memory tools (`payment_*`, `asset_capture`) —
 *     `./pay-memory-tools.ts` (`PAY_MEMORY_TOOLS`).
 *
 * Each slice owns its own handlers and tool definitions; this file
 * only assembles them in a stable order and applies scope filtering.
 */

import { discoverConfig, redactMapping } from "../core/config.ts";
import { computeBrainStatus } from "../core/brain/status.ts";
import { doctor } from "../core/doctor.ts";
import { isDir } from "../core/fs-utils.ts";
import { resolveVaultScope, walkVaultScope } from "../core/vault-scope/index.ts";
import { BRAIN_TOOLS } from "./brain-tools.ts";
import { SEARCH_TOOLS, buildSearchStatusBlock } from "./search-tools.ts";
import { PAY_MEMORY_TOOLS } from "./pay-memory-tools.ts";
import { normalizeAgentArgument, PLACEHOLDER_AGENT_VALUES } from "../core/agent-identity.ts";
import { vaultRelative } from "../core/path-safety.ts";
import { listVaultPages } from "../core/vault.ts";
import { INVALID_PARAMS, METHOD_NOT_FOUND, MCPError } from "./protocol.ts";
import { coerceStr, coerceInt } from "./coerce.ts";
import type { OutputSchema } from "./output-contract.ts";
import type { ArtifactStore } from "./artifact-store.ts";

export interface ServerContext {
  readonly vault: string;
  readonly configPath: string | null;
  readonly repoRoot: string | null;
  /**
   * Per-process preview-artifact store (v0.18.0). Present on the live MCP
   * server context; `brain_artifact_get` reads parked tool-result payloads
   * back through it. Optional so manually-built contexts stay valid.
   */
  readonly artifactStore?: ArtifactStore;
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
  readonly handler: (
    ctx: ServerContext,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
}

// PLACEHOLDER_AGENT_VALUES + normalizeAgentArgument live in
// `src/core/agent-identity.ts` so the OpenClaw native plugin can import
// the same constants without reaching across to the MCP module. Re-exported
// at the bottom of this file for callers that previously imported them
// from here.

/**
 * Wrapper that swallows path-escape errors and returns the raw input —
 * used in tool *output* paths where we'd rather hand back the unsafe
 * string than throw mid-render. Keep this as a separate verb so callers
 * deliberately opt into the lenient behaviour.
 */
function vaultRelpath(target: string, vault: string): string {
  try {
    return vaultRelative(target, vault);
  } catch {
    return target;
  }
}

// ── Tool implementations ────────────────────────────────────────────────────

async function toolStatus(ctx: ServerContext): Promise<Record<string, unknown>> {
  const discovery = discoverConfig(ctx.configPath ?? undefined);
  const vaultExists = isDir(ctx.vault);
  const configKeys = Object.keys(discovery.data).toSorted();
  // Safe to call on a vault that has no Brain layer yet — returns
  // `present: false` with zero counts.
  const brain = vaultExists ? computeBrainStatus(ctx.vault) : null;
  const searchDisabled = discovery.data["search_enabled"] === "false";
  const search = vaultExists && !searchDisabled ? await buildSearchStatusBlock(ctx) : null;
  // v0.10.9 — `vault` block exposes the shared exclusion policy plus
  // aggregate include/exclude counts. Per-path detail lives in the CLI
  // (`o2b vault status`); MCP payloads stay small.
  //
  // `resolveVaultScope` fails closed when `_brain.yaml` is malformed
  // (design §5) — the right call for walkers that would otherwise
  // silently drop the operator's policy. But this MCP tool is a
  // read-only diagnostic, and the operator wants the brain / search /
  // config blocks visible even when the vault scope cannot be
  // resolved. Catch and degrade to `{ error: "..." }` instead of
  // taking the whole `second_brain_status` payload down with it.
  let vault: Record<string, unknown> | null = null;
  if (vaultExists) {
    try {
      const scope = resolveVaultScope(ctx.vault);
      const walk = walkVaultScope(ctx.vault, scope);
      vault = {
        ignore_source: scope.source,
        rules: scope.rules.map((r) => ({ raw: r.raw, kind: r.kind })),
        included: { files: walk.includedFiles, dirs: walk.includedDirs },
        excluded: {
          dirs: walk.excludedDirs.length,
          files: walk.excludedFiles.length,
        },
      };
    } catch (err) {
      vault = { error: (err as Error)?.message ?? String(err) };
    }
  }
  return {
    config_path: String(discovery.path),
    config_exists: discovery.exists,
    config_keys: configKeys,
    config: redactMapping(discovery.data),
    vault_path: ctx.vault,
    vault_exists: vaultExists,
    ...(vault ? { vault } : {}),
    ...(brain ? { brain } : {}),
    ...(search ? { search } : {}),
  };
}

async function toolQuery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isDir(ctx.vault)) {
    throw new MCPError(INVALID_PARAMS, `vault directory missing: ${ctx.vault}`);
  }
  const pattern = coerceStr(args, "pattern", false);
  const limit = coerceInt(args, "limit", 50, 1, 500);

  const pages = listVaultPages(ctx.vault);
  const needle = pattern ? pattern.toLowerCase() : null;
  const matched: Array<Record<string, unknown>> = [];
  for (const p of pages) {
    if (needle !== null && !p.title.toLowerCase().includes(needle)) continue;
    matched.push({
      title: p.title,
      path: vaultRelpath(p.path, ctx.vault),
      metadata: p.metadata,
    });
    if (matched.length >= limit) break;
  }
  return {
    vault_path: ctx.vault,
    total_pages: pages.length,
    returned: matched.length,
    limit,
    pattern,
    pages: matched,
  };
}

async function toolVaultHealth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const repoArg = coerceStr(args, "repo", false);
  const repoRoot = repoArg ?? ctx.repoRoot;
  const results = doctor({
    vault: ctx.vault,
    config: ctx.configPath,
    repoRoot: repoRoot ?? null,
  });
  const payload = results.map((r) => ({ name: r.name, ok: r.ok, message: r.message }));
  return {
    vault_path: ctx.vault,
    config_path: ctx.configPath ? String(ctx.configPath) : null,
    repo_root: repoRoot ? String(repoRoot) : null,
    ok: payload.every((c) => c.ok),
    checks: payload,
  };
}

async function toolArtifactGet(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const artifactId = coerceStr(args, "artifact_id", true) as string;
  if (!ctx.artifactStore) {
    throw new Error("artifact store unavailable in this context");
  }
  let content: string | null;
  try {
    content = ctx.artifactStore.get(artifactId);
  } catch (err) {
    // Malformed id (path-traversal attempt) → invalid params.
    throw new MCPError(INVALID_PARAMS, (err as Error)?.message ?? String(err));
  }
  if (content === null) {
    // Well-formed but absent / expired → tool-level error envelope.
    throw new Error(`unknown or expired artifact_id: ${artifactId}`);
  }
  return { artifact_id: artifactId, full_chars: content.length, content };
}

const ARTIFACT_GET_OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  required: ["artifact_id", "full_chars", "content"],
  properties: {
    artifact_id: { type: "string" },
    full_chars: { type: "integer" },
    content: { type: "string" },
  },
};

export type ToolScope = "full" | "writer";

// The set is named after the original payload (mutating writers). As
// of v0.10.10 it also hosts `brain_context`, a *reader* tool that has
// to be always-loaded to be useful at session start. Renaming the
// MCP server itself is deferred — see
// `docs/plans/2026-05-20-v0.10.10-design.md` §12.
const WRITER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "brain_apply_evidence",
  "brain_context",
  "brain_feedback",
  "brain_note",
  "brain_pinned_context",
]);

export function buildToolTable(scope: ToolScope = "full"): ToolDefinition[] {
  const all: ToolDefinition[] = [
    {
      name: "second_brain_status",
      description: "Report Open Second Brain configuration and vault status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: toolStatus,
    },
    {
      name: "second_brain_query",
      description: "List vault pages with optional title substring filter.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Optional case-insensitive substring matched against page titles.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum number of matched pages to return (default 50).",
          },
        },
        additionalProperties: false,
      },
      handler: toolQuery,
    },
    // `second_brain_capture` and `event_log_append` were retired from
    // the MCP surface in §32 (v0.10.8); Brain tools replace agent-side
    // writes.
    ...BRAIN_TOOLS,
    ...SEARCH_TOOLS,
    {
      name: "vault_health",
      description: "Run vault, config, and plugin manifest health checks.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Optional repository root to validate plugin manifests.",
          },
        },
        additionalProperties: false,
      },
      handler: toolVaultHealth,
    },
    {
      name: "brain_artifact_get",
      description:
        "Fetch the full payload of a previously preview-truncated tool result by its artifact_id. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          artifact_id: {
            type: "string",
            description: "The artifact_id returned in a preview-truncated tool result envelope.",
          },
        },
        required: ["artifact_id"],
        additionalProperties: false,
      },
      outputSchema: ARTIFACT_GET_OUTPUT_SCHEMA,
      handler: toolArtifactGet,
    },
    ...PAY_MEMORY_TOOLS,
  ];
  if (scope === "full") return all;
  return all.filter((t) => WRITER_TOOL_NAMES.has(t.name));
}

export function findTool(tools: ReadonlyArray<ToolDefinition>, name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new MCPError(METHOD_NOT_FOUND, `unknown tool: ${name}`);
  return tool;
}

// Re-export for callers that previously imported these from here. The
// canonical home is `src/core/agent-identity.ts`; new code should import
// from there.
export { PLACEHOLDER_AGENT_VALUES, normalizeAgentArgument };
