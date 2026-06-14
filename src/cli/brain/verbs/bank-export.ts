import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportBankBundle } from "../../../core/brain/portability/bundle.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain bank-export [--out <file>]` - serialise a whole-vault bank
 * bundle (preferences + page graph + page contracts + sources dashboard)
 * to a schema-versioned JSON. Prints to stdout, or writes to
 * `--out <file>`. Read-only on the vault.
 */
export async function cmdBrainBankExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, { vault: { type: "string" }, out: { type: "string" } });
  const { vault } = brainVerbContext(flags);

  let json: string;
  try {
    json = JSON.stringify(exportBankBundle(vault), null, 2) + "\n";
  } catch (exc) {
    return fail(`bank-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`bank-export failed to write output: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
