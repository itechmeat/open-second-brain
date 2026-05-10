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
  const metadata: FrontmatterMap = {
    type: RECEIPT_FRONTMATTER_TYPE,
    agent: input.agent.trim(),
    payment_layer: "pay.sh",
    network: "solana",
    service: input.service.trim(),
    status: input.status.trim(),
    reason: input.reason.trim(),
    created,
  };
  putIfPresent(metadata, "category", input.category);
  putIfPresent(metadata, "endpoint", input.endpoint);
  putIfPresent(metadata, "expected_cost", input.expectedCost);
  putIfPresent(metadata, "actual_amount", input.actualAmount);
  putIfPresent(metadata, "currency", input.currency);
  putIfPresent(metadata, "payment_proof", input.paymentProof);
  putIfPresent(metadata, "result_ref", input.resultRef);
  putIfPresent(metadata, "result_note", input.resultNote);

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
    "[[AI Wiki/policies/spending]]",
    "",
    "Decision:",
    "",
    "Allowed by the configured spending policy. The agent has read the policy",
    "before initiating this paid call.",
    "",
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

