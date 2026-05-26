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
    expect(out.relativePath.startsWith("Brain/payments/_pending/")).toBe(true);
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
      vaultFiles: ["Brain/payments/drafts/post.md", "Brain/payments/assets/header.md"],
    });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("expected_amount: 0.05");
    expect(text).toContain("currency: USDC");
    expect(text).toContain("- `Brain/payments/drafts/post.md`");
    expect(text).toContain("PNG image, 1024×512");
  });

  test("records the policy decision when policies/spending.json is present", () => {
    mkdirSync(join(tmp, "Brain", "payments", "policies"), { recursive: true });
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
    mkdirSync(join(tmp, "Brain", "payments", "policies"), { recursive: true });
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
  test("pending → approved sets status, approved_by, approved_at", async () => {
    const created = writePendingRequest(tmp, { ...baseInput, slug: "t-1" });
    const out = await approvePendingRequest(tmp, "t-1", { approvedBy: "sergey", note: "ok" });
    expect(out.status).toBe("approved");
    expect(out.id).toBe("t-1");
    const reloaded = loadPendingRequest(tmp, "t-1")!;
    expect(reloaded.metadata["status"]).toBe("approved");
    expect(reloaded.metadata["approved_by"]).toBe("sergey");
    expect(reloaded.metadata["approval_note"]).toBe("ok");
    expect(typeof reloaded.metadata["approved_at"]).toBe("string");
    void created;
  });

  test("pending → rejected sets reason", async () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-2" });
    await rejectPendingRequest(tmp, "t-2", { rejectedBy: "sergey", reason: "too expensive" });
    const reloaded = loadPendingRequest(tmp, "t-2")!;
    expect(reloaded.metadata["status"]).toBe("rejected");
    expect(reloaded.metadata["rejection_reason"]).toBe("too expensive");
  });

  test("approve then consume requires the approved state", async () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-3" });
    await expect(
      consumePendingRequest(tmp, "t-3", { receiptPath: "x" }),
    ).rejects.toThrow(/cannot transition request t-3 from pending to consumed/);
    await approvePendingRequest(tmp, "t-3", { approvedBy: "sergey" });
    const out = await consumePendingRequest(tmp, "t-3", {
      receiptPath: "Brain/payments/2026-05-10/x.md",
    });
    expect(out.status).toBe("consumed");
    const reloaded = loadPendingRequest(tmp, "t-3")!;
    expect(reloaded.metadata["receipt"]).toBe("Brain/payments/2026-05-10/x.md");
  });

  test("rejected and consumed are terminal", async () => {
    writePendingRequest(tmp, { ...baseInput, slug: "t-4" });
    await rejectPendingRequest(tmp, "t-4", { rejectedBy: "sergey" });
    await expect(
      approvePendingRequest(tmp, "t-4", { approvedBy: "x" }),
    ).rejects.toThrow();

    writePendingRequest(tmp, { ...baseInput, slug: "t-5" });
    await approvePendingRequest(tmp, "t-5", { approvedBy: "sergey" });
    await consumePendingRequest(tmp, "t-5", { receiptPath: "x" });
    await expect(
      consumePendingRequest(tmp, "t-5", { receiptPath: "y" }),
    ).rejects.toThrow();
  });

  test("transitioning a non-existent request throws", async () => {
    await expect(
      approvePendingRequest(tmp, "nope", { approvedBy: "x" }),
    ).rejects.toThrow(/not found/);
  });

  test("concurrent approve+reject on the same id: exactly one transition wins", async () => {
    // The race the v0.8.0 review flagged: two processes both read
    // `pending`, both pass the check, both write — last writer wins.
    // With the per-request lockfile the second transition observes the
    // first one's terminal state and is rejected.
    writePendingRequest(tmp, { ...baseInput, slug: "race-1" });
    const results = await Promise.allSettled([
      approvePendingRequest(tmp, "race-1", { approvedBy: "sergey" }),
      rejectPendingRequest(tmp, "race-1", { rejectedBy: "sergey" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    if (failed[0]!.status === "rejected") {
      expect(String(failed[0]!.reason)).toMatch(/cannot transition/);
    }
  });
});

describe("listPendingRequests", () => {
  test("filters by status (default pending)", async () => {
    writePendingRequest(tmp, { ...baseInput, slug: "p-1" });
    writePendingRequest(tmp, { ...baseInput, slug: "p-2" });
    await rejectPendingRequest(tmp, "p-2", { rejectedBy: "x" });

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
