/**
 * The suite preload removes `OPEN_SECOND_BRAIN_EMBEDDING_*` twins a
 * developer exports for daily use, unless the run opts out, and replaces
 * the user-data roots (config, state, data, dedup cache) even when the run
 * exports them. Proved in a child `bun test` run so the variables are
 * really present at preload time.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEAKED = "OPEN_SECOND_BRAIN_EMBEDDING_MODEL";
const KEEP_OPT_OUT = "O2B_TEST_KEEP_EMBEDDING_ENV";
const REPO_ROOT = join(import.meta.dir, "..");
let probeDir: string | undefined;

afterEach(() => {
  if (probeDir !== undefined) rmSync(probeDir, { recursive: true, force: true });
  probeDir = undefined;
});

function runProbe(
  extraEnv: Record<string, string>,
  names: ReadonlyArray<string> = [LEAKED],
): { code: number; output: string } {
  probeDir = mkdtempSync(join(tmpdir(), "o2b-env-scrub-"));
  const probe = join(probeDir, "env-probe.test.ts");
  const prints = names
    .map((name) => `console.log("${name}=" + String(process.env["${name}"]));`)
    .join(" ");
  writeFileSync(probe, `import { test } from "bun:test";\ntest("probe", () => { ${prints} });\n`);
  // A suite run with the opt-out set would hand it to every probe; each
  // probe states it explicitly instead.
  const { [KEEP_OPT_OUT]: _inherited, ...baseEnv } = process.env;
  const child = Bun.spawnSync([process.execPath, "test", probe], {
    cwd: REPO_ROOT,
    env: { ...baseEnv, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode ?? -1, output: child.stdout.toString() + child.stderr.toString() };
}

test("an exported embedding twin is gone before the first test file loads", () => {
  const run = runProbe({ [LEAKED]: "leaked-model" });
  expect(run.code).toBe(0);
  expect(run.output).toContain(`${LEAKED}=undefined`);
});

test(`${KEEP_OPT_OUT}=1 keeps it`, () => {
  const run = runProbe({ [LEAKED]: "leaked-model", [KEEP_OPT_OUT]: "1" });
  expect(run.code).toBe(0);
  expect(run.output).toContain(`${LEAKED}=leaked-model`);
});

test("exported user-data roots never reach the suite: the preload replaces each", () => {
  const exported: Record<string, string> = {
    XDG_STATE_HOME: join(tmpdir(), "exported-real-state"),
    XDG_DATA_HOME: join(tmpdir(), "exported-real-data"),
    OPEN_SECOND_BRAIN_CONFIG: join(tmpdir(), "exported-real-config.yaml"),
    OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR: join(tmpdir(), "exported-real-dedup"),
  };
  const run = runProbe(exported, Object.keys(exported));
  expect(run.code).toBe(0);
  for (const [name, value] of Object.entries(exported)) {
    expect(run.output).toContain(`${name}=`);
    expect(run.output).not.toContain(`${name}=${value}`);
  }
});

test("an exported vault never reaches the suite: VAULT_DIR and OPEN_SECOND_BRAIN_VAULT are dropped", () => {
  const exported = {
    VAULT_DIR: join(tmpdir(), "exported-real-vault"),
    OPEN_SECOND_BRAIN_VAULT: join(tmpdir(), "exported-real-vault"),
  };
  const run = runProbe(exported, Object.keys(exported));
  expect(run.code).toBe(0);
  expect(run.output).toContain("VAULT_DIR=undefined");
  expect(run.output).toContain("OPEN_SECOND_BRAIN_VAULT=undefined");
});
