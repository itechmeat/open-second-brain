/**
 * Payment receipt writer.
 *
 * Builds the deterministic Markdown receipt described in the spec. Optional
 * fields fall back to a `_(not provided)_` placeholder in the body so every
 * receipt has the same set of headings and is uniformly searchable. Frontmatter
 * keys are only emitted when the input value is non-empty — this keeps the
 * report aggregator simple (presence == relevant) and avoids littering the
 * vault with empty quoted strings.
 */

import type { FrontmatterMap } from "../types.ts";
import { slugify, writeFrontmatterAtomic } from "../vault.ts";
import {
  formatCode,
  NOT_PROVIDED,
  putIfPresent,
  sanitizeWikilinkTarget,
  stripMarkdownExt,
} from "./_md.ts";
import {
  ensureInsideVault,
  isoDateNow,
  isoTimeNow,
  isoTimestampZ,
  receiptPath,
  validateIsoDate,
  validateIsoTime,
  vaultRelative,
} from "./paths.ts";
import { redactRawOutput } from "./redactor.ts";
import type { ReceiptInput, ReceiptOutput } from "./types.ts";

export const RECEIPT_FRONTMATTER_TYPE = "agent-payment-receipt";

export function writeReceipt(vault: string, input: ReceiptInput): ReceiptOutput {
  if (!input.service?.trim()) throw new Error("receipt requires a service");
  if (!input.status?.trim()) throw new Error("receipt requires a status");
  if (!input.reason?.trim()) throw new Error("receipt requires a reason");
  if (!input.agent?.trim()) throw new Error("receipt requires an agent");

  const tz = input.tz ?? null;
  const date = validateIsoDate(input.date ?? isoDateNow(tz));
  const time = validateIsoTime(input.time ?? isoTimeNow(tz));
  const slug = (input.slug && input.slug.trim()) || defaultReceiptSlug(input.service, input.reason);

  const target = receiptPath(vault, date, slug);
  ensureInsideVault(target, vault);

  const created = isoTimestampZ(date, time, tz);
  const paymentLayer = input.paymentLayer?.trim() || "pay.sh";
  const network = input.network?.trim() || "solana";
  const metadata: FrontmatterMap = {
    type: RECEIPT_FRONTMATTER_TYPE,
    agent: input.agent.trim(),
    payment_layer: paymentLayer,
    network,
    service: input.service.trim(),
    status: input.status.trim(),
    reason: input.reason.trim(),
    created,
  };
  if (tz) metadata["timezone"] = tz;
  putIfPresent(metadata, "category", input.category);
  putIfPresent(metadata, "endpoint", input.endpoint);
  putIfPresent(metadata, "expected_cost", input.expectedCost);
  putIfPresent(metadata, "actual_amount", input.actualAmount);
  putIfPresent(metadata, "currency", input.currency);
  putIfPresent(metadata, "payment_proof", input.paymentProof);
  putIfPresent(metadata, "result_ref", input.resultRef);
  putIfPresent(metadata, "result_note", input.resultNote);

  // Policy + approval audit fields. Always emit `policy_status` so a
  // human reading the receipt can tell the difference between "we
  // checked and it was allowed" and "we never checked" — the latter is
  // not a problem in itself, but it must not masquerade as the former.
  metadata["policy_status"] = input.policyStatus ?? "not_checked";
  putIfPresent(metadata, "policy_rule", input.policyRule);
  if (input.policyReasons && input.policyReasons.length > 0) {
    metadata["policy_reasons"] = [...input.policyReasons];
  }
  putIfPresent(metadata, "policy_checked_at", input.policyCheckedAt);
  putIfPresent(metadata, "approval_request", input.approvalRequestId);
  putIfPresent(metadata, "approval_status", input.approvalStatus);
  putIfPresent(metadata, "approved_by", input.approvedBy);
  putIfPresent(metadata, "approved_at", input.approvedAt);

  const body = renderReceiptBody(input);
  writeFrontmatterAtomic(target, metadata, body, {
    overwrite: input.overwrite,
    existsErrorKind: "receipt",
    vaultForRelativePath: vault,
  });

  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    date,
    created,
  };
}

function defaultReceiptSlug(service: string, reason: string): string {
  const tail = service.split("/").pop() ?? service;
  return slugify(`${tail}-${reason}`);
}

/**
 * Render the body of the "Spending policy check" section. The previous
 * version always claimed the policy approved the call — which is a lie
 * when the caller never ran a policy check at all, when the check
 * returned `denied`, or when the call was waved through by a human
 * after `approval_required`. This version shows the real state.
 */
