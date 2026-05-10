/**
 * Daily payment report aggregator.
 *
 * `aggregateReceipts` walks `<vault>/AI Wiki/payments/<date>/`, parses each
 * `.md` file's frontmatter, and returns the receipts that match the expected
 * `type: agent-payment-receipt` shape. `writeReport` then renders a Markdown
 * summary into `<vault>/AI Wiki/reports/<slug>.md`.
 *
 * Receipts whose frontmatter cannot be parsed (or whose `type` is missing)
 * are silently skipped — the report is best-effort and meant to surface
 * what is recordable, not to fail the whole task because one file was edited
 * by hand.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap, FrontmatterValue } from "../types.ts";
import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../vault.ts";
import {
  frontmatterStr,
  nowIsoZ,
  NOT_PROVIDED,
  stripMarkdownExt,
} from "./_md.ts";
import {
  ensureInsideVault,
  paymentsDateDir,
  reportPath,
  validateIsoDate,
  vaultRelative,
} from "./paths.ts";
import { RECEIPT_FRONTMATTER_TYPE } from "./receipt.ts";
import type { PaymentReceiptSummary, ReportInput, ReportOutput } from "./types.ts";

export const REPORT_FRONTMATTER_TYPE = "payment-report";

export function aggregateReceipts(vault: string, date: string): PaymentReceiptSummary[] {
  const dir = paymentsDateDir(vault, date);
  // No existsSync pre-check — readdirSync on a missing directory throws
  // ENOENT cleanly and saves a stat. Race-free in the same way as
  // try/catch on readFile.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const summaries: PaymentReceiptSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, entry.name);
    let meta: FrontmatterMap;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    if (frontmatterStr(meta["type"]) !== RECEIPT_FRONTMATTER_TYPE) continue;
    const service = frontmatterStr(meta["service"]);
    const status = frontmatterStr(meta["status"]);
    if (!service || !status) continue;
    summaries.push({
      path: vaultRelative(full, vault),
      service,
      status,
      category: frontmatterStr(meta["category"]) || null,
      actualAmount: frontmatterStr(meta["actual_amount"]) || null,
      currency: frontmatterStr(meta["currency"]) || null,
      resultRef: frontmatterStr(meta["result_ref"]) || null,
      resultNote: frontmatterStr(meta["result_note"]) || null,
      reason: frontmatterStr(meta["reason"]) || null,
    });
  }
  // Stable order across platforms: by service, then by relative path.
  summaries.sort((a, b) => {
    const s = a.service.localeCompare(b.service);
    return s !== 0 ? s : a.path.localeCompare(b.path);
  });
  return summaries;
}

export function writeReport(vault: string, input: ReportInput): ReportOutput {
  const date = validateIsoDate(input.date);
  const title = (input.title && input.title.trim()) || `Payment Report ${date}`;
  const slug = (input.slug && input.slug.trim()) || slugify(`payment-report-${date}`);

  const target = reportPath(vault, slug);
  ensureInsideVault(target, vault);

  const summaries = aggregateReceipts(vault, date);
  const created = nowIsoZ();

  const metadata: FrontmatterMap = {
    type: REPORT_FRONTMATTER_TYPE,
    title,
    date,
    created,
    receipts_used: summaries.length as FrontmatterValue,
  };
  if (input.task?.trim()) metadata["task"] = input.task.trim();

  writeFrontmatterAtomic(
    target,
    metadata,
    renderReportBody(date, title, input.task ?? null, summaries),
    {
      overwrite: input.overwrite,
      existsErrorKind: "report",
      vaultForRelativePath: vault,
    },
  );

  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    receiptsUsed: summaries.length,
  };
}

function renderReportBody(
  date: string,
  title: string,
  task: string | null,
  summaries: PaymentReceiptSummary[],
): string {
  const lines: string[] = [`# ${title}`, "", `Date: ${date}`, ""];

  lines.push("## Task", "");
  lines.push(task && task.trim() ? task.trim() : NOT_PROVIDED);
  lines.push("");

  lines.push("## Paid services used", "");
  if (summaries.length === 0) {
    lines.push("No receipts found for this date.");
  } else {
    for (const s of summaries) {
      lines.push(`### ${s.service}`, "");
      lines.push(`Status: \`${s.status}\``);
      if (s.reason) lines.push(`Reason: ${s.reason}`);
      lines.push(`Receipt: [[${stripMarkdownExt(s.path)}]]`);
      if (s.actualAmount) {
        const amount = s.currency ? `${s.actualAmount} ${s.currency}` : s.actualAmount;
        lines.push(`Amount: \`${amount}\``);
      }
      if (s.resultRef) lines.push(`Result: \`${s.resultRef}\``);
      if (s.resultNote) lines.push(`Asset: [[${stripMarkdownExt(s.resultNote)}]]`);
      lines.push("");
    }
  }

  lines.push("## Files", "");
  if (summaries.length === 0) {
    lines.push(NOT_PROVIDED);
  } else {
    for (const s of summaries) {
      lines.push(`- [[${stripMarkdownExt(s.path)}]]`);
      if (s.resultNote) lines.push(`- [[${stripMarkdownExt(s.resultNote)}]]`);
    }
  }
  return lines.join("\n");
}

