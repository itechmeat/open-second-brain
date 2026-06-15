/**
 * `o2b partner codegraph report` CLI surface (t_a1e76788).
 *
 * The command is strictly read-only: it reports codegraph index status plus
 * structural Cargo workspace membership without installing, initializing, or
 * mutating any partner index or the vault. codegraph presence on PATH is
 * environment-dependent, so the deterministic assertions target the Cargo
 * workspace parse and the report envelope, not the CLI-availability field.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-partner-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeWorkspaceRepo(): string {
  const repo = join(tmp, "ws");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, "Cargo.toml"),
    '[workspace]\nresolver = "2"\nmembers = ["crates/a", "crates/b"]\n',
  );
  return repo;
}

test("--json emits a schema-versioned report with Cargo members", async () => {
  const repo = makeWorkspaceRepo();
  const res = await runCli(
    ["partner", "codegraph", "report", "--vault", join(tmp, "vault"), "--json"],
    {
      cwd: repo,
    },
  );
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout);
  expect(report.schema_version).toBe(1);
  expect(report.project).toBe(repo);
  expect(report.cargo_workspace).not.toBeNull();
  expect(report.cargo_workspace.members).toEqual(["crates/a", "crates/b"]);
  expect(report.cargo_workspace.memberCount).toBe(2);
});

test("human output lists workspace members", async () => {
  const repo = makeWorkspaceRepo();
  const res = await runCli(["partner", "codegraph", "report", "--vault", join(tmp, "vault")], {
    cwd: repo,
  });
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("cargo workspace: 2 member(s)");
  expect(res.stdout).toContain("crates/a");
});

test("non-Rust project reports no cargo workspace with a reason", async () => {
  const repo = join(tmp, "node");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "package.json"), "{}\n");
  const res = await runCli(
    ["partner", "codegraph", "report", "--vault", join(tmp, "vault"), "--json"],
    {
      cwd: repo,
    },
  );
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout);
  expect(report.cargo_workspace).toBeNull();
  expect(report.cargo_workspace_reason).toContain("no Cargo.toml");
});

test("unknown partner subcommand exits 2 with usage", async () => {
  const res = await runCli(["partner", "codegraph", "bogus"], { cwd: tmp });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("usage: o2b partner codegraph report");
});

test("unknown flag exits 2 instead of being silently ignored", async () => {
  const res = await runCli(["partner", "codegraph", "report", "--bogus"], { cwd: tmp });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("unknown flag: --bogus");
});

test("--vault without a value exits 2", async () => {
  const res = await runCli(["partner", "codegraph", "report", "--vault"], { cwd: tmp });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("--vault requires a value");
});

test("positional arguments are rejected", async () => {
  const res = await runCli(["partner", "codegraph", "report", "extra"], { cwd: tmp });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("does not accept positional arguments");
});
