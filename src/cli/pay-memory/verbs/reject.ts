import { defaultConfigPath } from "../../../core/config.ts";
import { rejectPendingRequest } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdRejectPaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    "rejected-by": { type: "string", required: true },
    reason: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await rejectPendingRequest(vault, String(flags["id"]), {
      rejectedBy: String(flags["rejected-by"]),
      reason: (flags["reason"] as string | undefined) ?? null,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to reject request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { id: result.id, status: result.status, path: result.relativePath },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`rejected: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}
