/**
 * MCP tool registry. As of v0.9.0 the advertised surface is:
 *
 *   - Core read/health tools (`second_brain_status`, `second_brain_query`,
 *     `vault_health`).
 *   - Brain tools (`brain_feedback`, `brain_dream`,
 *     `brain_apply_evidence`, `brain_digest`, `brain_query`,
 *     `brain_doctor`) — see `./brain-tools.ts`.
 *   - Pay Memory tools (`payment_*`, `asset_capture`).
 *
 * `event_log_append` and `second_brain_capture` are intentionally
 * *not* registered here in v0.9.0 — Brain replaces them as the
 * agent-facing writable surface (design doc §11.1). Their handler
 * functions remain on disk (`toolEventLogAppend`, `toolCapture` below)
 * so the CLI / shell tooling keeps working; only the entries in the
 * exported tool array are removed.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
} from "../core/config.ts";
import { computeBrainStatus } from "../core/brain/status.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent, validateEventTime } from "../core/event-log.ts";
import { BRAIN_TOOLS } from "./brain-tools.ts";
import { SEARCH_TOOLS, buildSearchStatusBlock } from "./search-tools.ts";
import {
  checkPolicy,
  consumePendingRequest,
  loadPendingRequest,
  payMemoryDirs,
  vaultRelativePath,
  writeAsset,
  writePendingRequest,
  writePolicyIfMissing,
  writeReceipt,
  writeReport,
} from "../core/pay-memory/index.ts";
import type { ReceiptPolicyStatus } from "../core/pay-memory/types.ts";
import {
  normalizeAgentArgument,
  PLACEHOLDER_AGENT_VALUES,
} from "../core/agent-identity.ts";
import {
  ensureInsideVault,
  vaultRelative,
} from "../core/path-safety.ts";
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

/**
 * Coerce an optional MCP argument that should be a finite number. Accepts
 * a real number, a numeric string (`"0.05"`), or an absent value
 * (`undefined`/`null`/empty string/whitespace-only string → `null`).
 * Anything else throws INVALID_PARAMS.
 *
 * Crucially, `Number(" ")` evaluates to `0` in JS — without this helper a
 * whitespace-only field would silently change a policy decision. We trim
 * first and treat trimmed-empty as "not provided".
 */
function coerceOptionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const raw = args[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a finite number`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a number or numeric string`);
    }
    return parsed;
  }
  throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a number or numeric string`);
}


// ── Tool implementations ────────────────────────────────────────────────────

async function toolStatus(ctx: ServerContext): Promise<Record<string, unknown>> {
  const discovery = discoverConfig(ctx.configPath ?? undefined);
  const vaultExists = isDir(ctx.vault);
  const configKeys = Object.keys(discovery.data).sort();
  // Safe to call on a vault that has no Brain layer yet — returns
  // `present: false` with zero counts.
  const brain = vaultExists ? computeBrainStatus(ctx.vault) : null;
  const searchDisabled = discovery.data["search_enabled"] === "false";
  const search = vaultExists && !searchDisabled ? await buildSearchStatusBlock(ctx) : null;
  return {
    config_path: String(discovery.path),
    config_exists: discovery.exists,
    config_keys: configKeys,
    config: redactMapping(discovery.data),
    vault_path: ctx.vault,
    vault_exists: vaultExists,
    ...(brain ? { brain } : {}),
    ...(search ? { search } : {}),
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

// ── Pay Memory tools ────────────────────────────────────────────────────────

async function toolPaymentMemoryInit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const overwrite = Boolean(args["overwrite"] ?? false);
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

  const dirs = payMemoryDirs(ctx.vault);
  const dirList = [dirs.policies, dirs.payments, dirs.assets, dirs.drafts, dirs.reports];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirList) {
    const existed = existsSync(dir);
    mkdirSync(dir, { recursive: true });
    (existed ? skipped : created).push(vaultRelativePath(dir, ctx.vault));
  }
  const policy = writePolicyIfMissing(ctx.vault, { overwrite });
  return {
    vault_path: ctx.vault,
    agent,
    created,
    skipped,
    policy_path: vaultRelativePath(policy.path, ctx.vault),
    policy_status: policy.status,
  };
}

async function toolPaymentReceiptAppend(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
  const tz = resolveTimezone(ctx.configPath ?? undefined);

  let policyStatus = coerceStr(args, "policy_status", false) as
    | ReceiptPolicyStatus
    | null;
  let policyRule = coerceStr(args, "policy_rule", false);
  const policyReasonsRaw = args["policy_reasons"];
  let policyReasons: string[] | null = null;
  if (policyReasonsRaw !== undefined && policyReasonsRaw !== null) {
    if (
      !Array.isArray(policyReasonsRaw) ||
      !policyReasonsRaw.every((s) => typeof s === "string")
    ) {
      throw new MCPError(INVALID_PARAMS, "policy_reasons must be an array of strings");
    }
    policyReasons = [...policyReasonsRaw] as string[];
  }
  let policyCheckedAt = coerceStr(args, "policy_checked_at", false);
  let approvalStatus: "pending" | "approved" | "rejected" | "consumed" | null = null;
  let approvedBy: string | null = null;
  let approvedAt: string | null = null;
  const fromRequest = coerceStr(args, "from_request", false);
  if (fromRequest) {
    const loaded = loadPendingRequest(ctx.vault, fromRequest);
    if (!loaded) {
      throw new Error(`pending request not found: ${fromRequest}`);
    }
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
      throw new MCPError(
        INVALID_PARAMS,
        `policy_status must be one of: ${allowed.join(", ")}`,
      );
    }
  }

  const result = writeReceipt(ctx.vault, {
    agent,
    service: coerceStr(args, "service", true)!,
    status: coerceStr(args, "status", true)!,
    reason: coerceStr(args, "reason", true)!,
    paymentLayer: coerceStr(args, "payment_layer", false),
    network: coerceStr(args, "network", false),
    category: coerceStr(args, "category", false),
    endpoint: coerceStr(args, "endpoint", false),
    expectedCost: coerceStr(args, "expected_cost", false),
    actualAmount: coerceStr(args, "actual_amount", false),
    currency: coerceStr(args, "currency", false),
    paymentProof: coerceStr(args, "payment_proof", false),
    resultRef: coerceStr(args, "result_ref", false),
    resultNote: coerceStr(args, "result_note", false),
    rawOutput: coerceStr(args, "raw_output", false),
    slug: coerceStr(args, "slug", false),
    date: coerceStr(args, "date", false),
    time: coerceStr(args, "time", false),
    overwrite: Boolean(args["overwrite"] ?? false),
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
  return {
    path: result.relativePath,
    absolute_path: resolve(result.path),
    slug: result.slug,
    date: result.date,
    created: result.created,
  };
}

async function toolAssetCapture(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = writeAsset(ctx.vault, {
    title: coerceStr(args, "title", true)!,
    service: coerceStr(args, "service", true)!,
    resultUrl: coerceStr(args, "result_url", true)!,
    sourceReceipt: coerceStr(args, "source_receipt", false),
    prompt: coerceStr(args, "prompt", false),
    usedIn: coerceStr(args, "used_in", false),
    slug: coerceStr(args, "slug", false),
    overwrite: Boolean(args["overwrite"] ?? false),
  });
  return {
    path: result.relativePath,
    absolute_path: resolve(result.path),
    slug: result.slug,
    created: result.created,
  };
}

async function toolPaymentRequestApproval(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
  const tz = resolveTimezone(ctx.configPath ?? undefined);

  const expectedAmount = coerceOptionalNumber(args, "expected_amount");

  const vaultFiles = args["vault_files"];
  let vaultFilesList: string[] | null = null;
  if (vaultFiles !== undefined && vaultFiles !== null) {
    if (!Array.isArray(vaultFiles) || !vaultFiles.every((s) => typeof s === "string")) {
      throw new MCPError(INVALID_PARAMS, "vault_files must be an array of strings");
    }
    vaultFilesList = [...vaultFiles] as string[];
  }

  const result = writePendingRequest(ctx.vault, {
    agent,
    service: coerceStr(args, "service", true)!,
    reason: coerceStr(args, "reason", true)!,
    expectedAmount,
    currency: coerceStr(args, "currency", false),
    category: coerceStr(args, "category", false),
    endpoint: coerceStr(args, "endpoint", false),
    expectedOutput: coerceStr(args, "expected_output", false),
    vaultFiles: vaultFilesList,
    slug: coerceStr(args, "slug", false),
    date: coerceStr(args, "date", false),
    time: coerceStr(args, "time", false),
    enforcePolicy: Boolean(args["enforce_policy"] ?? false),
    tz,
  });
  return {
    id: result.id,
    path: result.relativePath,
    absolute_path: resolve(result.path),
    status: result.status,
    created: result.created,
    policy_status: result.policyDecision.status,
    policy_rule: result.policyDecision.rule,
  };
}

async function toolPaymentRequestStatus(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  const loaded = loadPendingRequest(ctx.vault, id);
  if (!loaded) {
    throw new Error(`pending request not found: ${id}`);
  }
  const meta = loaded.metadata;
  const get = (k: string): string | null => {
    const v = meta[k];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? v.join(", ") : String(v);
  };
  return {
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
  };
}

async function toolPaymentRequestConsume(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  const receiptPath = coerceStr(args, "receipt", true)!;
  const result = await consumePendingRequest(ctx.vault, id, { receiptPath });
  return {
    id: result.id,
    path: result.relativePath,
    status: result.status,
  };
}

async function toolPaymentPolicyCheck(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const expectedAmount = coerceOptionalNumber(args, "expected_amount");
  const tz = resolveTimezone(ctx.configPath ?? undefined);
  const decision = checkPolicy(ctx.vault, {
    service: coerceStr(args, "service", true)!,
    expectedAmount,
    currency: coerceStr(args, "currency", false),
    category: coerceStr(args, "category", false),
    date: coerceStr(args, "date", false),
    tz,
  });
  return {
    status: decision.status,
    allowed: decision.allowed,
    approval_required: decision.approvalRequired,
    rule: decision.rule,
    reasons: decision.reasons,
    has_policy: decision.hasPolicy,
    policy_path:
      decision.policyPath !== null
        ? vaultRelativePath(decision.policyPath, ctx.vault)
        : null,
    currency: decision.currency,
  };
}

async function toolPaymentReportGenerate(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = writeReport(ctx.vault, {
    date: coerceStr(args, "date", true)!,
    title: coerceStr(args, "title", false),
    task: coerceStr(args, "task", false),
    slug: coerceStr(args, "slug", false),
    overwrite: Boolean(args["overwrite"] ?? false),
  });
  return {
    path: result.relativePath,
    absolute_path: resolve(result.path),
    slug: result.slug,
    receipts_used: result.receiptsUsed,
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
    // `second_brain_capture` and `event_log_append` are intentionally
    // not advertised in v0.9.0+. Their handlers (`toolCapture`,
    // `toolEventLogAppend`) remain in this file for human-side shell
    // use (`o2b append-event`); only the entries in the exported tool
    // array are removed — see §11.1 of the v0.9.0 design doc.
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
      name: "payment_memory_init",
      description:
        "Bootstrap the Pay Memory layout (policies/, payments/, assets/, drafts/, reports/) and write the spending policy template.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent identity (defaults to server-resolved name)." },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing policy file. Directories are always idempotent.",
          },
        },
        additionalProperties: false,
      },
      handler: toolPaymentMemoryInit,
    },
    {
      name: "payment_receipt_append",
      description:
        "Save a Markdown receipt for one paid API call. raw_output is run through a redactor before persisting.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent identity (defaults to server-resolved name)." },
          service: { type: "string", description: "Provider/skill identifier, e.g. 'paysponge/fal'." },
          status: { type: "string", description: "Outcome of the paid call ('success', 'failed', ...)." },
          reason: { type: "string", description: "Why the paid call was made — short imperative sentence." },
          category: { type: "string", description: "Optional category tag." },
          endpoint: { type: "string", description: "Gateway endpoint URL returned by pay-skills." },
          expected_cost: { type: "string", description: "Pre-call expected price range." },
          actual_amount: { type: "string", description: "Actual amount charged (parsed from pay-tool output)." },
          currency: { type: "string", description: "Currency code (e.g. 'USDC')." },
          payment_proof: { type: "string", description: "Public proof / signature / receipt id." },
          result_ref: { type: "string", description: "Generated asset URL or response id." },
          result_note: { type: "string", description: "Vault path to the asset note (wikilink target)." },
          raw_output: { type: "string", description: "Raw payment-tool output to persist after redaction." },
          slug: { type: "string", description: "Optional slug override; default derives from service+reason." },
          date: { type: "string", description: "Receipt date in YYYY-MM-DD; default = today (vault tz)." },
          time: { type: "string", description: "Receipt time in HH:MM 24h; default = now (vault tz)." },
          overwrite: { type: "boolean", description: "Allow overwriting an existing receipt." },
          policy_status: {
            type: "string",
            enum: ["allowed", "approval_required", "denied", "not_checked"],
            description:
              "Real outcome of the spending-policy check. Defaults to `not_checked` when omitted — the receipt body will explicitly say so rather than claiming the policy approved the call.",
          },
          policy_rule: {
            type: "string",
            description: "Policy rule name that fired (e.g. `max_single_call`).",
          },
          policy_reasons: {
            type: "array",
            items: { type: "string" },
            description: "Human-readable reasons returned by the policy check.",
          },
          policy_checked_at: {
            type: "string",
            description: "ISO-Z timestamp at which the policy was evaluated.",
          },
          from_request: {
            type: "string",
            description:
              "Pending-payment-request id. When supplied, the receipt inherits policy / approval audit fields from that request — the agent doesn't have to re-state them.",
          },
          payment_layer: {
            type: "string",
            description: "Payment rail (default `pay.sh`). Override only when a different rail was used.",
          },
          network: {
            type: "string",
            description: "Settlement network (default `solana`). Override only when a different network was used.",
          },
        },
        required: ["service", "status", "reason"],
        additionalProperties: false,
      },
      handler: toolPaymentReceiptAppend,
    },
    {
      name: "asset_capture",
      description:
        "Save a Markdown note for an asset produced by a paid API call. Frontmatter links back to the receipt.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Human-readable asset title." },
          service: { type: "string", description: "Provider/skill identifier that produced the asset." },
          result_url: { type: "string", description: "URL or identifier of the generated asset." },
          source_receipt: { type: "string", description: "Vault path to the receipt note." },
          prompt: { type: "string", description: "Prompt sent to the service (rendered as a quote block)." },
          used_in: { type: "string", description: "Vault path of the draft/page that consumes this asset." },
          slug: { type: "string", description: "Optional slug override; default derives from title." },
          overwrite: { type: "boolean", description: "Allow overwriting an existing asset note." },
        },
        required: ["title", "service", "result_url"],
        additionalProperties: false,
      },
      handler: toolAssetCapture,
    },
    {
      name: "payment_request_approval",
      description:
        "Create a pending-payment-request that the user must approve before the agent runs `pay`. Records the policy check at request time.",
      inputSchema: {
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
          enforce_policy: {
            type: "boolean",
            description: "If true, refuse to create the request when the policy denies it.",
          },
        },
        required: ["service", "reason"],
        additionalProperties: false,
      },
      handler: toolPaymentRequestApproval,
    },
    {
      name: "payment_request_status",
      description:
        "Look up a pending-payment-request by id and return its current status and metadata. The agent uses this to poll for human approval.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The request id (slug)." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: toolPaymentRequestStatus,
    },
    {
      name: "payment_request_consume",
      description:
        "Mark an `approved` request as `consumed` and link the resulting receipt path. Called by the agent after the paid call succeeded.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          receipt: { type: "string", description: "Vault-relative path to the receipt note." },
        },
        required: ["id", "receipt"],
        additionalProperties: false,
      },
      handler: toolPaymentRequestConsume,
    },
    {
      name: "payment_policy_check",
      description:
        "Evaluate a prospective paid call against AI Wiki/policies/spending.json. Returns allowed / approval_required / denied + the rule that fired.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Provider/skill identifier, e.g. 'paysponge/fal'." },
          expected_amount: {
            type: ["number", "string"],
            description: "Expected payment amount; numeric or numeric-string.",
          },
          currency: { type: "string", description: "Currency code; defaults to the policy currency." },
          category: { type: "string", description: "Optional category for per-category caps." },
          date: { type: "string", description: "Date in YYYY-MM-DD; default = today (vault tz)." },
        },
        required: ["service"],
        additionalProperties: false,
      },
      handler: toolPaymentPolicyCheck,
    },
    {
      name: "payment_report_generate",
      description:
        "Aggregate a date's payment receipts into a Markdown report under AI Wiki/reports/.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD whose receipts will be aggregated." },
          title: { type: "string", description: "Report title; default 'Payment Report <date>'." },
          task: { type: "string", description: "Optional task description rendered in the body." },
          slug: { type: "string", description: "Optional slug override." },
          overwrite: { type: "boolean", description: "Allow overwriting an existing report." },
        },
        required: ["date"],
        additionalProperties: false,
      },
      handler: toolPaymentReportGenerate,
    },
  ];
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
