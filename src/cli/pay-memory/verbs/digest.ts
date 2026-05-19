import { defaultConfigPath, resolveTimezone } from "../../../core/config.ts";
import { buildPaymentDigest, renderPaymentDigestTelegram } from "../../../core/pay-memory/index.ts";
import { requireVault } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdPaymentDigest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    date: { type: "string" },
    "empty-mode": { type: "string", default: "silent" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const tz = resolveTimezone(config);

  const emptyMode = String(flags["empty-mode"]);
  if (!["silent", "empty", "summary"].includes(emptyMode)) {
    process.stderr.write(`error: --empty-mode must be silent|empty|summary\n`);
    return 2;
  }

  let digest;
  try {
    digest = buildPaymentDigest(vault, {
      date: (flags["date"] as string | undefined) ?? null,
      tz,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to build digest: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          date: digest.date,
          services: digest.services,
          receipts: digest.receipts,
          total_amount: digest.totalAmount,
          currency: digest.currency,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const text = renderPaymentDigestTelegram(digest, {
      emptyMode: emptyMode as "silent" | "empty" | "summary",
    });
    if (text) process.stdout.write(text + "\n");
  }
  return 0;
}
