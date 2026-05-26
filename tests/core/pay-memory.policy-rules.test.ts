import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkPolicy,
  evaluatePolicy,
  loadPolicyRules,
  policyJsonPath,
} from "../../src/core/pay-memory/policy-rules.ts";
import { writeReceipt } from "../../src/core/pay-memory/receipt.ts";

import {
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_PENDING_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
  PAY_MEMORY_SPENDING_JSON_REL,
  PAY_MEMORY_SPENDING_MD_REL,
} from "../../src/core/pay-memory/paths.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-policy-rules-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePolicy(rules: unknown) {
  const path = policyJsonPath(tmp);
  mkdirSync(join(tmp, PAY_MEMORY_POLICIES_REL), { recursive: true });
  writeFileSync(path, JSON.stringify(rules, null, 2), "utf8");
}

describe("loadPolicyRules", () => {
  test("returns null when file is absent", () => {
    expect(loadPolicyRules(tmp)).toBeNull();
  });

  test("parses a well-formed policy", () => {
    writePolicy({
      schema_version: 1,
      currency: "USDC",
      max_total_per_day: 0.1,
      max_single_call: 0.07,
      allowed_services: ["paysponge/fal"],
      max_per_category: { media_generation: 1 },
      require_approval_above: 0.05,
    });
    const rules = loadPolicyRules(tmp)!;
    expect(rules.currency).toBe("USDC");
    expect(rules.max_total_per_day).toBe(0.1);
    expect(rules.allowed_services).toEqual(["paysponge/fal"]);
    expect(rules.max_per_category!["media_generation"]).toBe(1);
  });

  test("rejects malformed JSON", () => {
    const path = policyJsonPath(tmp);
    mkdirSync(join(tmp, PAY_MEMORY_POLICIES_REL), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadPolicyRules(tmp)).toThrow(/not valid JSON/);
  });

  test("rejects bad types", () => {
    writePolicy({ max_total_per_day: "0.10" });
    expect(() => loadPolicyRules(tmp)).toThrow(/non-negative finite/);
  });

  test("rejects negative numbers", () => {
    writePolicy({ max_single_call: -1 });
    expect(() => loadPolicyRules(tmp)).toThrow(/non-negative/);
  });
});

