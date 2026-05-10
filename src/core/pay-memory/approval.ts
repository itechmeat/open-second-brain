/**
 * Approval workflow for paid agent actions (spec §17.6).
 *
 * Adds a `pending-payment-request` artifact under `AI Wiki/payments/_pending/`.
 * The flow is:
 *
 *   1. Agent creates a pending request (`writePendingRequest`).
 *   2. User reviews and approves/rejects (`approvePendingRequest` /
 *      `rejectPendingRequest`).
 *   3. Agent polls status (`loadPendingRequest`); on `approved`, executes
 *      the paid call via `pay`, then calls `consumePendingRequest` to mark
 *      the request as `consumed` and link the resulting receipt.
 *
 * State transitions (rejected/consumed are terminal):
 *
 *           pending  ─approve→  approved  ─consume→  consumed
 *              │
 *              └───reject→  rejected
 *
 * Policy is automatically checked at request time and the decision is
 * recorded in the frontmatter. A `denied` policy result still creates the
 * request — the user can see *why* the agent wanted to spend and override
 * the policy by approving anyway. (If you don't want this affordance,
 * pass `enforcePolicy: true` and the helper will throw before writing.)
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../vault.ts";
import {
  formatCode,
  frontmatterStr,
  nowIsoZ,
  NOT_PROVIDED,
  putIfPresent,
} from "./_md.ts";
import {
  ensureInsideVault,
  isoDateNow,
  isoTimeNow,
  isoTimestampZ,
  payMemoryDirs,
  validateIsoDate,
  validateIsoTime,
  validateSlug,
  vaultRelative,
} from "./paths.ts";
import { checkPolicy, type PolicyDecision } from "./policy-rules.ts";

export const PENDING_REQUEST_FRONTMATTER_TYPE = "pending-payment-request";

export type RequestStatus = "pending" | "approved" | "rejected" | "consumed";

export const REQUEST_STATUSES: ReadonlyArray<RequestStatus> = [
  "pending",
  "approved",
  "rejected",
  "consumed",
] as const;

export interface PendingRequestInput {
  readonly agent: string;
  readonly service: string;
  readonly reason: string;
  readonly expectedAmount?: number | null;
  readonly currency?: string | null;
  readonly category?: string | null;
  readonly endpoint?: string | null;
  readonly expectedOutput?: string | null;
  readonly vaultFiles?: ReadonlyArray<string> | null;
  readonly slug?: string | null;
  readonly date?: string | null;
  readonly time?: string | null;
  readonly tz?: string | null;
  readonly enforcePolicy?: boolean;
}

export interface PendingRequestOutput {
  readonly path: string;
  readonly relativePath: string;
  readonly id: string;
  readonly status: RequestStatus;
  readonly created: string;
  readonly policyDecision: PolicyDecision;
}

export interface PendingRequestSummary {
  readonly id: string;
  readonly path: string;
  readonly relativePath: string;
  readonly agent: string;
  readonly service: string;
  readonly reason: string;
  readonly expectedAmount: string | null;
  readonly currency: string | null;
  readonly category: string | null;
  readonly status: RequestStatus;
  readonly created: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly receipt: string | null;
  readonly policyStatus: string | null;
}

export function pendingDir(vault: string): string {
  return join(payMemoryDirs(vault).payments, "_pending");
}

export function pendingRequestPath(vault: string, id: string): string {
  return join(pendingDir(vault), `${validateSlug(id)}.md`);
}

export function writePendingRequest(
  vault: string,
  input: PendingRequestInput,
): PendingRequestOutput {
  if (!input.service?.trim()) throw new Error("pending request requires a service");
  if (!input.reason?.trim()) throw new Error("pending request requires a reason");
  if (!input.agent?.trim()) throw new Error("pending request requires an agent");

  const tz = input.tz ?? null;
  const date = validateIsoDate(input.date ?? isoDateNow(tz));
  const time = validateIsoTime(input.time ?? isoTimeNow(tz));

  const id = (input.slug && input.slug.trim()) || defaultRequestSlug(input, date, time);
  const target = pendingRequestPath(vault, id);
  ensureInsideVault(target, vault);

  // Run the policy check up-front so the request frontmatter records
  // *why* the user is being asked to approve. If `enforcePolicy` is set,
  // a `denied` outcome blocks the request from being created at all.
  const decision = checkPolicy(vault, {
    service: input.service.trim(),
    expectedAmount: input.expectedAmount ?? null,
    currency: input.currency ?? null,
    category: input.category ?? null,
    date,
    tz,
  });
  if (input.enforcePolicy && !decision.allowed && !decision.approvalRequired) {
    throw new Error(
      `policy denied: ${decision.reasons.join("; ") || decision.rule || "no reason given"}`,
    );
  }

  const created = isoTimestampZ(date, time, tz);
  const metadata: FrontmatterMap = {
    type: PENDING_REQUEST_FRONTMATTER_TYPE,
    id,
    agent: input.agent.trim(),
    service: input.service.trim(),
    reason: input.reason.trim(),
    status: "pending",
    created,
    policy_status: decision.status,
  };
  if (decision.rule) metadata["policy_rule"] = decision.rule;
  putIfPresent(metadata, "category", input.category);
  putIfPresent(metadata, "endpoint", input.endpoint);
  putIfPresent(metadata, "currency", input.currency);
  if (typeof input.expectedAmount === "number") {
    metadata["expected_amount"] = String(input.expectedAmount);
  }

  writeFrontmatterAtomic(target, metadata, renderRequestBody(input, decision), {
    overwrite: false,
    existsErrorKind: "pending request",
    vaultForRelativePath: vault,
  });

  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    id,
    status: "pending",
    created,
    policyDecision: decision,
  };
}

export interface LoadedPendingRequest {
  readonly metadata: FrontmatterMap;
  readonly body: string;
  readonly path: string;
  readonly relativePath: string;
  readonly id: string;
  readonly status: RequestStatus;
}

export function loadPendingRequest(vault: string, id: string): LoadedPendingRequest | null {
  const target = pendingRequestPath(vault, id);
  // parseFrontmatter swallows ENOENT (returns [{}, ""]) so the absent-file
  // case is naturally indistinguishable from a present-but-malformed file.
  // We disambiguate on the frontmatter `type` field below: only a real
  // pending-payment-request returns non-null.
  const [metadata, body] = parseFrontmatter(target);
  if (frontmatterStr(metadata["type"]) !== PENDING_REQUEST_FRONTMATTER_TYPE) return null;
  return {
    metadata,
    body,
    path: target,
    relativePath: vaultRelative(target, vault),
    id,
    status: parseStatus(frontmatterStr(metadata["status"])),
  };
}

export interface ListPendingRequestsOptions {
  /** Filter by status; "all" returns every request. Default "pending". */
  readonly status?: RequestStatus | "all";
}

