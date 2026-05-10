/**
 * Payment digest builder — a small structured summary of a date's receipts
 * suitable for Telegram / Slack delivery via Hermes cron `--script` jobs.
 *
 * Pure functions only: the CLI command and the standalone digest helper
 * both consume `buildPaymentDigest` and `renderPaymentDigestTelegram` so
 * the formatting stays consistent between scripted (cron) and interactive
 * (`o2b payment-digest`) use.
 */

import { aggregateReceipts } from "./report.ts";
import { isoDateNow, validateIsoDate } from "./paths.ts";

export interface PaymentDigest {
  readonly date: string;
  /** Distinct `service` field values across the day's receipts. */
  readonly services: number;
  /** Total receipt count (one per `<slug>.md`). */
  readonly receipts: number;
  /** Sum of `actual_amount` across receipts that share a single currency. */
  readonly totalAmount: number | null;
  /**
   * Currency string when all receipts agree; `null` when there are no
   * receipts with `actual_amount` or when currencies are mixed.
   */
  readonly currency: string | null;
  /** Optional vault-relative path to the report referenced in the digest. */
  readonly reportPath?: string | null;
}

export interface BuildPaymentDigestOptions {
  /** YYYY-MM-DD; defaults to today in `tz`. */
  readonly date?: string | null;
  readonly tz?: string | null;
  /** Optional vault-relative path to attach in the rendered digest. */
  readonly reportPath?: string | null;
}

export function buildPaymentDigest(
  vault: string,
  opts: BuildPaymentDigestOptions = {},
): PaymentDigest {
  const date = validateIsoDate(opts.date ?? isoDateNow(opts.tz));
  const summaries = aggregateReceipts(vault, date);

  const services = new Set(summaries.map((s) => s.service)).size;

  let totalAmount: number | null = null;
  let currency: string | null = null;
  let consistentCurrency: string | null | undefined = undefined;
  let mixedCurrency = false;
  let sum = 0;
  let counted = 0;
  for (const s of summaries) {
    if (!s.actualAmount) continue;
    const n = parseFloat(s.actualAmount);
    if (!Number.isFinite(n)) continue;
    sum += n;
    counted += 1;
    if (consistentCurrency === undefined) {
      consistentCurrency = s.currency;
    } else if (consistentCurrency !== s.currency) {
      consistentCurrency = null;
      mixedCurrency = true;
    }
  }
  if (counted > 0 && !mixedCurrency) {
    // Only emit a numeric total when every receipt shares a single
    // currency. Summing values across different currencies and reporting
    // the sum without a unit is misleading — the renderer will fall back
    // to the "—" placeholder so the user knows the day was mixed.
    totalAmount = sum;
    currency = consistentCurrency ?? null;
  }

  return {
    date,
    services,
    receipts: summaries.length,
    totalAmount,
    currency,
    reportPath: opts.reportPath ?? null,
  };
}

const SILENT_TOKEN = "[SILENT]";

export interface RenderDigestOptions {
  /**
   * What to emit when the digest has zero receipts. `"silent"` (default)
   * returns the literal `[SILENT]` token so a Hermes cron deliverer that
   * recognises it can suppress the message. `"empty"` returns an empty
   * string. `"summary"` returns a single-line "no receipts" notice.
   */
  readonly emptyMode?: "silent" | "empty" | "summary";
}

export function renderPaymentDigestTelegram(
  digest: PaymentDigest,
  opts: RenderDigestOptions = {},
): string {
  const emptyMode = opts.emptyMode ?? "silent";
  if (digest.receipts === 0) {
    if (emptyMode === "empty") return "";
    if (emptyMode === "summary") return `📭 Pay Memory: нет чеков за ${digest.date}.`;
    return SILENT_TOKEN;
  }

  const lines: string[] = [
    `💳 Оплачено сервисов: **${digest.services}**`,
  ];
  if (digest.totalAmount !== null) {
    const amount = formatAmount(digest.totalAmount);
    const cur = digest.currency ?? "?";
    lines.push(`💰 Сумма: **${amount}${cur === "?" ? "" : " " + cur}**`);
  } else {
    lines.push(`💰 Сумма: **—**`);
  }
  lines.push(`📁 Файлы чеков: **${digest.receipts}**`);
  if (digest.reportPath) {
    lines.push(`🔗 Отчёт: \`${digest.reportPath}\``);
  }
  return lines.join("\n");
}

function formatAmount(n: number): string {
  // Trim trailing zeros after the decimal but keep meaningful precision.
  const fixed = n.toFixed(6);
  return fixed.replace(/\.?0+$/, "") || "0";
}

export const DIGEST_SILENT_TOKEN = SILENT_TOKEN;