describe("evaluatePolicy", () => {
  test("fail-open when no rules", () => {
    const d = evaluatePolicy(null, { service: "x/y" }, { daySpend: 0, dayCategoryCount: 0 });
    expect(d.allowed).toBe(true);
    expect(d.hasPolicy).toBe(false);
  });

  test("denies a service not in allowed_services", () => {
    const d = evaluatePolicy(
      { allowed_services: ["paysponge/fal"] },
      { service: "alpha/translate" },
      { daySpend: 0, dayCategoryCount: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("allowed_services");
    expect(d.reasons[0]).toContain("not in allowed_services");
  });

  test("denies when expected_amount > max_single_call", () => {
    const d = evaluatePolicy(
      { allowed_services: ["x/y"], max_single_call: 0.05 },
      { service: "x/y", expectedAmount: 0.1 },
      { daySpend: 0, dayCategoryCount: 0 },
    );
    expect(d.rule).toBe("max_single_call");
  });

  test("denies when day spend + expected exceeds max_total_per_day", () => {
    const d = evaluatePolicy(
      { allowed_services: ["x/y"], max_total_per_day: 0.1 },
      { service: "x/y", expectedAmount: 0.05 },
      { daySpend: 0.07, dayCategoryCount: 0 },
    );
    expect(d.rule).toBe("max_total_per_day");
  });

  test("denies when category count cap reached", () => {
    const d = evaluatePolicy(
      { allowed_services: ["x/y"], max_per_category: { media_generation: 1 } },
      { service: "x/y", category: "media_generation" },
      { daySpend: 0, dayCategoryCount: 1 },
    );
    expect(d.rule).toBe("max_per_category");
  });

  test("flags approval_required when amount > require_approval_above", () => {
    const d = evaluatePolicy(
      { require_approval_above: 0.05 },
      { service: "x/y", expectedAmount: 0.07 },
      { daySpend: 0, dayCategoryCount: 0 },
    );
    expect(d.status).toBe("approval_required");
    expect(d.approvalRequired).toBe(true);
    expect(d.rule).toBe("require_approval_above");
  });

  test("missing expected_amount triggers approval_required when amount-rules exist", () => {
    // Policy declares any amount-based rule; agent omits expectedAmount.
    // Must not fail-open — otherwise the daily budget / single-call cap /
    // approval threshold can be bypassed by simply not stating the cost.
    for (const rule of [
      { max_single_call: 0.05 },
      { max_total_per_day: 0.10 },
      { require_approval_above: 0.03 },
    ] as const) {
      const d = evaluatePolicy(
        { allowed_services: ["x/y"], ...rule },
        { service: "x/y" }, // expectedAmount omitted
        { daySpend: 0, dayCategoryCount: 0 },
      );
      expect(d.status).toBe("approval_required");
      expect(d.rule).toBe("missing_expected_amount");
    }
  });

  test("missing expected_amount stays allowed when policy has no amount-rules", () => {
    const d = evaluatePolicy(
      { allowed_services: ["x/y"] },
      { service: "x/y" },
      { daySpend: 0, dayCategoryCount: 0 },
    );
    expect(d.status).toBe("allowed");
  });

  test("currency mismatch flags as denied with currency_mismatch rule", () => {
    const d = evaluatePolicy(
      { currency: "USDC", max_single_call: 0.1 },
      { service: "x/y", expectedAmount: 0.05, currency: "EUR" },
      { daySpend: 0, dayCategoryCount: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("currency_mismatch");
  });
});

describe("checkPolicy (end-to-end)", () => {
  test("aggregates today's receipts and applies day-budget cap", () => {
    writePolicy({
      currency: "USDC",
      allowed_services: ["x/y"],
      max_total_per_day: 0.1,
    });
    // Pre-write a receipt that consumed 0.07 USDC today.
    writeReceipt(tmp, {
      agent: "h",
      service: "x/y",
      status: "success",
      reason: "earlier",
      slug: "earlier-1",
      date: "2026-05-10",
      time: "08:00",
      actualAmount: "0.07",
      currency: "USDC",
    });
    const denied = checkPolicy(tmp, {
      service: "x/y",
      expectedAmount: 0.05,
      date: "2026-05-10",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("max_total_per_day");

    const ok = checkPolicy(tmp, {
      service: "x/y",
      expectedAmount: 0.02,
      date: "2026-05-10",
    });
    expect(ok.allowed).toBe(true);
  });

  test("category counter looks at the category frontmatter", () => {
    writePolicy({
      allowed_services: ["x/y"],
      max_per_category: { media_generation: 1 },
    });
    writeReceipt(tmp, {
      agent: "h",
      service: "x/y",
      status: "success",
      reason: "first",
      slug: "first-1",
      category: "media_generation",
      date: "2026-05-10",
      time: "08:00",
    });
    const denied = checkPolicy(tmp, {
      service: "x/y",
      category: "media_generation",
      date: "2026-05-10",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("max_per_category");
  });

  test("policy_path is the JSON file when present", () => {
    writePolicy({ allowed_services: ["x/y"] });
    const d = checkPolicy(tmp, { service: "x/y" });
    expect(d.policyPath).toBe(policyJsonPath(tmp));
    expect(d.hasPolicy).toBe(true);
  });

  test("policyPath is null when no policy file exists", () => {
    const d = checkPolicy(tmp, { service: "x/y" });
    expect(d.policyPath).toBeNull();
    expect(d.hasPolicy).toBe(false);
    expect(d.allowed).toBe(true);
  });
});
