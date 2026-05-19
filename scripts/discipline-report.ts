#!/usr/bin/env -S bun
import { resolveVault } from "../src/core/config.ts";
import { runDisciplineReport } from "../src/core/discipline/report.ts";

function readVaultArg(): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault" && argv[i + 1]) return argv[i + 1]!;
  }
  // Use the same vault-resolution path the rest of the CLI uses —
  // `VAULT_DIR` env wins over config, and `~`-prefixed config values
  // get tilde-expanded. Direct `discoverConfig().data["vault"]` access
  // would miss both, so a cron job under a different `$HOME` or with
  // `VAULT_DIR` set would silently look at the wrong directory.
  const v = resolveVault();
  if (!v) {
    process.stderr.write(
      "o2b-discipline-report: no vault configured; set VAULT_DIR env or pass --vault <path>\n",
    );
    process.exit(2);
  }
  return v;
}

const vault = readVaultArg();
const res = runDisciplineReport({ vault });
if (res.status === "disabled") {
  process.stderr.write("o2b-discipline-report: discipline_report disabled in Brain/_brain.yaml\n");
  process.exit(0);
}
process.stdout.write(res.text + "\n");
