import { defaultConfigPath } from "../../../core/config.ts";
import { loadVaultMap } from "../../../core/brain/portability/role-tokens.ts";
import { parseFlags } from "../../argparse.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info, writeJson } from "../../output.ts";

/**
 * `o2b vault map [show]` - print the resolved vault-map (role token ->
 * folder), merging the vault map (`role-tokens.ts`: the operator's
 * `vault_map.document` setting, or `Brain/_vault-map.yaml` before the
 * switch) over the built-in defaults. Writes nothing, except the one-time
 * carry-over of an archived map on a machine switched before the setting.
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

  try {
    const map = loadVaultMap(vault);
    if (flags["json"]) {
      writeJson(map);
      return 0;
    }
    for (const token of Object.keys(map).toSorted()) {
      info(`{{${token}}} -> ${map[token]}`);
    }
    return 0;
  } catch (exc) {
    return fail(`vault map: ${(exc as Error).message ?? exc}`);
  }
}
