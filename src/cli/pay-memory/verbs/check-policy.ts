import { defaultConfigPath, resolveTimezone } from "../../../core/config.ts";
import { checkPolicy } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseOptionalNumberFlag } from "../../coerce.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdCheckPaymentPolicy(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    service: { type: "string", required: true },
    "expected-amount": { type: "string" },
    currency: { type: "string" },
    category: { type: "string" },
    date: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const tz = resolveTimezone(config);

  const { value: expectedAmount, error: expectedErr } = parseOptionalNumberFlag(
    flags,
    "expected-amount",
  );
  if (expectedErr) {
    process.stderr.write(`error: ${expectedErr}\n`);
    return 2;
  }

  let decision;
  try {
    decision = checkPolicy(vault, {
      service: String(flags["service"]),
      expectedAmount,
      currency: (flags["currency"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      tz,
    });
  } catch (exc) {
    process.stderr.write(`error: failed to evaluate policy: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          status: decision.status,
          allowed: decision.allowed,
          approval_required: decision.approvalRequired,
          rule: decision.rule,
          reasons: decision.reasons,
          has_policy: decision.hasPolicy,
          policy_path:
            decision.policyPath !== null
              ? decision.policyPath.slice(vault.length).replace(/^\/+/, "")
              : null,
          currency: decision.currency,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`status: ${decision.status}\n`);
    process.stdout.write(`has_policy: ${decision.hasPolicy}\n`);
    if (decision.rule) process.stdout.write(`rule: ${decision.rule}\n`);
    for (const r of decision.reasons) process.stdout.write(`  - ${r}\n`);
  }
  if (decision.allowed) return 0;
  if (decision.approvalRequired) return 3;
  return 1;
}
