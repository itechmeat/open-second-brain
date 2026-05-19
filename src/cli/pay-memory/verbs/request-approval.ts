import { defaultConfigPath, resolveAgentName, resolveTimezone } from "../../../core/config.ts";
import { writePendingRequest } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseOptionalNumberFlag } from "../../coerce.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdRequestPaymentApproval(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    service: { type: "string", required: true },
    reason: { type: "string", required: true },
    "expected-amount": { type: "string" },
    currency: { type: "string" },
    category: { type: "string" },
    endpoint: { type: "string" },
    "expected-output": { type: "string" },
    "vault-files": { type: "string-array" },
    slug: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    "enforce-policy": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const tz = resolveTimezone(config);

  const { value: expectedAmount, error: expectedErr } = parseOptionalNumberFlag(
    flags,
    "expected-amount",
  );
  if (expectedErr) {
    process.stderr.write(`error: ${expectedErr}\n`);
    return 2;
  }

  let result;
  try {
    result = writePendingRequest(vault, {
      agent,
      service: String(flags["service"]),
      reason: String(flags["reason"]),
      expectedAmount,
      currency: (flags["currency"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      endpoint: (flags["endpoint"] as string | undefined) ?? null,
      expectedOutput: (flags["expected-output"] as string | undefined) ?? null,
      vaultFiles: (flags["vault-files"] as string[] | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      time: (flags["time"] as string | undefined) ?? null,
      tz,
      enforcePolicy: Boolean(flags["enforce-policy"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to create pending request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          id: result.id,
          path: result.relativePath,
          status: result.status,
          created: result.created,
          policy_status: result.policyDecision.status,
          policy_rule: result.policyDecision.rule,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`pending: ${result.relativePath}\n`);
    process.stdout.write(`id: ${result.id}\n`);
    process.stdout.write(`policy: ${result.policyDecision.status}\n`);
  }
  return 0;
}
