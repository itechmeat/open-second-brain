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
