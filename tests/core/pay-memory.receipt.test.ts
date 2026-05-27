import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../../src/core/vault.ts";
import { writeReceipt } from "../../src/core/pay-memory/receipt.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-receipt-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseInput = {
  agent: "hermes-main",
  service: "paysponge/fal",
  status: "success",
  reason: "Generate one original blog header image",
  date: "2026-05-10",
  time: "17:20",
};

describe("writeReceipt", () => {
  test("writes a receipt with a default slug derived from service tail + reason", () => {
    const out = writeReceipt(tmp, baseInput);
    expect(out.date).toBe("2026-05-10");
    expect(out.created).toBe("2026-05-10T17:20:00Z");
    expect(out.slug.startsWith("fal-")).toBe(true);
    expect(out.relativePath.startsWith("Brain/payments/2026-05-10/")).toBe(true);

    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["type"]).toBe("agent-payment-receipt");
    expect(meta["agent"]).toBe("hermes-main");
    expect(meta["service"]).toBe("paysponge/fal");
    expect(meta["status"]).toBe("success");
    expect(meta["payment_layer"]).toBe("pay.sh");
    expect(meta["network"]).toBe("solana");
    expect(meta["created"]).toBe("2026-05-10T17:20:00Z");
    expect(body).toContain("# Payment Receipt: Generate one original blog header image");
    expect(body).toContain("[[Brain/payments/policies/spending]]");
  });

  test("respects an explicit slug", () => {
    const out = writeReceipt(tmp, { ...baseInput, slug: "custom-slug" });
    expect(out.slug).toBe("custom-slug");
    expect(out.path.endsWith("custom-slug.md")).toBe(true);
  });

  test("refuses to overwrite without flag, allows with overwrite=true", () => {
    writeReceipt(tmp, baseInput);
    expect(() => writeReceipt(tmp, baseInput)).toThrow(/already exists/);
    const second = writeReceipt(tmp, { ...baseInput, overwrite: true });
    expect(second.slug).toBeDefined();
  });

  test("emits optional frontmatter only when present", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      category: "media_generation",
      endpoint: "https://gateway.example/v1/fal",
      expectedCost: "$0.01-$0.07",
      actualAmount: "0.05",
      currency: "USDC",
      paymentProof: "5G3...sig",
      resultRef: "https://fal-cdn.example/abc.png",
      resultNote: "Brain/payments/assets/blog-header.md",
      rawOutput: '{"ok": true}',
    });
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["category"]).toBe("media_generation");
    expect(meta["endpoint"]).toBe("https://gateway.example/v1/fal");
    expect(meta["expected_cost"]).toBe("$0.01-$0.07");
    expect(meta["actual_amount"]).toBe("0.05");
    expect(meta["currency"]).toBe("USDC");
    expect(meta["payment_proof"]).toBe("5G3...sig");
    expect(meta["result_ref"]).toBe("https://fal-cdn.example/abc.png");
    expect(meta["result_note"]).toBe("Brain/payments/assets/blog-header.md");
    expect(body).toContain("[[Brain/payments/assets/blog-header]]");
    expect(body).toContain("`USDC`");
    expect(body).not.toContain("_(not provided)_");
  });

  test("renders placeholders for missing optional fields", () => {
    const out = writeReceipt(tmp, baseInput);
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["endpoint"]).toBeUndefined();
    expect(meta["actual_amount"]).toBeUndefined();
    expect(body).toContain("_(not provided)_");
  });

  test("redacts secrets in raw_output before writing", () => {
    const raw = [
      "request: GET /v1/foo",
      "Authorization: Bearer eyJhbGciOi.SECRET",
      'response: {"api_key": "sk_live_abc", "ok": true}',
    ].join("\n");
    const out = writeReceipt(tmp, { ...baseInput, rawOutput: raw });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("sk_live_abc");
    expect(text).not.toContain("eyJhbGciOi.SECRET");
    expect(text).toContain("/v1/foo");
  });

  test("rejects missing required fields", () => {
    expect(() => writeReceipt(tmp, { ...baseInput, service: "" })).toThrow();
    expect(() => writeReceipt(tmp, { ...baseInput, status: "" })).toThrow();
    expect(() => writeReceipt(tmp, { ...baseInput, reason: "" })).toThrow();
    expect(() => writeReceipt(tmp, { ...baseInput, agent: "" })).toThrow();
  });

  test("sanitizes brackets in resultNote wikilink", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      resultNote: "Brain/payments/assets/blog [draft].md",
    });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("[[Brain/payments/assets/blog draft]]");
    expect(text).not.toContain("[draft]]]");
  });

  test("escapes backticks in inline-code rendered fields", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      service: "weird/`inject`-svc",
      slug: "weird-1",
    });
    const text = readFileSync(out.path, "utf8");
    // Surrounding backticks must remain a single span — embedded backticks
    // are replaced with the visually similar grave-accent placeholder.
    expect(text).toContain("`weird/ˋinjectˋ-svc`");
    expect(text).not.toContain("`weird/`inject`-svc`");
  });

  test("policy_status defaults to `not_checked` and the body says so", () => {
    const out = writeReceipt(tmp, baseInput);
    const text = readFileSync(out.path, "utf8");
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["policy_status"]).toBe("not_checked");
    expect(body).toContain("Not checked.");
    // The old hardcoded "Allowed by the configured spending policy" line
    // must NOT appear when no decision was supplied — that was the
    // pre-fix lie the v0.8.0 review flagged.
    expect(text).not.toContain("Allowed by the configured spending policy");
  });

  test("policy_status='allowed' renders the explicit allowed message", () => {
    const out = writeReceipt(tmp, { ...baseInput, slug: "a-1", policyStatus: "allowed" });
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["policy_status"]).toBe("allowed");
    expect(body).toContain("Allowed by the configured spending policy");
  });

  test("approval_required renders rule + reasons + approval link", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      slug: "ar-1",
      policyStatus: "approval_required",
      policyRule: "max_single_call",
      policyReasons: ["expected amount 0.10 USDC exceeds max_single_call 0.07 USDC"],
      approvalRequestId: "req-2026-05-10-fal",
      approvalStatus: "approved",
      approvedBy: "sergey",
      approvedAt: "2026-05-10T17:25:00Z",
    });
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["policy_status"]).toBe("approval_required");
    expect(meta["policy_rule"]).toBe("max_single_call");
    expect(meta["approval_status"]).toBe("approved");
    expect(meta["approved_by"]).toBe("sergey");
    expect(body).toContain("Policy returned `approval_required`");
    expect(body).toContain("Rule fired: `max_single_call`");
    expect(body).toContain("expected amount 0.10 USDC exceeds max_single_call 0.07 USDC");
    expect(body).toContain("[[Brain/payments/_pending/req-2026-05-10-fal]]");
    expect(body).toContain("Approved by: sergey");
  });

  test("payment_layer and network override hardcoded defaults", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      slug: "rail-1",
      paymentLayer: "x402-direct",
      network: "ethereum",
    });
    const [meta] = parseFrontmatter(out.path);
    expect(meta["payment_layer"]).toBe("x402-direct");
    expect(meta["network"]).toBe("ethereum");
  });

  test("payment_layer and network defaults stay pay.sh / solana when unset", () => {
    const out = writeReceipt(tmp, { ...baseInput, slug: "rail-default" });
    const [meta] = parseFrontmatter(out.path);
    expect(meta["payment_layer"]).toBe("pay.sh");
    expect(meta["network"]).toBe("solana");
  });

  test("policy_status='denied' renders the truth — receipt records the override", () => {
    const out = writeReceipt(tmp, {
      ...baseInput,
      slug: "d-1",
      policyStatus: "denied",
      policyRule: "allowed_services",
    });
    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["policy_status"]).toBe("denied");
    expect(body).toContain("Policy returned `denied`");
    expect(body).toContain("explicitly waved the policy aside");
  });

  test("concurrent writers to the same slug: exactly one succeeds", async () => {
    // Race two writers via Promise.allSettled. Both call writeReceipt
    // synchronously inside an async wrapper, so they hit the
    // atomicCreateFileSyncExclusive path back-to-back. With the link(2)
    // semantic, one succeeds and the other receives an "already exists"
    // error — never both, never neither.
    const args = { ...baseInput, slug: "race-1" };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => writeReceipt(tmp, args)),
      Promise.resolve().then(() => writeReceipt(tmp, args)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0]!.status === "rejected") {
      expect(String(rejected[0]!.reason)).toContain("already exists");
    }
  });
});