export function listPendingRequests(
  vault: string,
  opts: ListPendingRequestsOptions = {},
): PendingRequestSummary[] {
  const dir = pendingDir(vault);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const filter = opts.status ?? "pending";
  const out: PendingRequestSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, entry.name);
    let metadata: FrontmatterMap;
    try {
      [metadata] = parseFrontmatter(full);
    } catch {
      continue;
    }
    if (frontmatterStr(metadata["type"]) !== PENDING_REQUEST_FRONTMATTER_TYPE) continue;
    const status = parseStatus(frontmatterStr(metadata["status"]));
    if (filter !== "all" && status !== filter) continue;
    out.push({
      id: frontmatterStr(metadata["id"]) || stem(entry.name),
      path: full,
      relativePath: vaultRelative(full, vault),
      agent: frontmatterStr(metadata["agent"]),
      service: frontmatterStr(metadata["service"]),
      reason: frontmatterStr(metadata["reason"]),
      expectedAmount: frontmatterStr(metadata["expected_amount"]) || null,
      currency: frontmatterStr(metadata["currency"]) || null,
      category: frontmatterStr(metadata["category"]) || null,
      status,
      created: frontmatterStr(metadata["created"]) || null,
      approvedBy: frontmatterStr(metadata["approved_by"]) || null,
      approvedAt: frontmatterStr(metadata["approved_at"]) || null,
      rejectedBy: frontmatterStr(metadata["rejected_by"]) || null,
      rejectedAt: frontmatterStr(metadata["rejected_at"]) || null,
      rejectionReason: frontmatterStr(metadata["rejection_reason"]) || null,
      receipt: frontmatterStr(metadata["receipt"]) || null,
      policyStatus: frontmatterStr(metadata["policy_status"]) || null,
    });
  }
  out.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  return out;
}

export interface ApproveOptions {
  readonly approvedBy: string;
  readonly note?: string | null;
}

export function approvePendingRequest(
  vault: string,
  id: string,
  opts: ApproveOptions,
): PendingRequestOutput {
  return transitionRequest(vault, id, "pending", "approved", (meta) => {
    meta["approved_by"] = opts.approvedBy.trim();
    meta["approved_at"] = nowIsoZ();
    if (opts.note?.trim()) meta["approval_note"] = opts.note.trim();
  });
}

export interface RejectOptions {
  readonly rejectedBy: string;
  readonly reason?: string | null;
}

