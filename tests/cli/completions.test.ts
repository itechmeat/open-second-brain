import { describe, expect, test } from "bun:test";

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
