/**
 * MCP tool registry: the five tools exposed by Open Second Brain
 * (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
 * `event_log_append`, `vault_health`). Each handler delegates to the
 * core/* helpers so the contract stays identical to the CLI.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent, validateEventTime } from "../core/event-log.ts";
import { listVaultPages, slugify, writeFrontmatter } from "../core/vault.ts";
import { INVALID_PARAMS, METHOD_NOT_FOUND, MCPError } from "./protocol.ts";

export interface ServerContext {
  readonly vault: string;
  readonly configPath: string | null;
  readonly repoRoot: string | null;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * Strings the LLM is most likely to emit as a guess for the `agent` argument
 * when it doesn't actually know its identity. None are useful as a real
 * `@<name>` in Daily — they should fall back to the server-resolved default.
 * Compared case-insensitively, after a leading `@` is stripped.
 *
 * Mirrored verbatim by the OpenClaw plugin entry so all runtimes filter the
 * same hallucination shapes out of Daily.
 */
const PLACEHOLDER_AGENT_VALUES = new Set([
  "agent",
  "assistant",
  "ai",
  "ai-assistant",
  "bot",
  "chatbot",
  "claude",
  "claude-code",
  "codex",
  "codex-cli",
  "codex-exec",
  "copilot",
  "gemini",
  "gpt",
  "gpt-4",
  "gpt-5",
  "hermes",
  "llm",
  "model",
  "openai",
  "openclaw",
  "user",
]);

function vaultRelpath(target: string, vault: string): string {
  try {
    return relative(resolve(vault), resolve(target));
  } catch {
    return target;
  }
}

function ensureInsideVault(target: string, vault: string): string {
  const resolvedTarget = resolve(target);
  const resolvedVault = resolve(vault);
  if (resolvedTarget !== resolvedVault && !resolvedTarget.startsWith(resolvedVault + "/")) {
    throw new Error(`path escapes vault: ${target}`);
  }
  return resolvedTarget;
}

function coerceStr(args: Record<string, unknown>, key: string, required = true, defaultValue: string | null = null): string | null {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) {
      throw new MCPError(INVALID_PARAMS, `missing required argument: ${key}`);
    }
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a string`);
  }
  return value;
}

function coerceStrList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a list of strings`);
  }
  return [...value] as string[];
}

function coerceInt(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[key] ?? defaultValue;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be an integer`);
  }
  if (value < min || value > max) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be between ${min} and ${max}`);
  }
  return value;
}

function normalizeAgentArgument(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;
  if (PLACEHOLDER_AGENT_VALUES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function toolStatus(ctx: ServerContext): Promise<Record<string, unknown>> {
  const discovery = discoverConfig(ctx.configPath ?? undefined);
  const vaultExists = isDir(ctx.vault);
  const configKeys = Object.keys(discovery.data).sort();
  return {
    config_path: String(discovery.path),
    config_exists: discovery.exists,
    config_keys: configKeys,
    config: redactMapping(discovery.data),
    vault_path: ctx.vault,
    vault_exists: vaultExists,
  };
}

async function toolQuery(ctx: ServerContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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

async function toolCapture(ctx: ServerContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isDir(ctx.vault)) {
    throw new MCPError(INVALID_PARAMS, `vault directory missing: ${ctx.vault}`);
  }
  const title = coerceStr(args, "title", true)!;
  const content = coerceStr(args, "content", true)!;
  const tags = coerceStrList(args, "tags");
  const overwrite = Boolean(args["overwrite"] ?? false);

  if (!title.trim()) throw new MCPError(INVALID_PARAMS, "title must not be empty");
  if (!content.trim()) throw new MCPError(INVALID_PARAMS, "content must not be empty");

  const notesDir = join(ctx.vault, "AI Wiki", "notes");
  mkdirSync(notesDir, { recursive: true });
  const slug = slugify(title);
  const target = join(notesDir, `${slug}.md`);
  ensureInsideVault(target, ctx.vault);

  const existed = existsSync(target);
  if (existed && !overwrite) {
    throw new Error(`note already exists: ${vaultRelpath(target, ctx.vault)}`);
  }

  const metadata: Record<string, string | number | boolean | string[]> = {
    title,
    type: "note",
    created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  if (tags.length > 0) metadata["tags"] = tags;
  writeFrontmatter(target, metadata, content.trim());

  return {
    path: vaultRelpath(target, ctx.vault),
    absolute_path: resolve(target),
    slug,
    overwritten: existed && overwrite,
  };
}

async function toolEventLogAppend(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const message = coerceStr(args, "message", true)!;
  const agent = coerceStr(args, "agent", false);
  const date = coerceStr(args, "date", false);
  const time = coerceStr(args, "time", false);

  if (time !== null) validateEventTime(time);

  const effectiveAgent =
    normalizeAgentArgument(agent) ?? resolveAgentName(ctx.configPath ?? undefined);
  const tz = resolveTimezone(ctx.configPath ?? undefined);
  const path = await appendEvent(ctx.vault, effectiveAgent, message, { date, time, tz });

  return {
    path: vaultRelpath(path, ctx.vault),
    absolute_path: resolve(path),
    agent: effectiveAgent,
    date,
    time,
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

function isDir(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function buildToolTable(): ToolDefinition[] {
  return [
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
    {
      name: "second_brain_capture",
      description: "Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
      inputSchema: {
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
      handler: toolCapture,
    },
    {
      name: "event_log_append",
      description: "Append a single-line event to the daily Markdown event log.",
      inputSchema: {
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
      handler: toolEventLogAppend,
    },
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
  ];
}

export function findTool(tools: ReadonlyArray<ToolDefinition>, name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new MCPError(METHOD_NOT_FOUND, `unknown tool: ${name}`);
  return tool;
}

// Re-export for callers that need to filter agent guesses themselves.
export { PLACEHOLDER_AGENT_VALUES };
