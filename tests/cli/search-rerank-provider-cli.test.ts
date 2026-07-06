/**
 * CLI tests for `o2b search rerank-provider <add|list|show|remove>`.
 *
 * Mirrors search-provider-cli.test.ts: the two commands share
 * `runProviderRegistryCommand` (src/cli/search.ts) over structurally
 * identical registries, so this pins the rerank-provider verb's own
 * usage/output strings and persisted-file path.
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-rerank-provider-cli-"));
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
  "rerank-provider",
  "add",
  "cohere-rerank",
  "--base-url",
  "https://api.cohere.ai/v1",
  "--model",
  "rerank-english-v3.0",
  "--env-key",
  "COHERE_API_KEY",
];

test("rerank-provider add then list shows the registered profile", async () => {
  const add = await runCli(addArgs, { env: env() });
  expect(add.returncode).toBe(0);
  expect(existsSync(join(vault, "Brain", "search", "rerank-providers.json"))).toBe(true);

  const list = await runCli(["search", "rerank-provider", "list"], { env: env() });
  expect(list.returncode).toBe(0);
  expect(list.stdout).toContain("cohere-rerank");
});

test("rerank-provider list --json returns the profile array", async () => {
  await runCli(addArgs, { env: env() });
  const list = await runCli(["search", "rerank-provider", "list", "--json"], { env: env() });
  expect(list.returncode).toBe(0);
  const arr = JSON.parse(list.stdout);
  expect(Array.isArray(arr)).toBe(true);
  expect(arr[0]).toMatchObject({
    name: "cohere-rerank",
    baseUrl: "https://api.cohere.ai/v1",
    defaultModel: "rerank-english-v3.0",
    envKey: "COHERE_API_KEY",
  });
});

test("rerank-provider show prints a single profile", async () => {
  await runCli(addArgs, { env: env() });
  const show = await runCli(["search", "rerank-provider", "show", "cohere-rerank", "--json"], {
    env: env(),
  });
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toMatchObject({ name: "cohere-rerank" });
});

test("rerank-provider remove deletes the profile", async () => {
  await runCli(addArgs, { env: env() });
  const rm = await runCli(["search", "rerank-provider", "remove", "cohere-rerank"], {
    env: env(),
  });
  expect(rm.returncode).toBe(0);
  const list = await runCli(["search", "rerank-provider", "list", "--json"], { env: env() });
  expect(JSON.parse(list.stdout)).toEqual([]);
});

test("rerank-provider add with missing required flags fails with exit 2", async () => {
  const add = await runCli(["search", "rerank-provider", "add", "incomplete"], { env: env() });
  expect(add.returncode).toBe(2);
  expect(add.stderr).toContain("rerank-provider add requires");
});

test("rerank-provider show of an unknown name exits non-zero", async () => {
  const show = await runCli(["search", "rerank-provider", "show", "ghost"], { env: env() });
  expect(show.returncode).not.toBe(0);
  expect(show.stderr).toContain("no registered rerank provider named");
});
