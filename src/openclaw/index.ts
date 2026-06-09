/**
 * OpenClaw native plugin entry for Open Second Brain.
 *
 * Pure TypeScript that delegates to `src/core/*` so the OpenClaw runtime
 * shares the same source of truth as the CLI and MCP server.
 *
 * Exposes the current tool surface: `second_brain_status`,
 * `second_brain_query`, and `vault_health`.
 * No subprocess creation; passes the OpenClaw security scanner.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync } from "node:fs";

import { discoverConfig, redactMapping, resolveAgentName } from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { buildReminder } from "../core/identity-reminder.ts";
import { listVaultPages } from "../core/vault.ts";
import { normalizeAgentArgument } from "../core/agent-identity.ts";
import { vaultRelative as vaultRelativePath } from "../core/path-safety.ts";

interface PluginConfig {
  vault?: string;
  agentName?: string;
  timezone?: string;
  instanceName?: string;
}

function resolveVaultPath(api: { pluginConfig?: Record<string, unknown> }): string {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  return cfg.vault || process.env["VAULT_DIR"] || ".";
}

export default definePluginEntry({
  register(api): void {
    // Per-turn identity reminder via OpenClaw's `before_prompt_build` hook.
    // The hook fires before every model call and lets us append a short
    // string into the prompt, mirroring `pre_llm_call` in Hermes and
    // `UserPromptSubmit` in Claude Code / Codex. Without this, the agent
    // sees the identity reminder only once at MCP `initialize`, then drifts.
    //
    // We prefer `prependContext` (per-turn, not cached) over
    // `prependSystemContext` (cached system-prompt) because the cached
    // form has the same drift problem we are working around — the LLM
    // stops paying attention to it as the conversation grows.
    api.on("before_prompt_build", () => {
      const cfg = (api.pluginConfig ?? {}) as PluginConfig;
      const agent =
        normalizeAgentArgument(cfg.agentName ?? null) ??
        process.env["VAULT_AGENT_NAME"] ??
        resolveAgentName();
      if (agent === "agent") return undefined;
      return { prependContext: buildReminder(agent, "openclaw") };
    });

    api.registerTool({
      name: "second_brain_status",
      description: "Report Open Second Brain configuration and vault status.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const discovery = discoverConfig();
        const result = {
          config_path: discovery.path,
          config_exists: discovery.exists,
          config_keys: Object.keys(discovery.data).toSorted(),
          config: redactMapping(discovery.data),
          vault_path: vault,
          vault_exists: existsSync(vault),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    });

    api.registerTool({
      name: "second_brain_query",
      description: "List vault pages with optional title substring filter.",
      parameters: {
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
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        if (!existsSync(vault)) throw new Error(`vault directory missing: ${vault}`);
        const pattern = (params["pattern"] as string | undefined) ?? null;
        const limit = typeof params["limit"] === "number" ? (params["limit"] as number) : 50;
        if (limit < 1 || limit > 500) throw new Error("argument 'limit' must be between 1 and 500");

        const pages = listVaultPages(vault);
        const needle = pattern ? pattern.toLowerCase() : null;
        const matched = (
          needle === null ? pages : pages.filter((p) => p.title.toLowerCase().includes(needle))
        )
          .slice(0, limit)
          .map((p) => ({
            title: p.title,
            path: vaultRelativePath(p.path, vault),
            metadata: p.metadata,
          }));

        const result = {
          vault_path: vault,
          total_pages: pages.length,
          returned: matched.length,
          limit,
          pattern,
          pages: matched,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    });

    // Agents on this runtime record observations via the Brain writer
    // tools served by the MCP server (`brain_feedback`,
    // `brain_apply_evidence`, `brain_note`).

    api.registerTool({
      name: "vault_health",
      description: "Run vault, config, and plugin manifest health checks.",
      parameters: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Optional repository root to validate plugin manifests.",
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const repoRoot = (params["repo"] as string | undefined) ?? null;
        const results = doctor({ vault, repoRoot });
        const result = {
          vault_path: vault,
          ok: results.every((r) => r.ok),
          checks: results.map((r) => ({
            name: r.name,
            ok: r.ok,
            message: r.message,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    });
  },
});
