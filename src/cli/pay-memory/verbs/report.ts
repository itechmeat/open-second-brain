import { defaultConfigPath } from "../../../core/config.ts";
import { writeReport } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdPaymentReport(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    date: { type: "string", required: true },
    title: { type: "string" },
    task: { type: "string" },
    slug: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = writeReport(vault, {
      date: String(flags["date"]),
      title: (flags["title"] as string | undefined) ?? null,
      task: (flags["task"] as string | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
    });
  } catch (exc) {
    process.stderr.write(`error: failed to write report: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          path: result.relativePath,
          absolute_path: result.path,
          slug: result.slug,
          receipts_used: result.receiptsUsed,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`report: ${result.relativePath}\n`);
    process.stdout.write(`receipts: ${result.receiptsUsed}\n`);
  }
  return 0;
}
