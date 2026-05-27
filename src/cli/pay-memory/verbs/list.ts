import { defaultConfigPath } from "../../../core/config.ts";
import { listPendingRequests } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdListPendingPayments(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    status: { type: "string", default: "pending" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const status = String(flags["status"]);
  const valid = ["pending", "approved", "rejected", "consumed", "all"];
  if (!valid.includes(status)) {
    process.stderr.write(`error: --status must be one of: ${valid.join(", ")}\n`);
    return 2;
  }

  let summaries;
  try {
    summaries = listPendingRequests(vault, {
      status: status as "pending" | "approved" | "rejected" | "consumed" | "all",
    });
  } catch (exc) {
    process.stderr.write(`error: failed to list requests: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        summaries.map((s) => ({
          id: s.id,
          path: s.relativePath,
          status: s.status,
          service: s.service,
          reason: s.reason,
          expected_amount: s.expectedAmount,
          currency: s.currency,
          created: s.created,
          policy_status: s.policyStatus,
        })),
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else if (summaries.length === 0) {
    process.stdout.write(`no requests with status: ${status}\n`);
  } else {
    for (const s of summaries) {
      const cost =
        s.expectedAmount !== null && s.expectedAmount !== ""
          ? ` (${s.expectedAmount}${s.currency ? " " + s.currency : ""})`
          : "";
      process.stdout.write(`${s.status}\t${s.id}\t${s.service}${cost}\t${s.reason}\n`);
    }
  }
  return 0;
}
