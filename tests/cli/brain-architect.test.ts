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

interface ManifestEntry {
  path: string;
  ecosystem: string;
  status: string;
  detail?: string;
}

test("--json always carries the manifests the scan found, sorted by path", async () => {
  mkdirSync(join(project, "src", "py"), { recursive: true });
  writeFileSync(join(project, "src", "py", "pyproject.toml"), "[project\n");
  writeFileSync(join(project, "pom.xml"), "<project/>\n");

  const res = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const manifests = (JSON.parse(res.stdout) as { manifests: ManifestEntry[] }).manifests;
  expect(manifests.map(({ path, ecosystem, status }) => ({ path, ecosystem, status }))).toEqual([
    { path: "package.json", ecosystem: "npm", status: "read" },
    { path: "pom.xml", ecosystem: "maven", status: "unsupported" },
    { path: "src/py/pyproject.toml", ecosystem: "pypi", status: "malformed" },
  ]);
  expect(manifests[0]).not.toHaveProperty("detail");
  expect(manifests[2]!.detail).toBeTruthy();
});

test("--json carries an empty manifests list when the project has none", async () => {
  rmSync(join(project, "package.json"));
  const res = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
  expect((JSON.parse(res.stdout) as { manifests: ManifestEntry[] }).manifests).toEqual([]);
});

test("text mode names the manifests not read, and only when there are some", async () => {
  const clean = await runCli(["brain", "architect", project, "--vault", vault]);
  expect(clean.returncode).toBe(0);
  expect(clean.stdout).not.toContain("not read");

  writeFileSync(join(project, "pom.xml"), "<project/>\n");
  const res = await runCli(["brain", "architect", project, "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("manifests not read: pom.xml (unsupported)");
});

// A control character cannot be part of a directory name on Windows.
test.skipIf(process.platform === "win32").each([
  ["C0", "x\u001b]0;title\u0007\u001b[2J"],
  ["C1", "x\u009b2J\u009d0;title\u009c"],
])("the line naming manifests not read prints no %s control character", async (_set, name) => {
  const dir = join(project, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{ not json");
  writeFileSync(join(dir, "index.ts"), "export {};\n");
  const res = await runCli(["brain", "architect", project, "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("manifests not read:");
  expect(res.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test("help names the runtime-only scan and every flag", async () => {
  const res = await runCli(["brain", "architect", "--help"]);
  const text = res.stdout + res.stderr;
  expect(text).toContain("built-in runtime only, no dependency");
  expect(text).not.toContain("stdlib-only");
  expect(text).toContain(
    "usage: o2b brain architect <project-path> [--vault V] [--progress] [--json]",
  );
});
