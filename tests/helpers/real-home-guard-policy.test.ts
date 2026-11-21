/**
 * The real-home guard as the preload installs it, proved in a child
 * `bun test` run whose start environment names a fake home: a change that
 * names a temp root of the child's run fails its test everywhere; one that
 * does not (another process may have made it) fails only on CI and is
 * otherwise listed once at the end of the run.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "./cli-timeout.ts";
import { tempDirs } from "./temp-dir.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const mkTemp = tempDirs();

/** Variables of the parent's environment that would point the child's guard elsewhere. */
const DROPPED = [
  "CI",
  "O2B_TEST_REAL_HOME_GUARD",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "PI_HOME",
  "OSB_HERMES_JOBS",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_STORE_ROOT",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

/**
 * Runs `body` as one test in a child `bun test` whose start environment
 * puts every per-user location under a fresh fake home with an existing
 * `.codex/config.toml`. `body` sees that home as `FAKE_HOME`.
 */
function runChild(
  body: string,
  extraEnv: Record<string, string>,
): { code: number; output: string } {
  const dir = mkTemp("osb-guard-policy-");
  const home = join(dir, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
  const probe = join(dir, "probe.test.ts");
  writeFileSync(
    probe,
    [
      'import { test } from "bun:test";',
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'const FAKE_HOME = process.env["FAKE_HOME"] as string;',
      `test("probe", () => { ${body} });`,
      "",
    ].join("\n"),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(DROPPED as ReadonlyArray<string>).includes(k)) env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    FAKE_HOME: home,
    ...extraEnv,
  });
  const child = Bun.spawnSync([process.execPath, "test", probe], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode ?? -1, output: child.stdout.toString() + child.stderr.toString() };
}

const STRAY = 'writeFileSync(join(FAKE_HOME, ".codex", "stray.json"), "{}");';
const ATTRIBUTED =
  'writeFileSync(join(FAKE_HOME, ".codex", "leak.json"), JSON.stringify({ cwd: tmpdir() }));';
const APPENDED =
  'appendFileSync(join(FAKE_HOME, ".codex", "config.toml"), `cwd = "${tmpdir()}"\\n`);';

describe("the installed real-home guard", () => {
  test("off CI, a change that names no temp root of the run is listed at the end, not failed", () => {
    const run = runChild(STRAY, {});
    expect(run.output).toContain("real-home guard: 1 change");
    expect(run.output).toContain(join(".codex", "stray.json"));
    expect(run.output).toContain("another process");
    expect(run.code).toBe(0);
  });

  test("on CI the same change fails the test, saying another process may have made it", () => {
    const run = runChild(STRAY, { CI: "true" });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("names no temp root of this run");
    expect(run.output).toContain("may have been written by another process");
  });

  test("off CI, a new entry that names a temp root of the run fails the test", () => {
    const run = runChild(ATTRIBUTED, {});
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(
      `${join(".codex", "leak.json")} (new entry; names a temp root of this test run)`,
    );
  });

  test("off CI, an append to an existing host config that names a temp root of the run fails the test", () => {
    const run = runChild(APPENDED, {});
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(
      `${join(".codex", "config.toml")} (content changed; names a temp root of this test run)`,
    );
  });
});
