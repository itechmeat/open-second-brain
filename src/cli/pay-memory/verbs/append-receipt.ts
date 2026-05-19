import { readFileSync } from "node:fs";

import { defaultConfigPath, resolveAgentName, resolveTimezone } from "../../../core/config.ts";
import { loadPendingRequest, writeReceipt } from "../../../core/pay-memory/index.ts";
import type { ReceiptPolicyStatus } from "../../../core/pay-memory/types.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdAppendPaymentReceipt(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    service: { type: "string", required: true },
    status: { type: "string", required: true },
    reason: { type: "string", required: true },
    category: { type: "string" },
    endpoint: { type: "string" },
    "expected-cost": { type: "string" },
    "actual-amount": { type: "string" },
    currency: { type: "string" },
    "payment-proof": { type: "string" },
    "result-ref": { type: "string" },
    "result-note": { type: "string" },
    "raw-output-file": { type: "string" },
    slug: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
    "policy-status": { type: "string" },
    "policy-rule": { type: "string" },
    "policy-reasons": { type: "string-array" },
    "policy-checked-at": { type: "string" },
    "from-request": { type: "string" },
    "payment-layer": { type: "string" },
    network: { type: "string" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const tz = resolveTimezone(config);

  let rawOutput: string | undefined;
  const rawOutputFile = flags["raw-output-file"] as string | undefined;
  if (rawOutputFile) {
    try {
      rawOutput = readFileSync(rawOutputFile, "utf8");
    } catch (exc) {
      process.stderr.write(
        `error: cannot read raw-output-file: ${(exc as Error).message ?? exc}\n`,
      );
      return 1;
    }
  }

  let policyStatus = (flags["policy-status"] as string | undefined) ?? null;
  let policyRule = (flags["policy-rule"] as string | undefined) ?? null;
  let policyReasons = (flags["policy-reasons"] as string[] | undefined) ?? null;
  let policyCheckedAt =
    (flags["policy-checked-at"] as string | undefined) ?? null;
  let approvalStatus: string | null = null;
  let approvedBy: string | null = null;
  let approvedAt: string | null = null;
  const fromRequest = (flags["from-request"] as string | undefined) ?? null;
  if (fromRequest) {
    const loaded = loadPendingRequest(vault, fromRequest);
    if (!loaded) {
      process.stderr.write(`error: pending request not found: ${fromRequest}\n`);
      return 1;
    }
    const meta = loaded.metadata;
    const get = (k: string): string | null => {
      const v = meta[k];
      if (v === undefined || v === null) return null;
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    policyStatus ??= get("policy_status");
    policyRule ??= get("policy_rule");
    approvalStatus ??= loaded.status;
    approvedBy ??= get("approved_by");
    approvedAt ??= get("approved_at");
  }
  if (policyStatus !== null) {
    const allowed: ReadonlyArray<ReceiptPolicyStatus> = [
      "allowed",
      "approval_required",
      "denied",
      "not_checked",
    ];
    if (!allowed.includes(policyStatus as ReceiptPolicyStatus)) {
      process.stderr.write(
        `error: --policy-status must be one of: ${allowed.join(", ")}\n`,
      );
      return 2;
    }
  }

  let result;
  try {
    result = writeReceipt(vault, {
      agent,
      service: String(flags["service"]),
      status: String(flags["status"]),
      reason: String(flags["reason"]),
      paymentLayer: (flags["payment-layer"] as string | undefined) ?? null,
      network: (flags["network"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      endpoint: (flags["endpoint"] as string | undefined) ?? null,
      expectedCost: (flags["expected-cost"] as string | undefined) ?? null,
      actualAmount: (flags["actual-amount"] as string | undefined) ?? null,
      currency: (flags["currency"] as string | undefined) ?? null,
      paymentProof: (flags["payment-proof"] as string | undefined) ?? null,
      resultRef: (flags["result-ref"] as string | undefined) ?? null,
      resultNote: (flags["result-note"] as string | undefined) ?? null,
      rawOutput: rawOutput ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      time: (flags["time"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
      tz,
      policyStatus: policyStatus as ReceiptPolicyStatus | null,
      policyRule,
      policyReasons,
      policyCheckedAt,
      approvalRequestId: fromRequest,
      approvalStatus: approvalStatus as
        | "pending"
        | "approved"
        | "rejected"
        | "consumed"
        | null,
      approvedBy,
      approvedAt,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write receipt: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          path: result.relativePath,
          absolute_path: result.path,
          slug: result.slug,
          date: result.date,
          created: result.created,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`receipt: ${result.relativePath}\n`);
    process.stdout.write(`slug: ${result.slug}\n`);
    process.stdout.write(`date: ${result.date}\n`);
  }
  return 0;
}
