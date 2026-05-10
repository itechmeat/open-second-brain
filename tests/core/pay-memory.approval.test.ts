import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approvePendingRequest,
  consumePendingRequest,
  listPendingRequests,
  loadPendingRequest,
  PENDING_REQUEST_FRONTMATTER_TYPE,
  rejectPendingRequest,
  writePendingRequest,
} from "../../src/core/pay-memory/approval.ts";
import { policyJsonPath } from "../../src/core/pay-memory/policy-rules.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-approval-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseInput = {
  agent: "hermes-vps-agent",
  service: "paysponge/fal",
  reason: "Generate one blog header image",
  date: "2026-05-10",
  time: "10:00",
};

describe("writePendingRequest", () => {
  test("creates a pending-payment-request artifact with frontmatter and body", () => {
    const out = writePendingRequest(tmp, baseInput);
    expect(out.status).toBe("pending");
    expect(out.relativePath.startsWith("AI Wiki/payments/_pending/")).toBe(true);
    expect(out.id.startsWith("req-2026-05-10-1000-fal-")).toBe(true);
    expect(out.policyDecision.hasPolicy).toBe(false);

    const text = readFileSync(out.path, "utf8");
    expect(text).toContain(`type: ${PENDING_REQUEST_FRONTMATTER_TYPE}`);
    expect(text).toContain("status: pending");
    expect(text).toContain("# Pending Payment Request: Generate one blog header image");
    expect(text).toContain("o2b approve-payment-request");
  });

  test("records expected_amount + currency + endpoint when supplied", () => {
    const out = writePendingRequest(tmp, {
      ...baseInput,
      expectedAmount: 0.05,
      currency: "USDC",
      endpoint: "https://gateway.example/v1/fal",
      expectedOutput: "PNG image, 1024×512",
      vaultFiles: ["AI Wiki/drafts/post.md", "AI Wiki/assets/header.md"],
    });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("expected_amount: 0.05");
    expect(text).toContain("currency: USDC");
    expect(text).toContain("- `AI Wiki/drafts/post.md`");
    expect(text).toContain("PNG image, 1024×512");
  });

  test("records the policy decision when policies/spending.json is present", () => {
    mkdirSync(join(tmp, "AI Wiki", "policies"), { recursive: true });
    writeFileSync(
      policyJsonPath(tmp),
      JSON.stringify({ allowed_services: ["paysponge/fal"], require_approval_above: 0.04 }),
      "utf8",
    );
    const out = writePendingRequest(tmp, { ...baseInput, expectedAmount: 0.05 });
    expect(out.policyDecision.status).toBe("approval_required");
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("policy_status: approval_required");
    expect(text).toContain("Status: `approval_required`");
  });

  test("enforcePolicy=true blocks creation when policy denies", () => {
    mkdirSync(join(tmp, "AI Wiki", "policies"), { recursive: true });
    writeFileSync(
      policyJsonPath(tmp),
      JSON.stringify({ allowed_services: ["paysponge/fal"] }),
      "utf8",
    );
    expect(() =>
      writePendingRequest(tmp, {
        ...baseInput,
        service: "alpha/translate",
        enforcePolicy: true,
      }),
    ).toThrow(/policy denied/);
  });

  test("rejects missing required fields", () => {
    expect(() => writePendingRequest(tmp, { ...baseInput, service: "" })).toThrow();
    expect(() => writePendingRequest(tmp, { ...baseInput, reason: "" })).toThrow();
    expect(() => writePendingRequest(tmp, { ...baseInput, agent: "" })).toThrow();
  });

  test("refuses to overwrite an existing request id", () => {
    writePendingRequest(tmp, { ...baseInput, slug: "fixed" });
    expect(() => writePendingRequest(tmp, { ...baseInput, slug: "fixed" })).toThrow(
      /already exists/,
    );
  });
});

describe("state transitions", () => {
  test("pending → approved sets status, approved_by, approved_at", () => {
    const created = writePendingRequest(tmp, { ...baseInput, slug: "t-1" });
    const out = approvePendingRequest(tmp, "t-1", { approvedBy: "sergey", note: "ok" });
    expect(out.status).toBe("approved");
    expect(out.id).toBe("t-1");
    const reloaded = loadPendingRequest(tmp, "t-1")!;
    expect(reloaded.metadata["status"]).toBe("approved");
    expect(reloaded.metadata["approved_by"]).toBe("sergey");
    expect(reloaded.metadata["approval_note"]).toBe("ok");
    expect(typeof reloaded.metadata["approved_at"]).toBe("string");
    void created;
  });

  test("pending → rejected sets reason", () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-2" });
    rejectPendingRequest(tmp, "t-2", { rejectedBy: "sergey", reason: "too expensive" });
    const reloaded = loadPendingRequest(tmp, "t-2")!;
    expect(reloaded.metadata["status"]).toBe("rejected");
    expect(reloaded.metadata["rejection_reason"]).toBe("too expensive");
  });

  test("approve then consume requires the approved state", () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-3" });
    expect(() => consumePendingRequest(tmp, "t-3", { receiptPath: "x" })).toThrow(
      /cannot transition request t-3 from pending to consumed/,
    );
    approvePendingRequest(tmp, "t-3", { approvedBy: "sergey" });
    const out = consumePendingRequest(tmp, "t-3", {
      receiptPath: "AI Wiki/payments/2026-05-10/x.md",
    });
    expect(out.status).toBe("consumed");
    const reloaded = loadPendingRequest(tmp, "t-3")!;
    expect(reloaded.metadata["receipt"]).toBe("AI Wiki/payments/2026-05-10/x.md");
  });

  test("rejected and consumed are terminal", () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-4" });
    rejectPendingRequest(tmp, "t-4", { rejectedBy: "sergey" });
    expect(() => approvePendingRequest(tmp, "t-4", { approvedBy: "x" })).toThrow();

    writePendingRequest(tmp, { ...baseInput, slug: "t-5" });
    approvePendingRequest(tmp, "t-5", { approvedBy: "sergey" });
    consumePendingRequest(tmp, "t-5", { receiptPath: "x" });
    expect(() => consumePendingRequest(tmp, "t-5", { receiptPath: "y" })).toThrow();
  });

  test("transitioning a non-existent request throws", () => {
    expect(() => approvePendingRequest(tmp, "nope", { approvedBy: "x" })).toThrow(
      /not found/,
    );
  });
});

describe("listPendingRequests", () => {
  test("filters by status (default pending)", () => {
    writePendingRequest(tmp, { ...baseInput, slug: "p-1" });
    writePendingRequest(tmp, { ...baseInput, slug: "p-2" });
    rejectPendingRequest(tmp, "p-2", { rejectedBy: "x" });

    const pending = listPendingRequests(tmp);
    expect(pending.map((s) => s.id)).toEqual(["p-1"]);
    const all = listPendingRequests(tmp, { status: "all" });
    expect(all.map((s) => s.id).sort()).toEqual(["p-1", "p-2"]);
    const rejected = listPendingRequests(tmp, { status: "rejected" });
    expect(rejected.map((s) => s.id)).toEqual(["p-2"]);
  });

  test("returns empty when the directory is missing", () => {
    expect(listPendingRequests(tmp)).toEqual([]);
  });
});
