import { defaultConfigPath } from "../../../core/config.ts";
import {
  createProfile,
  listProfiles,
  switchProfile,
} from "../../../core/brain/portability/profiles.ts";
import { parseFlags } from "../../argparse.ts";
import { fail, info, writeJson } from "../../output.ts";

/**
 * `o2b vault profile <list|create|switch>` - manage named multi-vault
 * profiles. `create <name> <vault-path>`, `switch <name>`, `list`.
 * Activation is a pointer in profiles.json (no symlinks).
 */
export async function cmdVaultProfile(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, { json: { type: "boolean" } });
  const sub = positional[0] ?? "list";
  const configPath = defaultConfigPath();

  switch (sub) {
    case "list": {
      let listing;
      try {
        listing = listProfiles(configPath);
      } catch (exc) {
        return fail(`profile list failed: ${(exc as Error).message ?? exc}`);
      }
      if (flags["json"]) {
        writeJson(listing);
        return 0;
      }
      if (listing.profiles.length === 0) {
        info("no profiles");
        return 0;
      }
      for (const p of listing.profiles) {
        info(`${p.active ? "* " : "  "}${p.name}  ${p.vault}`);
      }
      return 0;
    }
    case "create": {
      const name = positional[1];
      const vault = positional[2];
      if (!name || !vault) {
        return fail("usage: o2b vault profile create <name> <vault-path>");
      }
      try {
        createProfile(configPath, name, vault);
      } catch (exc) {
        return fail(`profile create failed: ${(exc as Error).message ?? exc}`);
      }
      info(`created profile '${name}' -> ${vault}`);
      return 0;
    }
    case "switch": {
      const name = positional[1];
      if (!name) return fail("usage: o2b vault profile switch <name>");
      try {
        switchProfile(configPath, name);
      } catch (exc) {
        return fail(`profile switch failed: ${(exc as Error).message ?? exc}`);
      }
      info(`active profile -> ${name}`);
      return 0;
    }
    default:
      return fail(`unknown profile subcommand '${sub}' (list | create | switch)`);
  }
}
