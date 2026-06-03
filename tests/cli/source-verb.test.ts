/**
 * `o2b brain source <add|list|remove>` (Workspace Insight Suite,
 * t_1375e69f): CLI surface over read-only recall sources.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let external: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-source-cli-"));
  vault = join(tmp, "vault");
  external = join(tmp, "external");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(external, "Brain"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("add registers a read-only source and list shows it", async () => {
  const add = await runCli(["brain", "source", "add", external, "--alias", "team", "--json"], {
    env: env(),
  });
  expect(add.returncode).toBe(0);
  expect((JSON.parse(add.stdout) as Record<string, unknown>)["read_only"]).toBe(true);

  const list = await runCli(["brain", "source", "list", "--json"], { env: env() });
  const parsed = JSON.parse(list.stdout) as {
    sources: Array<{ alias: string; vault: string; broken: boolean }>;
  };
  expect(parsed.sources).toHaveLength(1);
  expect(parsed.sources[0]!.alias).toBe("team");
  expect(parsed.sources[0]!.broken).toBe(false);
});

test("add without --alias fails; self-source is refused", async () => {
  const noAlias = await runCli(["brain", "source", "add", external], { env: env() });
  expect(noAlias.returncode).not.toBe(0);

  const self = await runCli(["brain", "source", "add", vault, "--alias", "self"], { env: env() });
  expect(self.returncode).not.toBe(0);
  expect(self.stderr).toContain("itself");
});

test("a broken source is flagged in list output", async () => {
  await runCli(["brain", "source", "add", external, "--alias", "team"], { env: env() });
  rmSync(external, { recursive: true, force: true });
  const list = await runCli(["brain", "source", "list"], { env: env() });
  expect(list.stdout).toContain("BROKEN");
});

test("remove drops the source; removing an unknown alias fails", async () => {
  await runCli(["brain", "source", "add", external, "--alias", "team"], { env: env() });
  const rm = await runCli(["brain", "source", "remove", "team", "--json"], { env: env() });
  expect(rm.returncode).toBe(0);
  const list = await runCli(["brain", "source", "list", "--json"], { env: env() });
  expect((JSON.parse(list.stdout) as { sources: unknown[] }).sources).toHaveLength(0);

  const again = await runCli(["brain", "source", "remove", "team"], { env: env() });
  expect(again.returncode).not.toBe(0);
});
