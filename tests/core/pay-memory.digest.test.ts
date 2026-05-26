import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPaymentDigest,
  DIGEST_SILENT_TOKEN,
  renderPaymentDigestTelegram,
} from "../../src/core/pay-memory/digest.ts";
import { writeReceipt } from "../../src/core/pay-memory/receipt.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-digest-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseInput = {
  agent: "h",
  status: "success",
  reason: "demo",
  date: "2026-05-10",
  time: "10:00",
};

describe("buildPaymentDigest", () => {
  test("empty when no receipts", () => {
    const d = buildPaymentDigest(tmp, { date: "2026-05-10" });
    expect(d.receipts).toBe(0);
    expect(d.services).toBe(0);
    expect(d.totalAmount).toBeNull();
    expect(d.currency).toBeNull();
  });

  test("counts unique services and sums same-currency amounts", () => {
    writeReceipt(tmp, {
      ...baseInput, service: "paysponge/fal", slug: "f1",
      actualAmount: "0.05", currency: "USDC",
    });
    writeReceipt(tmp, {
      ...baseInput, service: "paysponge/fal", slug: "f2",
      actualAmount: "0.02", currency: "USDC", reason: "demo-2",
    });
    writeReceipt(tmp, {
      ...baseInput, service: "alpha/translate", slug: "a1",
      actualAmount: "0.01", currency: "USDC", reason: "demo-3",
    });
    const d = buildPaymentDigest(tmp, { date: "2026-05-10" });
    expect(d.receipts).toBe(3);
    expect(d.services).toBe(2);
    expect(d.totalAmount).toBeCloseTo(0.08, 6);
    expect(d.currency).toBe("USDC");
  });

  test("totalAmount=null when receipts mix currencies", () => {
    writeReceipt(tmp, {
      ...baseInput, service: "x/y", slug: "u1",
      actualAmount: "0.05", currency: "USDC",
    });
    writeReceipt(tmp, {
      ...baseInput, service: "x/y", slug: "u2",
      actualAmount: "1.0", currency: "EUR", reason: "demo-2",
    });
    const d = buildPaymentDigest(tmp, { date: "2026-05-10" });
    expect(d.receipts).toBe(2);
    // Mixed-currency days do not produce a unitless numeric sum — both
    // total and currency are null so the renderer falls back to "—".
    expect(d.totalAmount).toBeNull();
    expect(d.currency).toBeNull();
  });

  test("ignores receipts without actual_amount", () => {
    writeReceipt(tmp, { ...baseInput, service: "x/y", slug: "n1" });
    const d = buildPaymentDigest(tmp, { date: "2026-05-10" });
    expect(d.receipts).toBe(1);
    expect(d.totalAmount).toBeNull();
  });
});

describe("renderPaymentDigestTelegram", () => {
  test("renders the 4-line Russian summary", () => {
    const text = renderPaymentDigestTelegram({
      date: "2026-05-10",
      services: 2,
      receipts: 3,
      totalAmount: 0.08,
      currency: "USDC",
      reportPath: "Brain/payments/reports/payment-report-2026-05-10.md",
    });
    expect(text).toContain("💳 Оплачено сервисов: **2**");
    expect(text).toContain("💰 Сумма: **0.08 USDC**");
    expect(text).toContain("📁 Файлы чеков: **3**");
    expect(text).toContain(
      "🔗 Отчёт: `Brain/payments/reports/payment-report-2026-05-10.md`",
    );
  });

  test("emits [SILENT] when receipts == 0 in default mode", () => {
    const text = renderPaymentDigestTelegram({
      date: "x", services: 0, receipts: 0, totalAmount: null, currency: null,
    });
    expect(text).toBe(DIGEST_SILENT_TOKEN);
  });

  test("emits empty string with emptyMode=empty", () => {
    const text = renderPaymentDigestTelegram(
      { date: "x", services: 0, receipts: 0, totalAmount: null, currency: null },
      { emptyMode: "empty" },
    );
    expect(text).toBe("");
  });

  test("emits human summary with emptyMode=summary", () => {
    const text = renderPaymentDigestTelegram(
      { date: "2026-05-10", services: 0, receipts: 0, totalAmount: null, currency: null },
      { emptyMode: "summary" },
    );
    expect(text).toContain("нет чеков за 2026-05-10");
  });

  test("trims trailing zeros in amount formatting", () => {
    const text = renderPaymentDigestTelegram({
      date: "x", services: 1, receipts: 1, totalAmount: 0.5, currency: "USDC",
    });
    expect(text).toContain("💰 Сумма: **0.5 USDC**");
  });

  test("falls back to dash when totalAmount is null but receipts > 0", () => {
    const text = renderPaymentDigestTelegram({
      date: "x", services: 1, receipts: 1, totalAmount: null, currency: null,
    });
    expect(text).toContain("💰 Сумма: **—**");
  });
});
