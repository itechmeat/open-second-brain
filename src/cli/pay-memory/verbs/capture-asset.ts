import { readFileSync } from "node:fs";

import { defaultConfigPath } from "../../../core/config.ts";
import { writeAsset } from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdCaptureAsset(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    title: { type: "string", required: true },
    service: { type: "string", required: true },
    "result-url": { type: "string", required: true },
    "source-receipt": { type: "string" },
    "prompt-file": { type: "string" },
    "used-in": { type: "string" },
    slug: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let prompt: string | undefined;
  const promptFile = flags["prompt-file"] as string | undefined;
  if (promptFile) {
    try {
      prompt = readFileSync(promptFile, "utf8");
    } catch (exc) {
      process.stderr.write(
        `error: cannot read prompt-file: ${(exc as Error).message ?? exc}\n`,
      );
      return 1;
    }
  }

  let result;
  try {
    result = writeAsset(vault, {
      title: String(flags["title"]),
      service: String(flags["service"]),
      resultUrl: String(flags["result-url"]),
      sourceReceipt: (flags["source-receipt"] as string | undefined) ?? null,
      prompt: prompt ?? null,
      usedIn: (flags["used-in"] as string | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write asset: ${(exc as Error).message ?? exc}\n`,
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
          created: result.created,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`asset: ${result.relativePath}\n`);
    process.stdout.write(`slug: ${result.slug}\n`);
  }
  return 0;
}
