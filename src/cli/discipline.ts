/**
 * `o2b discipline` subcommand dispatcher.
 *
 * Routes discipline verbs to their handlers. Currently only `report` is
 * implemented; `install` and `uninstall` are reserved for Task 2.13.
 */

import { defaultConfigPath, resolveVault } from "../core/config.ts";
import { runDisciplineReport } from "../core/discipline/report.ts";
import { disciplineInstallVerb, disciplineUninstallVerb } from "./discipline-install.ts";

const NO_VAULT_ERROR =
  "error: no vault configured. Pass --vault <path> explicitly, " +
  "set VAULT_DIR in the environment, or run " +
  "`o2b init --vault <path> ...` first to persist a default.";

function resolveDisciplineVault(flagVal: string | undefined, configPath: string | null): string {
  const vault = flagVal ?? resolveVault(configPath ?? undefined);
  if (vault === null || vault === undefined) {
    process.stderr.write(NO_VAULT_ERROR + "\n");
    throw new Error(NO_VAULT_ERROR);
  }
  return vault;
}

export async function disciplineReportVerb(args: string[], defaultVault: string): Promise<number> {
  let vault = defaultVault;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vault = args[i + 1]!;
      i++;
    }
  }
  const res = runDisciplineReport({ vault });
  if (res.status === "disabled") {
    process.stderr.write(
      "o2b discipline report: discipline_report disabled in Brain/_brain.yaml\n",
    );
    return 0;
  }
  process.stdout.write(res.text + "\n");
  return 0;
}

export async function handleDisciplineSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  const rest = argv.slice(1) as string[];

  // Extract --vault from the full argv (before or after the verb) so we can
  // resolve the default vault once for all subcommands.
  let vaultFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault" && argv[i + 1]) {
      vaultFlag = argv[i + 1];
      break;
    }
  }

  switch (verb) {
    case "report": {
      const config = defaultConfigPath();
      const vault = resolveDisciplineVault(vaultFlag, config);
      return await disciplineReportVerb(rest, vault);
    }
    case "install": {
      // Let the verb handle missing --vault itself (returns exit 2).
      const config = defaultConfigPath();
      const vault = vaultFlag ?? resolveVault(config ?? undefined) ?? "";
      return await disciplineInstallVerb(rest, vault);
    }
    case "uninstall": {
      // Let the verb handle missing --vault itself (returns exit 2).
      const config = defaultConfigPath();
      const vault = vaultFlag ?? resolveVault(config ?? undefined) ?? "";
      return await disciplineUninstallVerb(rest, vault);
    }
    default:
      process.stderr.write(`error: unknown discipline subcommand: ${verb ?? "(none)"}\n`);
      return 2;
  }
}
