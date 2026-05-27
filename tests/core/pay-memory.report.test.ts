import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../../src/core/vault.ts";
import { aggregateReceipts, writeReport } from "../../src/core/pay-memory/report.ts";
import { writeReceipt } from "../../src/core/pay-memory/receipt.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-report-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseReceipt = {
  agent: "hermes-main",
  service: "paysponge/fal",
  status: "success",
  reason: "Header image",
  date: "2026-05-10",
  time: "17:20",
};

describe("aggregateReceipts", () => {
  test("returns [] when the date directory is missing", () => {
    expect(aggregateReceipts(tmp, "2026-05-10")).toEqual([]);
  });

  test("collects multiple receipts and sorts by service", () => {
    writeReceipt(tmp, {
      ...baseReceipt,
      slug: "fal-1",
      actualAmount: "0.05",
      currency: "USDC",
      resultRef: "https://fal/img1",
      resultNote: "Brain/payments/assets/img1.md",
    });
    writeReceipt(tmp, {
      ...baseReceipt,
      service: "alpha/translate",
      slug: "alpha-1",
      reason: "Translate caption",
      actualAmount: "0.02",
      currency: "USDC",
    });
    const summaries = aggregateReceipts(tmp, "2026-05-10");
    expect(summaries.length).toBe(2);
    expect(summaries[0]!.service).toBe("alpha/translate");
    expect(summaries[1]!.service).toBe("paysponge/fal");
    expect(summaries[1]!.actualAmount).toBe("0.05");
    expect(summaries[1]!.resultRef).toBe("https://fal/img1");
    expect(summaries[1]!.resultNote).toBe("Brain/payments/assets/img1.md");
  });

  test("ignores files without the receipt frontmatter type", () => {
    writeReceipt(tmp, { ...baseReceipt, slug: "real-1" });
    const dir = join(tmp, "Brain", "payments", "2026-05-10");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stray.md"), "---\ntype: note\n---\n\nNot a receipt.\n", "utf8");
    writeFileSync(join(dir, "no-frontmatter.md"), "Just a note.\n", "utf8");
    const summaries = aggregateReceipts(tmp, "2026-05-10");
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.service).toBe("paysponge/fal");
  });
});

describe("writeReport", () => {
  test("renders a report with frontmatter and per-service sections", () => {
    writeReceipt(tmp, {
      ...baseReceipt,
      slug: "fal-1",
      actualAmount: "0.05",
      currency: "USDC",
      resultRef: "https://fal/img1",
      resultNote: "Brain/payments/assets/img1.md",
    });
    const out = writeReport(tmp, {
      date: "2026-05-10",
      title: "Demo Report",
      task: "Blog post about Pay Memory",
    });
    expect(out.receiptsUsed).toBe(1);
    expect(out.relativePath.startsWith("Brain/payments/reports/")).toBe(true);

    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["type"]).toBe("payment-report");
    expect(meta["title"]).toBe("Demo Report");
    expect(meta["date"]).toBe("2026-05-10");
    expect(meta["receipts_used"]).toBe("1");
    expect(meta["task"]).toBe("Blog post about Pay Memory");
    expect(body).toContain("### paysponge/fal");
    expect(body).toContain("Amount: `0.05 USDC`");
    expect(body).toContain("[[Brain/payments/2026-05-10/fal-1]]");
    expect(body).toContain("[[Brain/payments/assets/img1]]");
  });

  test("renders gracefully when there are no receipts", () => {
    const out = writeReport(tmp, { date: "2026-05-10" });
    expect(out.receiptsUsed).toBe(0);
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("No receipts found for this date.");
  });

  test("refuses to overwrite without flag", () => {
    writeReport(tmp, { date: "2026-05-10" });
    expect(() => writeReport(tmp, { date: "2026-05-10" })).toThrow(/already exists/);
    expect(() => writeReport(tmp, { date: "2026-05-10", overwrite: true })).not.toThrow();
  });
});
