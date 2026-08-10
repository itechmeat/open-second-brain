import { describe, expect, test } from "bun:test";

import { nestedCommandGroups } from "../../src/cli/command-manifest.ts";
import { runCli } from "../helpers/run-cli.ts";

describe("CLI command manifest", () => {
  test("help --json lists root commands, nested verbs, and inherited json flag", async () => {
    const result = await runCli(["help", "--json"]);

    expect(result.returncode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);

    expect(parsed.command).toBe("o2b");
    const rootNames = parsed.commands.map((command: any) => command.name);
    expect(rootNames).toContain("status");
    expect(rootNames).toContain("mcp");
    expect(rootNames).toContain("brain");
    expect(rootNames).toContain("completions");

    const status = parsed.commands.find((command: any) => command.name === "status");
    expect(status.flags).toContainEqual({
      name: "json",
      type: "boolean",
      inherited: true,
    });

    const brain = parsed.commands.find((command: any) => command.name === "brain");
    const brainVerbs = brain.commands.map((command: any) => command.name);
    expect(brainVerbs).toContain("doctor");
    expect(brainVerbs).toContain("mcp-landscape");
  });
});

describe("o2b completions", () => {
  for (const shell of ["bash", "zsh", "fish", "elvish", "nushell", "powershell"]) {
    test(`prints ${shell} completions from the manifest`, async () => {
      const result = await runCli(["completions", shell]);

      expect(result.returncode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("o2b");
      expect(result.stdout).toContain("brain");
      expect(result.stdout).toContain("mcp");
      expect(result.stdout).toContain("--json");
    });
  }

  test("rejects unsupported shells", async () => {
    const result = await runCli(["completions", "xonsh"]);

    expect(result.returncode).toBe(2);
    expect(result.stderr).toContain("unsupported completion shell: xonsh");
  });
});

describe("nested subcommand coverage", () => {
  // The renderer used to hand-list the three roots it knew about. A fourth
  // that grew subcommands was therefore offered by no shell, and nothing
  // said so: the completion simply produced nothing where a verb existed.
  // Deriving the groups from the manifest fixed it; this is what keeps it
  // fixed, at every depth rather than only the first.
  const groups = nestedCommandGroups();

  test("the manifest models nested groups below the first level", () => {
    // Guards the assertions below against passing because the collector
    // silently stopped recursing.
    expect(groups.some((group) => group.parent === "partner")).toBe(true);
    expect(groups.find((group) => group.parent === "codegraph")?.children).toContain("resync");
  });

  test("bash offers every nested group", async () => {
    const out = await runCli(["completions", "bash"]);
    expect(out.returncode).toBe(0);
    for (const group of groups) {
      expect(out.stdout).toContain(`"$prev" == "${group.parent}"`);
      for (const child of group.children) expect(out.stdout).toContain(child);
    }
  });

  test("zsh offers every nested subcommand", async () => {
    const out = await runCli(["completions", "zsh"]);
    expect(out.returncode).toBe(0);
    const line = out.stdout.split("\n").find((l) => l.includes("2:subcommand:"));
    expect(line).toBeDefined();
    for (const group of groups) {
      for (const child of group.children) expect(line).toContain(child);
    }
  });

  test("fish scopes every nested group to its own parent", async () => {
    const out = await runCli(["completions", "fish"]);
    expect(out.returncode).toBe(0);
    for (const group of groups) {
      expect(out.stdout).toContain(`__fish_seen_subcommand_from ${group.parent}`);
    }
  });
});
