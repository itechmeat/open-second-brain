/**
 * A word the operator types is looked up among a table's OWN names only.
 * Read through a plain object, an inherited name (`constructor`,
 * `toString`, `__proto__`) once found a built-in: a flag of that name was
 * accepted or crashed the parser, `o2b setup --target constructor` planned
 * a host, and the verb help and the codegraph partner crashed.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CliError, parseFlags } from "../../src/cli/argparse.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const INHERITED = ["constructor", "toString", "hasOwnProperty", "__proto__"] as const;

describe("inherited names on the command line", () => {
  test("a flag named after one is an unknown flag", () => {
    for (const name of INHERITED) {
      for (const token of [`--${name}`, `--${name}=1`]) {
        let message = "";
        try {
          parseFlags([token], { vault: { type: "string" } });
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          message = err.message;
        }
        expect({ token, message }).toEqual({ token, message: `unknown flag: --${name}` });
      }
    }
  });

  for (const name of INHERITED) {
    test(`setup, verb help and the codegraph partner refuse ${name} as unknown`, async () => {
      // In turn: an in-process run holds the process's streams.
      const setup = await runCli(["setup", "--target", name]);
      const brainHelp = await runCli(["brain", name, "--help"]);
      const vaultHelp = await runCli(["vault", name, "--help"]);
      const partner = await runCli(["partner", "codegraph", name]);
      expect({
        setup: [setup.returncode, setup.stderr.includes(`unknown --target: ${name}`)],
        brainHelp: [brainHelp.returncode, brainHelp.stdout.startsWith("usage: o2b brain")],
        vaultHelp: [vaultHelp.returncode, vaultHelp.stdout.startsWith("usage: o2b vault")],
        partner: [partner.returncode, partner.stderr.includes(`subcommand: ${name}`)],
      }).toEqual({
        setup: [2, true],
        brainHelp: [2, true],
        vaultHelp: [2, true],
        partner: [2, true],
      });
    });
  }
});
