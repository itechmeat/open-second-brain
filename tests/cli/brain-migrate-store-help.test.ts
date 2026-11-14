/**
 * `o2b brain migrate-store --help` prints the verb's own usage and exits
 * 0, and `o2b brain --help` lists the verb: it is the entry point of the
 * migration, with forms that exclude each other.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

describe("migrate-store help", () => {
  test("the verb's help names every form and flag", async () => {
    const res = await runCli(["brain", "migrate-store", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout.startsWith("usage: o2b brain migrate-store")).toBe(true);
    for (const flag of [
      "--dry-run",
      "--resume",
      "--rollback",
      "--remove-legacy",
      "--force-release-gate",
      "--force",
      "--wait",
      "--json",
    ]) {
      expect(res.stdout).toContain(flag);
    }
  });

  test("the brain help lists the verb", async () => {
    const res = await runCli(["brain", "--help"]);
    expect(res.stdout).toContain("migrate-store");
  });
});
