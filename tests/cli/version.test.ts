/**
 * `o2b version` and the root `--version` flag.
 *
 * The MCP surface has always answered this question - the handshake
 * carries `serverInfo.version` - and the CLI never did. An operator with
 * a shell and no MCP client had no way to ask an install which version
 * it is, which is the first question every bug report starts with.
 *
 * Three properties are pinned here, and the third is the one worth
 * naming: the flag and the verb render the SAME line. Two spellings of
 * one question that answer differently are worse than one spelling,
 * because the difference is invisible until someone pastes the wrong
 * one into a report.
 */

import { describe, expect, test } from "bun:test";

import { OPEN_SECOND_BRAIN_VERSION } from "../../src/core/version.ts";
import { CLI_COMMAND_MANIFEST, allFlagNames } from "../../src/cli/command-manifest.ts";
import { runCli } from "../helpers/run-cli.ts";

/** The verb under test, and the root flag that is its synonym. */
const VERSION_COMMAND = "version";
const VERSION_FLAG = "--version";

/** Exit code the CLI reserves for a usage error. */
const USAGE_EXIT = 2;

describe("o2b version", () => {
  test("prints the version constant and exits 0", async () => {
    const result = await runCli([VERSION_COMMAND]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toBe(`${OPEN_SECOND_BRAIN_VERSION}\n`);
    expect(result.stderr).toBe("");
  });

  test("--json prints a parseable object carrying the same version", async () => {
    const result = await runCli([VERSION_COMMAND, "--json"]);
    expect(result.returncode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: OPEN_SECOND_BRAIN_VERSION });
  });

  test("the root flag renders the same line as the verb", async () => {
    const viaFlag = await runCli([VERSION_FLAG]);
    const viaVerb = await runCli([VERSION_COMMAND]);
    expect(viaFlag.returncode).toBe(0);
    expect(viaFlag.stdout).toBe(viaVerb.stdout);
  });

  test("the root flag honours --json too", async () => {
    const result = await runCli([VERSION_FLAG, "--json"]);
    expect(result.returncode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: OPEN_SECOND_BRAIN_VERSION });
  });

  test("an unknown argument is a usage error, not silence", async () => {
    const result = await runCli([VERSION_COMMAND, "latest"]);
    expect(result.returncode).toBe(USAGE_EXIT);
    expect(result.stderr).toContain("latest");
    expect(result.stdout).toBe("");
  });

  test("an unknown flag is a usage error", async () => {
    const result = await runCli([VERSION_COMMAND, "--short"]);
    expect(result.returncode).toBe(USAGE_EXIT);
    expect(result.stderr).toContain("--short");
  });

  test("the two spellings answer a bad argument identically, not just a good one", async () => {
    // The property in the docblock is about the SAME line, and a usage
    // error is a line. Handling the root flag in an arm of its own put
    // it outside the dispatcher's `CliError` handler, so the flag threw
    // a stack trace and exited 1 where the verb printed a usage error
    // and exited 2 - the divergence the synonym exists to prevent,
    // visible only to whoever typed the wrong one.
    for (const argv of [["latest"], ["--short"]]) {
      const viaFlag = await runCli([VERSION_FLAG, ...argv]);
      const viaVerb = await runCli([VERSION_COMMAND, ...argv]);
      expect(viaFlag.returncode).toBe(USAGE_EXIT);
      expect(viaFlag.returncode).toBe(viaVerb.returncode);
      expect(viaFlag.stderr).toBe(viaVerb.stderr);
      expect(viaFlag.stdout).toBe("");
    }
  });
});

describe("the manifest models both spellings", () => {
  test("a top-level version command", () => {
    const entry = CLI_COMMAND_MANIFEST.commands.find((c) => c.name === VERSION_COMMAND);
    expect(entry).toBeDefined();
    expect(entry!.summary.trim().length).toBeGreaterThan(0);
  });

  test("a root --version flag, so completions offer it", () => {
    const root = CLI_COMMAND_MANIFEST.flags.find((f) => f.name === VERSION_COMMAND);
    expect(root).toBeDefined();
    expect(root!.type).toBe("boolean");
    expect(allFlagNames()).toContain(VERSION_COMMAND);
  });
});
