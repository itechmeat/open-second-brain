/**
 * The suite preload removes `OPEN_SECOND_BRAIN_EMBEDDING_*` twins a
 * developer exports for daily use, unless the run opts out. Proved in a
 * child `bun test` run so the variable is really present at preload time.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEAKED = "OPEN_SECOND_BRAIN_EMBEDDING_MODEL";
const REPO_ROOT = join(import.meta.dir, "..");
let probeDir: string | undefined;

afterEach(() => {
  if (probeDir !== undefined) rmSync(probeDir, { recursive: true, force: true });
  probeDir = undefined;
});

function runProbe(extraEnv: Record<string, string>): { code: number; output: string } {
  probeDir = mkdtempSync(join(tmpdir(), "o2b-env-scrub-"));
  const probe = join(probeDir, "env-probe.test.ts");
  writeFileSync(
    probe,
    `import { test } from "bun:test";\n` +
      `test("probe", () => { console.log("seen=" + String(process.env["${LEAKED}"])); });\n`,
  );
  const child = Bun.spawnSync([process.execPath, "test", probe], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode ?? -1, output: child.stdout.toString() + child.stderr.toString() };
}

test("an exported embedding twin is gone before the first test file loads", () => {
  const run = runProbe({ [LEAKED]: "leaked-model" });
  expect(run.code).toBe(0);
  expect(run.output).toContain("seen=undefined");
});

test("O2B_TEST_KEEP_EMBEDDING_ENV=1 keeps it", () => {
  const run = runProbe({ [LEAKED]: "leaked-model", O2B_TEST_KEEP_EMBEDDING_ENV: "1" });
  expect(run.code).toBe(0);
  expect(run.output).toContain("seen=leaked-model");
});
