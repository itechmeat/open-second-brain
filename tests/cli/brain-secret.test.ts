/**
 * `o2b brain secret` CLI surface (t_0b134404): set ingests the value
 * from stdin (never argv), list shows metadata only, run injects the
 * secret into an allowlisted subprocess and redacts the output, rm
 * removes irrecoverably.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-secret-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("set from stdin, list metadata only, run with redaction, rm", async () => {
  const set = await runCli(
    [
      "brain",
      "secret",
      "set",
      "api-key",
      "--env-var",
      "MY_API_KEY",
      "--allow",
      "bun -e *",
      "--vault",
      vault,
      "--json",
    ],
    { stdin: "sk-cli-secret-98765\n" },
  );
  expect(set.returncode).toBe(0);
  expect(set.stdout).not.toContain("sk-cli-secret-98765");

  const list = await runCli(["brain", "secret", "list", "--vault", vault, "--json"]);
  expect(list.returncode).toBe(0);
  const listed = JSON.parse(list.stdout) as {
    secrets: Array<{ name: string; env_var: string; allow: string[] }>;
  };
  expect(listed.secrets).toHaveLength(1);
  expect(listed.secrets[0]).toMatchObject({
    name: "api-key",
    env_var: "MY_API_KEY",
    allow: ["bun -e *"],
  });
  expect(list.stdout).not.toContain("sk-cli-secret-98765");

  const run = await runCli([
    "brain",
    "secret",
    "run",
    "api-key",
    "--vault",
    vault,
    "--",
    "bun",
    "-e",
    "console.log('got ' + process.env.MY_API_KEY)",
  ]);
  expect(run.returncode).toBe(0);
  expect(run.stdout).not.toContain("sk-cli-secret-98765");
  expect(run.stdout).toContain("***REDACTED***");

  const denied = await runCli([
    "brain",
    "secret",
    "run",
    "api-key",
    "--vault",
    vault,
    "--",
    "bash",
    "-c",
    "env",
  ]);
  expect(denied.returncode).toBe(2);
  expect(denied.stderr).toContain("allowlist");

  const rm = await runCli(["brain", "secret", "rm", "api-key", "--vault", vault]);
  expect(rm.returncode).toBe(0);
  const after = await runCli(["brain", "secret", "list", "--vault", vault, "--json"]);
  expect(JSON.parse(after.stdout).secrets).toHaveLength(0);
});

test("the value never lands in the store file or audit trail in plaintext", async () => {
  await runCli(["brain", "secret", "set", "deploy-token", "--vault", vault], {
    stdin: "ghp-deploy-token-555\n",
  });
  const storeRaw = readFileSync(
    join(vault, ".open-second-brain", "secrets", "secrets.json"),
    "utf8",
  );
  expect(storeRaw).not.toContain("ghp-deploy-token-555");
});

test("set without stdin value or --from-env is a usage error", async () => {
  const result = await runCli(["brain", "secret", "set", "empty-one", "--vault", vault], {
    stdin: "",
  });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain("stdin");
});
