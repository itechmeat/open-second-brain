/**
 * OpenClaw native plugin entry for Open Second Brain.
 *
 * Pure TypeScript that delegates to `src/core/*` so the JS implementation
 * is no longer a hand-translated copy of the Python original — both runtimes
 * share the same source of truth.
 *
 * The plugin exposes the same five tools the MCP server does
 * (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
 * `event_log_append`, `vault_health`), with parameter schemas mirrored from
 * `src/mcp/tools.ts`.  No subprocess creation; passes the OpenClaw security
 * scanner.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent, validateEventTime } from "../core/event-log.ts";
import { buildReminder } from "../core/identity-reminder.ts";
import { listVaultPages, slugify, writeFrontmatter } from "../core/vault.ts";
import { PLACEHOLDER_AGENT_VALUES } from "../mcp/tools.ts";

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

function resolveOpenclawTimezone(api: { pluginConfig?: Record<string, unknown> }): string | null {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const candidate = cfg.timezone || process.env["VAULT_TIMEZONE"] || null;
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

function resolveOpenclawAgent(
  api: { pluginConfig?: Record<string, unknown> },
  argAgent: string | null,
): string {
  const normalized = normalizeAgentArg(argAgent);
  if (normalized) return normalized;
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  return cfg.agentName ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
}

function normalizeAgentArg(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;
  if (PLACEHOLDER_AGENT_VALUES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

function vaultRel(target: string, vault: string): string {
  if (target.startsWith(vault + "/")) return target.slice(vault.length + 1);
  return target;
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
        normalizeAgentArg(cfg.agentName ?? null) ??
        process.env["VAULT_AGENT_NAME"] ??
        resolveAgentName();
      if (agent === "agent") return undefined;
      return { prependContext: buildReminder(agent) };
    });

    api.registerTool(
      {
        name: "second_brain_status",
        description: "Report Open Second Brain configuration and vault status.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(): Promise<unknown> {
          const vault = resolveVaultPath(api);
          const discovery = discoverConfig();
          const result = {
            config_path: discovery.path,
            config_exists: discovery.exists,
            config_keys: Object.keys(discovery.data).sort(),
            config: redactMapping(discovery.data),
            vault_path: vault,
            vault_exists: existsSync(vault),
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
    );

    api.registerTool(
      {
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
          const matched = (needle === null
            ? pages
            : pages.filter((p) => p.title.toLowerCase().includes(needle))
          )
            .slice(0, limit)
            .map((p) => ({ title: p.title, path: vaultRel(p.path, vault), metadata: p.metadata }));

          const result = {
            vault_path: vault,
            total_pages: pages.length,
            returned: matched.length,
            limit,
            pattern,
            pages: matched,
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
    );

    api.registerTool(
      {
        name: "second_brain_capture",
        description: "Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Human-readable note title." },
            content: { type: "string", description: "Markdown body of the note." },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of tag strings.",
            },
            overwrite: {
              type: "boolean",
              description: "Allow overwriting an existing note with the same slug.",
            },
          },
          required: ["title", "content"],
          additionalProperties: false,
        },
        async execute(_id, params): Promise<unknown> {
          const vault = resolveVaultPath(api);
          if (!existsSync(vault)) throw new Error(`vault directory missing: ${vault}`);
          const title = (params["title"] as string | undefined) ?? "";
          const content = (params["content"] as string | undefined) ?? "";
          const tags = (params["tags"] as string[] | undefined) ?? [];
          const overwrite = Boolean(params["overwrite"]);
          if (!title.trim()) throw new Error("title must not be empty");
          if (!content.trim()) throw new Error("content must not be empty");

          const notesDir = join(vault, "AI Wiki", "notes");
          const slug = slugify(title);
          const target = join(notesDir, `${slug}.md`);
          // Capture existence BEFORE writeFrontmatter — otherwise existsSync
          // is always true after the write, making `overwritten` a no-op
          // signal whenever overwrite=true.
          const noteExisted = existsSync(target);
          if (noteExisted && !overwrite) {
            throw new Error(`note already exists: ${vaultRel(target, vault)}`);
          }
          const metadata: Record<string, string | number | boolean | string[]> = {
            title,
            type: "note",
            created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          };
          if (tags.length > 0) metadata["tags"] = tags;
          writeFrontmatter(target, metadata, content.trim());
          const result = {
            path: vaultRel(target, vault),
            absolute_path: target,
            slug,
            overwritten: noteExisted && overwrite,
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
    );

    api.registerTool(
      {
        name: "event_log_append",
        description: "Append a single-line event to the daily Markdown event log.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Single-line event message." },
            agent: { type: "string", description: "Agent name (default 'agent')." },
            date: { type: "string", description: "Optional event date in YYYY.MM.DD format." },
            time: { type: "string", description: "Optional event time in 24-hour HH:MM format." },
          },
          required: ["message"],
          additionalProperties: false,
        },
        async execute(_id, params): Promise<unknown> {
          const vault = resolveVaultPath(api);
          const message = params["message"] as string | undefined;
          if (!message || !message.trim()) {
            // Treat whitespace-only the same as missing; the MCP-side
            // `_coerce_str` does the same. Empty entries weaken the log.
            throw new Error("missing required argument: message");
          }
          const argAgent = (params["agent"] as string | undefined) ?? null;
          const date = (params["date"] as string | undefined) ?? null;
          const time = (params["time"] as string | undefined) ?? null;
          if (time) validateEventTime(time);
          const agent = resolveOpenclawAgent(api, argAgent);
          const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
          const path = await appendEvent(vault, agent, message, { date, time, tz });
          const result = {
            path: vaultRel(path, vault),
            absolute_path: path,
            agent,
            date,
            time,
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
    );

    api.registerTool(
      {
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
            checks: results.map((r) => ({ name: r.name, ok: r.ok, message: r.message })),
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
    );
  },
});
