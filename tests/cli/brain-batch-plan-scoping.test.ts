/**
 * P2 (t_e82101a5): the `o2b brain batch-plan` CLI plumbs `--src-subpath` and
 * `--exclude` through to planBatches. Behavior is covered at the core level;
 * this asserts the flags reach the planner and that omitting them is unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "../helpers/run-cli.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-cli-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function write(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "content\n", "utf8");
}

const ENV = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain batch-plan scoping flags", () => {
  test("--src-subpath restricts discovery to the subtree", async () => {
    write("mono/pkg/a/one.md");
    write("mono/pkg/b/two.md");
    const res = await runCli(["brain", "batch-plan", "mono", "--src-subpath", "pkg/a", "--json"], {
      env: ENV(),
    });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    const paths = plan.batches.flatMap((b: { files: { path: string }[] }) =>
      b.files.map((f) => f.path),
    );
    expect(paths).toContain("mono/pkg/a/one.md");
    expect(paths).not.toContain("mono/pkg/b/two.md");
  });

  test("--exclude drops matching files", async () => {
    write("mono/keep.md");
    write("mono/vendor/dep.md");
    const res = await runCli(["brain", "batch-plan", "mono", "--exclude", "vendor/", "--json"], {
      env: ENV(),
    });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    const paths = plan.batches.flatMap((b: { files: { path: string }[] }) =>
      b.files.map((f) => f.path),
    );
    expect(paths).toEqual(["mono/keep.md"]);
  });

  test("a subpath escaping the source root fails with a nonzero exit", async () => {
    write("mono/a.md");
    const res = await runCli(
      ["brain", "batch-plan", "mono", "--src-subpath", "../../etc", "--json"],
      { env: ENV() },
    );
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toMatch(/escapes|outside/i);
  });
});