function renderPolicySection(input: ReceiptInput): string[] {
  const status = input.policyStatus ?? "not_checked";
  const out: string[] = ["Decision:", ""];
  switch (status) {
    case "allowed":
      out.push(
        "Allowed by the configured spending policy. The agent ran a policy",
        "check before initiating this paid call.",
      );
      break;
    case "approval_required":
      out.push(
        "Policy returned `approval_required` — a human approval was needed",
        "before initiating this paid call.",
      );
      break;
    case "denied":
      out.push(
        "Policy returned `denied` — this receipt records a paid call that",
        "the policy did not approve. If the call still proceeded, a human",
        "explicitly waved the policy aside; check the approval section",
        "below for who and why.",
      );
      break;
    case "not_checked":
    default:
      out.push(
        "Not checked. The receipt was created without a policy decision —",
        "either no `Brain/payments/policies/spending.json` is configured, or the",
        "caller chose not to evaluate the policy. This is *not* a claim",
        "that the call was allowed.",
      );
      break;
  }
  if (input.policyRule?.trim()) {
    out.push("", `Rule fired: \`${input.policyRule.trim()}\``);
  }
  if (input.policyReasons && input.policyReasons.length > 0) {
    out.push("", "Reasons:", "");
    for (const r of input.policyReasons) out.push(`- ${r}`);
  }
  if (input.policyCheckedAt?.trim()) {
    out.push("", `Policy checked at: \`${input.policyCheckedAt.trim()}\``);
  }
  if (
    input.approvalRequestId?.trim() ||
    input.approvalStatus?.trim() ||
    input.approvedBy?.trim()
  ) {
    out.push("", "Approval:");
    if (input.approvalRequestId?.trim()) {
      out.push(
        "",
        `Request: [[Brain/payments/_pending/${input.approvalRequestId.trim()}]]`,
      );
    }
    if (input.approvalStatus?.trim()) {
      out.push(`Status: \`${input.approvalStatus.trim()}\``);
    }
    if (input.approvedBy?.trim()) {
      out.push(`Approved by: ${input.approvedBy.trim()}`);
    }
    if (input.approvedAt?.trim()) {
      out.push(`Approved at: \`${input.approvedAt.trim()}\``);
    }
  }
  out.push("");
  return out;
}

function fieldOrPlaceholder(value: string | null | undefined): string {
  if (value === null || value === undefined) return NOT_PROVIDED;
  const trimmed = String(value).trim();
  return trimmed || NOT_PROVIDED;
}

function renderReceiptBody(input: ReceiptInput): string {
  const reason = input.reason.trim();
  const title = `Payment Receipt: ${reason}`;
  const resultNote = input.resultNote?.trim();
  const resultNoteLine = resultNote
    ? `[[${stripMarkdownExt(sanitizeWikilinkTarget(resultNote))}]]`
    : NOT_PROVIDED;
  const rawOutput = input.rawOutput ? redactRawOutput(input.rawOutput) : null;

  const lines: string[] = [
    `# ${title}`,
    "",
    "## Why this paid call was made",
    "",
    reason,
    "",
    "## Spending policy check",
    "",
    "Policy file:",
    "",
    "[[Brain/payments/policies/spending]]",
    "",
    ...renderPolicySection(input),
    "## Expected cost",
    "",
    fieldOrPlaceholder(input.expectedCost),
    "",
    "## Request",
    "",
    "Service:",
    "",
    formatCode(input.service),
    "",
    "Endpoint:",
    "",
    formatCode(input.endpoint),
    "",
    "Reason:",
    "",
    reason,
    "",
    "## Payment",
    "",
    "Amount:",
    "",
    formatCode(input.actualAmount),
    "",
    "Currency:",
    "",
    formatCode(input.currency),
    "",
    "Payment proof / transaction / receipt:",
    "",
    formatCode(input.paymentProof),
    "",
    "## Result",
    "",
    "Generated asset:",
    "",
    formatCode(input.resultRef),
    "",
    "Asset note:",
    "",
    resultNoteLine,
    "",
    "## Raw pay.sh output",
    "",
  ];
  if (rawOutput) {
    lines.push("```text", rawOutput.replace(/\r\n?/g, "\n").replace(/\s+$/g, ""), "```");
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push(
    "",
    "> Verify raw output above does not contain credentials before sharing this",
    "> receipt outside the vault. Best-effort redaction has been applied.",
  );
  return lines.join("\n");
}

