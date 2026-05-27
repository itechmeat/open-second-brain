/**
 * `o2b vault` subcommand dispatcher (v0.10.9).
 *
 * Routes to thin wrappers under `./vault/verbs/`. Anchored in
 * `docs/plans/2026-05-19-vault-scope-design.md` §7.
 */

import { CliError } from "./argparse.ts";
import { VAULT_HELP, VAULT_VERB_HELP } from "./vault/help-text.ts";
import { cmdVaultStatus } from "./vault/verbs/status.ts";
import { cmdVaultInspect } from "./vault/verbs/inspect.ts";

export async function handleVaultSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(VAULT_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
    const text = VAULT_VERB_HELP[verb];
    if (text) {
      process.stdout.write(text);
      return 0;
    }
    process.stdout.write(VAULT_HELP);
    return 2;
  }

  try {
    switch (verb) {
      case "status":
        return await cmdVaultStatus(rest);
      case "inspect":
        return await cmdVaultInspect(rest);
      default:
        process.stderr.write(`error: unknown vault verb: ${verb}\n`);
        process.stdout.write(VAULT_HELP);
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) {
      process.stderr.write(`error: ${exc.message}\n`);
      // Argument / usage errors use exit 2 to stay consistent with the
      // rest of the CLI; runtime failures inside a verb still bubble up
      // through `fail()` (exit 1).
      return 2;
    }
    throw exc;
  }
}
