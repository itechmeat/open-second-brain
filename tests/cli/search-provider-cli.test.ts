/**
 * CLI tests for `o2b search provider <add|list|show|remove>`.
 *
 * Forks the real `bun src/cli/main.ts` binary via `runCli`, asserting
 * exit codes, JSON shape, and the persisted registry file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-provider-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });
const addArgs = [
  "search",
  "provider",
  "add",
  "nvidia-nim",
  "--base-url",
  "https://integrate.api.nvidia.com/v1",
  "--model",
  "nvidia/nv-embed-v1",
  "--env-key",
  "NIM_API_KEY",
];

test("provider add then list shows the registered profile", async () => {
  const add = await runCli(addArgs, { env: env() });
  expect(add.returncode).toBe(0);
  expect(existsSync(join(vault, "Brain", "search", "embedding-providers.json"))).toBe(true);

  const list = await runCli(["search", "provider", "list"], { env: env() });
  expect(list.returncode).toBe(0);
  expect(list.stdout).toContain("nvidia-nim");
});

test("provider list --json returns the profile array", async () => {
  await runCli(addArgs, { env: env() });
  const list = await runCli(["search", "provider", "list", "--json"], { env: env() });
  expect(list.returncode).toBe(0);
  const arr = JSON.parse(list.stdout);
  expect(Array.isArray(arr)).toBe(true);
  expect(arr[0]).toMatchObject({
    name: "nvidia-nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "nvidia/nv-embed-v1",
    envKey: "NIM_API_KEY",
  });
});

test("provider show prints a single profile", async () => {
  await runCli(addArgs, { env: env() });
  const show = await runCli(["search", "provider", "show", "nvidia-nim", "--json"], { env: env() });
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toMatchObject({ name: "nvidia-nim" });
});

test("provider remove deletes the profile", async () => {
  await runCli(addArgs, { env: env() });
  const rm = await runCli(["search", "provider", "remove", "nvidia-nim"], { env: env() });
  expect(rm.returncode).toBe(0);
  const list = await runCli(["search", "provider", "list", "--json"], { env: env() });
  expect(JSON.parse(list.stdout)).toEqual([]);
});

test("provider add with a reserved name fails with exit 2", async () => {
  const add = await runCli(
    [
      "search",
      "provider",
      "add",
      "local",
      "--base-url",
      "https://x/v1",
      "--model",
      "m",
      "--env-key",
      "K",
    ],
    { env: env() },
  );
  expect(add.returncode).toBe(2);
  expect(add.stderr).toContain("reserved");
});

test("provider show of an unknown name exits non-zero", async () => {
  const show = await runCli(["search", "provider", "show", "ghost"], { env: env() });
  expect(show.returncode).not.toBe(0);
});

test("provider add accepts a comma-separated --env-key probe list", async () => {
  const add = await runCli(
    [
      "search",
      "provider",
      "add",
      "multi",
      "--base-url",
      "https://x/v1",
      "--model",
      "m",
      "--env-key",
      "PRIMARY_KEY,SECONDARY_KEY",
    ],
    { env: env() },
  );
  expect(add.returncode).toBe(0);
  const list = await runCli(["search", "provider", "list", "--json"], { env: env() });
  const arr = JSON.parse(list.stdout);
  expect(arr[0].envKey).toEqual(["PRIMARY_KEY", "SECONDARY_KEY"]);
});
