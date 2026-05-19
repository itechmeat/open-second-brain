import { defaultConfigPath } from "../../../core/config.ts";
import { approvePendingRequest } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdApprovePaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    "approved-by": { type: "string", required: true },
    note: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await approvePendingRequest(vault, String(flags["id"]), {
      approvedBy: String(flags["approved-by"]),
      note: (flags["note"] as string | undefined) ?? null,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to approve request: ${(exc as Error).message ?? exc}\n`,
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
    process.stdout.write(`approved: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}
