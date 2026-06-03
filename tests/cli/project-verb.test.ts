/**
 * `o2b brain project <link|list|remove|status>` (Workspace Insight
 * Suite, t_1375e69f): CLI surface over project vault pointers.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VAULT_POINTER_FILE } from "../../src/core/brain/portability/pointer.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let project: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-project-cli-"));
  vault = join(tmp, "vault");
  project = join(tmp, "project");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(project, { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("link writes the pointer and registers the project", async () => {
  const r = await runCli(["brain", "project", "link", project, "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(parsed["vault"]).toBe(vault);
  expect(existsSync(join(project, VAULT_POINTER_FILE))).toBe(true);

  const list = await runCli(["brain", "project", "list", "--json"], { env: env() });
  const listed = JSON.parse(list.stdout) as { projects: Array<{ path: string; vault: string }> };
  expect(listed.projects).toHaveLength(1);
  expect(listed.projects[0]!.path).toBe(project);
});

test("a command launched from the linked directory resolves the owning vault", async () => {
  const otherVault = join(tmp, "other-vault");
  mkdirSync(join(otherVault, "Brain"), { recursive: true });
  const link = await runCli(["brain", "project", "link", project, "--vault", otherVault], {
    env: env(),
  });
  expect(link.returncode).toBe(0);

  const nested = join(project, "packages", "api");
  mkdirSync(nested, { recursive: true });
  const status = await runCli(["brain", "project", "status", "--json"], {
    env: env(),
    cwd: nested,
  });
  expect(status.returncode).toBe(0);
  const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
  expect(parsed["resolved_vault"]).toBe(otherVault);
  expect(parsed["resolution"]).toBe("pointer");
});

test("status reports malformed pointers and registry health", async () => {
  await runCli(["brain", "project", "link", project], { env: env() });
  writeFileSync(join(project, VAULT_POINTER_FILE), "{broken");
  const status = await runCli(["brain", "project", "status", project, "--json"], { env: env() });
  expect(status.returncode).toBe(0);
  const parsed = JSON.parse(status.stdout) as {
    pointer: { error: string | null } | null;
    projects: Array<{ pointer: string }>;
  };
  expect(parsed.pointer?.error).not.toBeNull();
  expect(parsed.projects[0]!.pointer).toBe("malformed");
});

test("link refuses a directory inside the vault", async () => {
  const inside = join(vault, "Brain", "area");
  mkdirSync(inside, { recursive: true });
  const r = await runCli(["brain", "project", "link", inside], { env: env() });
  expect(r.returncode).not.toBe(0);
  expect(r.stderr).toContain("inside");
});

test("remove deletes the pointer and the registry entry", async () => {
  await runCli(["brain", "project", "link", project], { env: env() });
  const r = await runCli(["brain", "project", "remove", project, "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  expect(existsSync(join(project, VAULT_POINTER_FILE))).toBe(false);
  const list = await runCli(["brain", "project", "list", "--json"], { env: env() });
  expect((JSON.parse(list.stdout) as { projects: unknown[] }).projects).toHaveLength(0);

  const again = await runCli(["brain", "project", "remove", project], { env: env() });
  expect(again.returncode).not.toBe(0);
});