export function rejectPendingRequest(
  vault: string,
  id: string,
  opts: RejectOptions,
): PendingRequestOutput {
  return transitionRequest(vault, id, "pending", "rejected", (meta) => {
    meta["rejected_by"] = opts.rejectedBy.trim();
    meta["rejected_at"] = nowIsoZ();
    if (opts.reason?.trim()) meta["rejection_reason"] = opts.reason.trim();
  });
}

export interface ConsumeOptions {
  readonly receiptPath: string;
}

export function consumePendingRequest(
  vault: string,
  id: string,
  opts: ConsumeOptions,
): PendingRequestOutput {
  return transitionRequest(vault, id, "approved", "consumed", (meta) => {
    meta["receipt"] = opts.receiptPath.trim();
    meta["consumed_at"] = nowIsoZ();
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function transitionRequest(
  vault: string,
  id: string,
  expectedFrom: RequestStatus,
  newStatus: RequestStatus,
  patch: (meta: FrontmatterMap) => void,
): PendingRequestOutput {
  const loaded = loadPendingRequest(vault, id);
  if (!loaded) {
    throw new Error(`pending request not found: ${id}`);
  }
  if (loaded.status !== expectedFrom) {
    throw new Error(
      `cannot transition request ${id} from ${loaded.status} to ${newStatus} ` +
        `(expected ${expectedFrom})`,
    );
  }
  const newMeta: FrontmatterMap = { ...loaded.metadata };
  newMeta["status"] = newStatus;
  patch(newMeta);
  writeFrontmatterAtomic(loaded.path, newMeta, loaded.body, { overwrite: true });
  return {
    path: loaded.path,
    relativePath: loaded.relativePath,
    id,
    status: newStatus,
    created: frontmatterStr(loaded.metadata["created"]),
    policyDecision: {
      status: parseDecisionStatus(frontmatterStr(loaded.metadata["policy_status"])),
      allowed: frontmatterStr(loaded.metadata["policy_status"]) === "allowed",
      approvalRequired:
        frontmatterStr(loaded.metadata["policy_status"]) === "approval_required",
      reasons: [],
      rule: frontmatterStr(loaded.metadata["policy_rule"]) || null,
      hasPolicy: Boolean(frontmatterStr(loaded.metadata["policy_status"])),
      policyPath: null,
      currency: frontmatterStr(loaded.metadata["currency"]) || null,
    },
  };
}

function defaultRequestSlug(
  input: PendingRequestInput,
  date: string,
  time: string,
): string {
  const tail = input.service.split("/").pop() ?? input.service;
  return slugify(`req-${date}-${time.replace(":", "")}-${tail}-${input.reason}`);
}

function renderRequestBody(input: PendingRequestInput, decision: PolicyDecision): string {
  const reason = input.reason.trim();
  const lines: string[] = [
    `# Pending Payment Request: ${reason}`,
    "",
    "## Service",
    "",
    formatCode(input.service),
    "",
    "## Reason",
    "",
    reason,
    "",
    "## Expected cost",
    "",
    typeof input.expectedAmount === "number"
      ? `\`${input.expectedAmount}\`${input.currency ? ` ${input.currency}` : ""}`
      : NOT_PROVIDED,
    "",
    "## Endpoint",
    "",
    formatCode(input.endpoint),
    "",
    "## Expected output",
    "",
    input.expectedOutput?.trim() ?? NOT_PROVIDED,
    "",
    "## Vault files that will change",
    "",
  ];
  if (input.vaultFiles && input.vaultFiles.length > 0) {
    for (const f of input.vaultFiles) lines.push(`- \`${f}\``);
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push(
    "",
    "## Policy check",
    "",
    `Status: \`${decision.status}\``,
  );
  if (decision.rule) lines.push(`Rule fired: \`${decision.rule}\``);
  if (decision.reasons.length > 0) {
    lines.push("", "Reasons:", "");
    for (const r of decision.reasons) lines.push(`- ${r}`);
  }
  lines.push(
    "",
    "## How to approve / reject",
    "",
    "Use the `o2b` CLI:",
    "",
    "```bash",
    `o2b approve-payment-request --vault <vault> --id <id> --approved-by <name>`,
    `o2b reject-payment-request --vault <vault> --id <id> --rejected-by <name> [--reason "..."]`,
    "```",
    "",
    "Once approved, the agent will execute the paid call and call",
    "`o2b consume-payment-request` to link the resulting receipt back here.",
  );
  return lines.join("\n");
}

function parseStatus(raw: string): RequestStatus {
  if (raw === "approved" || raw === "rejected" || raw === "consumed") return raw;
  return "pending";
}

function parseDecisionStatus(raw: string): PolicyDecision["status"] {
  if (raw === "denied" || raw === "approval_required") return raw;
  return "allowed";
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
