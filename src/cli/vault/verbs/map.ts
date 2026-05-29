import { defaultConfigPath } from "../../../core/config.ts";
import { loadVaultMap } from "../../../core/brain/portability/role-tokens.ts";
import { parseFlags } from "../../argparse.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info, writeJson } from "../../output.ts";

/**
 * `o2b vault map [show]` - print the resolved vault-map (role token ->
 * folder), merging an optional `Brain/_vault-map.yaml` over the built-in
 * defaults. Read-only.
 */
export async function cmdVaultMap(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, { vault: { type: "string" }, json: { type: "boolean" } });
  const config = defaultConfigPath();
  let vault: string;
  try {
    vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  } catch (exc) {
    return fail(`vault map: ${(exc as Error).message ?? exc}`);
  }

  const map = loadVaultMap(vault);
  if (flags["json"]) {
    writeJson(map);
    return 0;
  }
  for (const token of Object.keys(map).toSorted()) {
    info(`{{${token}}} -> ${map[token]}`);
  }
  return 0;
}
