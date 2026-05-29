import { defaultConfigPath } from "../../../core/config.ts";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportVaultGraph } from "../../../core/brain/portability/graph.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain graph-export [--out <file>]` - serialise the user's vault
 * pages (links + typed relations) to a stable graph.json. Prints to
 * stdout, or writes to `--out <file>`. Read-only on the vault.
 */
export async function cmdBrainGraphExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, { vault: { type: "string" }, out: { type: "string" } });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let json: string;
  try {
    json = JSON.stringify(exportVaultGraph(vault), null, 2) + "\n";
  } catch (exc) {
    return fail(`graph-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`graph-export failed to write output: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
