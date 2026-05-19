import { defaultConfigPath } from "../../../core/config.ts";
import { consumePendingRequest } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdConsumePaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    receipt: { type: "string", required: true },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await consumePendingRequest(vault, String(flags["id"]), {
      receiptPath: String(flags["receipt"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to consume request: ${(exc as Error).message ?? exc}\n`,
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
    process.stdout.write(`consumed: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}
