/**
 * OpenClaw native plugin entry for Open Second Brain.
 *
 * Pure TypeScript that delegates to `src/core/*` so the JS implementation
 * is no longer a hand-translated copy of the Python original — both runtimes
 * share the same source of truth.
 *
 * The plugin exposes the full Open Second Brain tool surface — the original
 * five (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
 * `event_log_append`, `vault_health`) plus the eight Pay Memory tools added
 * in v0.8.0 — with parameter schemas mirrored from `src/mcp/tools.ts`.
 * No subprocess creation; passes the OpenClaw security scanner.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import {
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent, validateEventTime } from "../core/event-log.ts";
import { buildReminder } from "../core/identity-reminder.ts";
import {
  checkPolicy,
  consumePendingRequest,
  loadPendingRequest,
  vaultRelativePath,
  writeAsset,
  writePendingRequest,
  writePolicyIfMissing,
  writeReceipt,
  writeReport,
  payMemoryDirs,
} from "../core/pay-memory/index.ts";
import type { ReceiptPolicyStatus } from "../core/pay-memory/types.ts";
import { mkdirSync } from "node:fs";
import { listVaultPages, slugify, writeFrontmatter } from "../core/vault.ts";
import {
  normalizeAgentArgument,
  PLACEHOLDER_AGENT_VALUES,
} from "../core/agent-identity.ts";

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
  const normalized = normalizeAgentArgument(argAgent);
  if (normalized) return normalized;
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  return cfg.agentName ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
}

/**
 * Helper for Pay Memory tools that need a numeric `expected_amount` field.
 * The OpenClaw schema declares the type as `["number", "string"]` to match
 * the MCP shape — agents sometimes serialise numbers as strings.
 *
 * Whitespace-only strings are treated as "not provided", *not* as `0`.
 * Without the explicit trim, `Number(" ")` evaluates to `0` and would
 * silently change a policy decision.
 */
function coerceExpectedAmount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("expected_amount must be a finite number");
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error("expected_amount must be a number or numeric string");
    }
    return parsed;
  }
  throw new Error("expected_amount must be a number or numeric string");
}

function strOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asJson(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
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
            .map((p) => ({ title: p.title, path: vaultRelativePath(p.path, vault), metadata: p.metadata }));

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
            throw new Error(`note already exists: ${vaultRelativePath(target, vault)}`);
          }
          const metadata: Record<string, string | number | boolean | string[]> = {
            title,
            type: "note",
            created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          };
          if (tags.length > 0) metadata["tags"] = tags;
          writeFrontmatter(target, metadata, content.trim());
          const result = {
            path: vaultRelativePath(target, vault),
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
            path: vaultRelativePath(path, vault),
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

    // ── Pay Memory tools ───────────────────────────────────────────────────

    api.registerTool({
      name: "payment_memory_init",
      description:
        "Bootstrap the Pay Memory layout (policies/, payments/, assets/, drafts/, reports/) and write the spending policy template.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          overwrite: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const overwrite = Boolean(params["overwrite"] ?? false);
        const agent = resolveOpenclawAgent(api, (params["agent"] as string | undefined) ?? null);

        const dirs = payMemoryDirs(vault);
        const created: string[] = [];
        const skipped: string[] = [];
        for (const dir of [dirs.policies, dirs.payments, dirs.assets, dirs.drafts, dirs.reports]) {
          const existed = existsSync(dir);
          mkdirSync(dir, { recursive: true });
          (existed ? skipped : created).push(vaultRelativePath(dir, vault));
        }
        const policy = writePolicyIfMissing(vault, { overwrite });
        return asJson({
          vault_path: vault,
          agent,
          created,
          skipped,
          policy_path: vaultRelativePath(policy.path, vault),
          policy_status: policy.status,
        });
      },
    });

    api.registerTool({
      name: "payment_receipt_append",
      description:
        "Save a Markdown receipt for one paid API call. raw_output is run through a redactor before persisting.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          service: { type: "string" },
          status: { type: "string" },
          reason: { type: "string" },
          category: { type: "string" },
          endpoint: { type: "string" },
          expected_cost: { type: "string" },
          actual_amount: { type: "string" },
          currency: { type: "string" },
          payment_proof: { type: "string" },
          result_ref: { type: "string" },
          result_note: { type: "string" },
          raw_output: { type: "string" },
          slug: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          overwrite: { type: "boolean" },
          policy_status: {
            type: "string",
            enum: ["allowed", "approval_required", "denied", "not_checked"],
          },
          policy_rule: { type: "string" },
          policy_reasons: { type: "array", items: { type: "string" } },
          policy_checked_at: { type: "string" },
          from_request: { type: "string" },
        },
        required: ["service", "status", "reason"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const agent = resolveOpenclawAgent(api, (params["agent"] as string | undefined) ?? null);

        let policyStatus = strOrNull(params["policy_status"]) as
          | ReceiptPolicyStatus
          | null;
        let policyRule = strOrNull(params["policy_rule"]);
        const policyReasonsRaw = params["policy_reasons"];
        let policyReasons: string[] | null = null;
        if (policyReasonsRaw !== undefined && policyReasonsRaw !== null) {
          if (
            !Array.isArray(policyReasonsRaw) ||
            !policyReasonsRaw.every((s) => typeof s === "string")
          ) {
            throw new Error("policy_reasons must be an array of strings");
          }
          policyReasons = [...policyReasonsRaw] as string[];
        }
        let policyCheckedAt = strOrNull(params["policy_checked_at"]);
        let approvalStatus:
          | "pending"
          | "approved"
          | "rejected"
          | "consumed"
          | null = null;
        let approvedBy: string | null = null;
        let approvedAt: string | null = null;
        const fromRequest = strOrNull(params["from_request"]);
        if (fromRequest) {
          const loaded = loadPendingRequest(vault, fromRequest);
          if (!loaded) throw new Error(`pending request not found: ${fromRequest}`);
          const meta = loaded.metadata;
          const get = (k: string): string | null => {
            const v = meta[k];
            if (v === undefined || v === null) return null;
            return Array.isArray(v) ? v.join(", ") : String(v);
          };
          policyStatus ??= (get("policy_status") as ReceiptPolicyStatus | null) ?? null;
          policyRule ??= get("policy_rule");
          approvalStatus = loaded.status;
          approvedBy = get("approved_by");
          approvedAt = get("approved_at");
        }
        if (policyStatus !== null) {
          const allowed: ReadonlyArray<ReceiptPolicyStatus> = [
            "allowed",
            "approval_required",
            "denied",
            "not_checked",
          ];
          if (!allowed.includes(policyStatus)) {
            throw new Error(
              `policy_status must be one of: ${allowed.join(", ")}`,
            );
          }
        }

        const result = writeReceipt(vault, {
          agent,
          service: String(params["service"]),
          status: String(params["status"]),
          reason: String(params["reason"]),
          category: strOrNull(params["category"]),
          endpoint: strOrNull(params["endpoint"]),
          expectedCost: strOrNull(params["expected_cost"]),
          actualAmount: strOrNull(params["actual_amount"]),
          currency: strOrNull(params["currency"]),
          paymentProof: strOrNull(params["payment_proof"]),
          resultRef: strOrNull(params["result_ref"]),
          resultNote: strOrNull(params["result_note"]),
          rawOutput: strOrNull(params["raw_output"]),
          slug: strOrNull(params["slug"]),
          date: strOrNull(params["date"]),
          time: strOrNull(params["time"]),
          overwrite: Boolean(params["overwrite"] ?? false),
          tz,
          policyStatus,
          policyRule,
          policyReasons,
          policyCheckedAt,
          approvalRequestId: fromRequest,
          approvalStatus,
          approvedBy,
          approvedAt,
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          date: result.date,
          created: result.created,
        });
      },
    });

    api.registerTool({
      name: "asset_capture",
      description:
        "Save a Markdown note for an asset produced by a paid call, linked to its receipt.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          service: { type: "string" },
          result_url: { type: "string" },
          source_receipt: { type: "string" },
          prompt: { type: "string" },
          used_in: { type: "string" },
          slug: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["title", "service", "result_url"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const result = writeAsset(vault, {
          title: String(params["title"]),
          service: String(params["service"]),
          resultUrl: String(params["result_url"]),
          sourceReceipt: strOrNull(params["source_receipt"]),
          prompt: strOrNull(params["prompt"]),
          usedIn: strOrNull(params["used_in"]),
          slug: strOrNull(params["slug"]),
          overwrite: Boolean(params["overwrite"] ?? false),
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          created: result.created,
        });
      },
    });

    api.registerTool({
      name: "payment_report_generate",
      description:
        "Aggregate a date's payment receipts into a Markdown report under AI Wiki/reports/.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          title: { type: "string" },
          task: { type: "string" },
          slug: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["date"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const result = writeReport(vault, {
          date: String(params["date"]),
          title: strOrNull(params["title"]),
          task: strOrNull(params["task"]),
          slug: strOrNull(params["slug"]),
          overwrite: Boolean(params["overwrite"] ?? false),
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          receipts_used: result.receiptsUsed,
        });
      },
    });

    api.registerTool({
      name: "payment_policy_check",
      description:
        "Evaluate a prospective paid call against AI Wiki/policies/spending.json. Returns allowed / approval_required / denied + the rule that fired.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          expected_amount: { type: ["number", "string"] },
          currency: { type: "string" },
          category: { type: "string" },
          date: { type: "string" },
        },
        required: ["service"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const decision = checkPolicy(vault, {
          service: String(params["service"]),
          expectedAmount: coerceExpectedAmount(params["expected_amount"]),
          currency: strOrNull(params["currency"]),
          category: strOrNull(params["category"]),
          date: strOrNull(params["date"]),
          tz,
        });
        return asJson({
          status: decision.status,
          allowed: decision.allowed,
          approval_required: decision.approvalRequired,
          rule: decision.rule,
          reasons: decision.reasons,
          has_policy: decision.hasPolicy,
          policy_path:
            decision.policyPath !== null
              ? vaultRelativePath(decision.policyPath, vault)
              : null,
          currency: decision.currency,
        });
      },
    });

    api.registerTool({
      name: "payment_request_approval",
      description:
        "Create a pending-payment-request that the user must approve before the agent runs `pay`. Records the policy check at request time.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          service: { type: "string" },
          reason: { type: "string" },
          expected_amount: { type: ["number", "string"] },
          currency: { type: "string" },
          category: { type: "string" },
          endpoint: { type: "string" },
          expected_output: { type: "string" },
          vault_files: { type: "array", items: { type: "string" } },
          slug: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          enforce_policy: { type: "boolean" },
        },
        required: ["service", "reason"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const agent = resolveOpenclawAgent(api, (params["agent"] as string | undefined) ?? null);
        const vaultFilesRaw = params["vault_files"];
        let vaultFiles: string[] | null = null;
        if (vaultFilesRaw !== undefined && vaultFilesRaw !== null) {
          if (
            !Array.isArray(vaultFilesRaw) ||
            !vaultFilesRaw.every((s) => typeof s === "string")
          ) {
            throw new Error("vault_files must be an array of strings");
          }
          vaultFiles = [...vaultFilesRaw] as string[];
        }
        const result = writePendingRequest(vault, {
          agent,
          service: String(params["service"]),
          reason: String(params["reason"]),
          expectedAmount: coerceExpectedAmount(params["expected_amount"]),
          currency: strOrNull(params["currency"]),
          category: strOrNull(params["category"]),
          endpoint: strOrNull(params["endpoint"]),
          expectedOutput: strOrNull(params["expected_output"]),
          vaultFiles,
          slug: strOrNull(params["slug"]),
          date: strOrNull(params["date"]),
          time: strOrNull(params["time"]),
          enforcePolicy: Boolean(params["enforce_policy"] ?? false),
          tz,
        });
        return asJson({
          id: result.id,
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          status: result.status,
          created: result.created,
          policy_status: result.policyDecision.status,
          policy_rule: result.policyDecision.rule,
        });
      },
    });

    api.registerTool({
      name: "payment_request_status",
      description:
        "Look up a pending-payment-request by id and return its current status and metadata. The agent uses this to poll for human approval.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const id = String(params["id"]);
        const loaded = loadPendingRequest(vault, id);
        if (!loaded) throw new Error(`pending request not found: ${id}`);
        const meta = loaded.metadata;
        const get = (k: string): string | null => {
          const v = meta[k];
          if (v === undefined || v === null) return null;
          return Array.isArray(v) ? v.join(", ") : String(v);
        };
        return asJson({
          id,
          path: loaded.relativePath,
          status: loaded.status,
          service: get("service"),
          reason: get("reason"),
          expected_amount: get("expected_amount"),
          currency: get("currency"),
          created: get("created"),
          approved_by: get("approved_by"),
          approved_at: get("approved_at"),
          rejected_by: get("rejected_by"),
          rejected_at: get("rejected_at"),
          rejection_reason: get("rejection_reason"),
          receipt: get("receipt"),
          policy_status: get("policy_status"),
          policy_rule: get("policy_rule"),
        });
      },
    });

    api.registerTool({
      name: "payment_request_consume",
      description:
        "Mark an `approved` request as `consumed` and link the resulting receipt path. Called by the agent after the paid call succeeded.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          receipt: { type: "string" },
        },
        required: ["id", "receipt"],
        additionalProperties: false,
      },
      async execute(_id, params): Promise<unknown> {
        const vault = resolveVaultPath(api);
        const result = await consumePendingRequest(vault, String(params["id"]), {
          receiptPath: String(params["receipt"]),
        });
        return asJson({
          id: result.id,
          path: result.relativePath,
          status: result.status,
        });
      },
    });
  },
});
