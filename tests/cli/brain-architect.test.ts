/**
 * `o2b brain architect` CLI surface (Project History Suite, t_929da8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let project: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-architect-"));
  project = join(tmp, "demo-app");
  mkdirSync(join(project, "src", "core"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  writeFileSync(join(project, "src", "core", "engine.ts"), "// x\n");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("architect generates and refreshes vault notes idempotently", async () => {
  const first = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
  expect(first.returncode).toBe(0);
  const created = JSON.parse(first.stdout) as {
    ok: boolean;
    overview_path: string;
    created: number;
    unchanged: number;
  };
  expect(created.ok).toBe(true);
  expect(created.created).toBeGreaterThanOrEqual(2);
  expect(readFileSync(created.overview_path, "utf8")).toContain("demo-app");

  const second = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
  const rerun = JSON.parse(second.stdout) as { created: number; unchanged: number };
  expect(rerun.created).toBe(0);
  expect(rerun.unchanged).toBeGreaterThanOrEqual(2);
});

test("corrupted sentinels fail closed with a repair hint", async () => {
  const first = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
  const overviewPath = (JSON.parse(first.stdout) as { overview_path: string }).overview_path;
  writeFileSync(
    overviewPath,
    readFileSync(overviewPath, "utf8").replace("<!-- o2b:end summary -->", ""),
  );
  const res = await runCli(["brain", "architect", project, "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("repair the sentinel markers");
});

test("missing path argument prints usage", async () => {
  const res = await runCli(["brain", "architect", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("usage: o2b brain architect");
});
