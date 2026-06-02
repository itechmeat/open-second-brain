/**
 * MCP tool registry slice for Pay Memory.
 *
 * Exposes the eight Pay Memory tools (`payment_*`, `asset_capture`)
 * that record paid agent actions as inspectable Markdown inside the
 * vault. None of these handlers run a real payment — they only
 * persist memory (policy decisions, approval state, receipts, assets,
 * reports). The actual payment rail (`pay.sh`) is invoked separately
 * by the agent harness.
 *
 * Layout mirrors `./brain-tools.ts` and `./search-tools.ts`: each
 * handler is a local async function; one frozen `PAY_MEMORY_TOOLS`
 * array is consumed by `buildToolTable()` in `./tools.ts` via
 * spread.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { resolveAgentName, resolveTimezone } from "../core/config.ts";
import { normalizeAgentArgument } from "../core/agent-identity.ts";
import {
  checkPolicy,
  consumePendingRequest,
  loadPendingRequest,
  payMemoryDirs,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_SPENDING_JSON_REL,
  vaultRelativePath,
  writeAsset,
  writePendingRequest,
  writePolicyIfMissing,
  writeReceipt,
  writeReport,
} from "../core/pay-memory/index.ts";
import type { ReceiptPolicyStatus } from "../core/pay-memory/types.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";
import { coerceOptionalNumber, coerceStr } from "./coerce.ts";

async function toolPaymentMemoryInit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const overwrite = Boolean(args["overwrite"] ?? false);
  const agentArg = coerceStr(args, "agent", false);
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

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
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
  const tz = resolveTimezone(ctx.configPath ?? undefined);

  let policyStatus = coerceStr(args, "policy_status", false) as ReceiptPolicyStatus | null;
  let policyRule = coerceStr(args, "policy_rule", false);
  const policyReasonsRaw = args["policy_reasons"];
  let policyReasons: string[] | null = null;
  if (policyReasonsRaw !== undefined && policyReasonsRaw !== null) {
    if (!Array.isArray(policyReasonsRaw) || !policyReasonsRaw.every((s) => typeof s === "string")) {
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
      throw new MCPError(INVALID_PARAMS, `from_request not found: ${fromRequest}`);
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
      throw new MCPError(INVALID_PARAMS, `policy_status must be one of: ${allowed.join(", ")}`);
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
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);
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
    throw new MCPError(INVALID_PARAMS, `id not found: ${id}`);
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
      decision.policyPath !== null ? vaultRelativePath(decision.policyPath, ctx.vault) : null,
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

export const PAY_MEMORY_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "payment_memory_init",
    description:
      "Bootstrap the Pay Memory layout (policies/, payments/, assets/, drafts/, reports/) and write the spending policy template.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Agent identity (defaults to server-resolved name).",
        },
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
        agent: {
          type: "string",
          description: "Agent identity (defaults to server-resolved name).",
        },
        service: {
          type: "string",
          description: "Provider/skill identifier, e.g. 'paysponge/fal'.",
        },
        status: {
          type: "string",
          description: "Outcome of the paid call ('success', 'failed', ...).",
        },
        reason: {
          type: "string",
          description: "Why the paid call was made — short imperative sentence.",
        },
        category: { type: "string", description: "Optional category tag." },
        endpoint: { type: "string", description: "Gateway endpoint URL returned by pay-skills." },
        expected_cost: { type: "string", description: "Pre-call expected price range." },
        actual_amount: {
          type: "string",
          description: "Actual amount charged (parsed from pay-tool output).",
        },
        currency: { type: "string", description: "Currency code (e.g. 'USDC')." },
        payment_proof: { type: "string", description: "Public proof / signature / receipt id." },
        result_ref: { type: "string", description: "Generated asset URL or response id." },
        result_note: {
          type: "string",
          description: "Vault path to the asset note (wikilink target).",
        },
        raw_output: {
          type: "string",
          description: "Raw payment-tool output to persist after redaction.",
        },
        slug: {
          type: "string",
          description: "Optional slug override; default derives from service+reason.",
        },
        date: {
          type: "string",
          description: "Receipt date in YYYY-MM-DD; default = today (vault tz).",
        },
        time: {
          type: "string",
          description: "Receipt time in HH:MM 24h; default = now (vault tz).",
        },
        overwrite: { type: "boolean", description: "Allow overwriting an existing receipt." },
        policy_status: {
          type: "string",
          enum: ["allowed", "approval_required", "denied", "not_checked"],
          description:
            "Real outcome of the spending-policy check; defaults to `not_checked` and the receipt says so explicitly.",
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
          description:
            "Payment rail (default `pay.sh`). Override only when a different rail was used.",
        },
        network: {
          type: "string",
          description:
            "Settlement network (default `solana`). Override only when a different network was used.",
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
        service: {
          type: "string",
          description: "Provider/skill identifier that produced the asset.",
        },
        result_url: { type: "string", description: "URL or identifier of the generated asset." },
        source_receipt: { type: "string", description: "Vault path to the receipt note." },
        prompt: {
          type: "string",
          description: "Prompt sent to the service (rendered as a quote block).",
        },
        used_in: {
          type: "string",
          description: "Vault path of the draft/page that consumes this asset.",
        },
        slug: {
          type: "string",
          description: "Optional slug override; default derives from title.",
        },
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
    description: `Evaluate a prospective paid call against ${PAY_MEMORY_SPENDING_JSON_REL}. Returns allowed / approval_required / denied + the rule that fired.`,
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Provider/skill identifier, e.g. 'paysponge/fal'.",
        },
        expected_amount: {
          type: ["number", "string"],
          description: "Expected payment amount; numeric or numeric-string.",
        },
        currency: {
          type: "string",
          description: "Currency code; defaults to the policy currency.",
        },
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
    description: `Aggregate a date's payment receipts into a Markdown report under ${PAY_MEMORY_REPORTS_REL}/.`,
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD whose receipts will be aggregated.",
        },
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
]);
