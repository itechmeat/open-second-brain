/**
 * CLI tests for `o2b discipline report` (Task 2.12).
 *
 * Two cases per plan:
 *   1. Happy path — enabled config → exit 0, stdout contains "OSB discipline"
 *   2. Disabled config — enabled: false → exit 0, stderr contains "disabled"
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-discipline-cli-test-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function isolatedEnv(): Record<string, string> {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(tmp, "config"),
    XDG_DATA_HOME: join(tmp, "data"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    XDG_STATE_HOME: join(tmp, "state"),
    OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config", "open-second-brain", "config.yaml"),
    OPEN_SECOND_BRAIN_STORE_ROOT: join(tmp, "store"),
    CLAUDE_CONFIG_DIR: join(tmp, "claude"),
    CODEX_HOME: join(tmp, "codex"),
    CURSOR_HOME: join(tmp, "cursor"),
    GROK_HOME: join(tmp, "grok"),
    PI_HOME: join(tmp, "pi"),
    HERMES_HOME: join(tmp, "hermes"),
  };
}

describe("o2b discipline report", () => {
  test("install and uninstall are unknown commands and help names report only", async () => {
    const env = isolatedEnv();
    for (const verb of ["install", "uninstall"]) {
      const result = await runCli(["discipline", verb], { env, subprocess: true });
      expect(result.returncode).toBe(2);
      expect(result.stderr).toContain("unknown discipline subcommand");
    }
    const help = await runCli(["help"], { env, subprocess: true });
    expect(help.returncode).toBe(0);
    expect(help.stdout).toContain("discipline report");
    expect(help.stdout).not.toContain("discipline install");
    expect(help.stdout).not.toContain("discipline uninstall");
  });

  test("doctor names leftover jobs read-only and keeps its exit code", async () => {
    const home = join(tmp, "home");
    mkdirSync(home);
    const jobsFile = join(tmp, "hermes", "cron", "jobs.json");
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(tmp, "config"),
      XDG_DATA_HOME: join(tmp, "data"),
      XDG_CACHE_HOME: join(tmp, "cache"),
      XDG_STATE_HOME: join(tmp, "state"),
      CODEX_HOME: join(tmp, "codex"),
      CLAUDE_CONFIG_DIR: join(tmp, "claude"),
      GROK_HOME: join(tmp, "grok"),
      PI_HOME: join(tmp, "pi"),
      CURSOR_HOME: join(tmp, "cursor"),
      OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config", "open-second-brain", "config.yaml"),
      OPEN_SECOND_BRAIN_STORE_ROOT: join(tmp, "store"),
      OSB_HERMES_JOBS: jobsFile,
    };
    const init = await runCli(["init", "--vault", vault], {
      env,
      subprocess: true,
    });
    expect(init.returncode, init.stderr).toBe(0);
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "discipline_report:",
        "  enabled: false",
        "  timezone: UTC",
        "  watched_paths:",
        "  known_agents:",
      ].join("\n") + "\n",
    );
    const runDoctor = () =>
      runCli(["brain", "doctor", "--vault", vault], { env, subprocess: true });

    const baseline = await runDoctor();
    const contents =
      JSON.stringify(
        {
          jobs: [
            { id: "osb-discipline-report-a1", name: "old daily job" },
            { id: "osb-weekly-brain-digest-a1", name: "old weekly job" },
            { id: "unrelated", name: "other job" },
          ],
        },
        null,
        2,
      ) + "\n";
    mkdirSync(join(tmp, "hermes", "cron"), { recursive: true });
    writeFileSync(jobsFile, contents);
    const after = await runDoctor();

    expect(after.returncode).toBe(baseline.returncode);
    expect(after.stdout).toContain("discipline-legacy-jobs");
    expect(after.stdout).toContain(jobsFile);
    expect(after.stdout).toContain("osb-discipline-report-a1");
    expect(after.stdout).toContain("osb-weekly-brain-digest-a1");
    expect(after.stdout).toContain("hermes cron remove");
    expect(readFileSync(jobsFile, "utf8")).toBe(contents);
  });

  test("happy path: enabled config → exit 0, stdout contains 'OSB discipline'", async () => {
    // Use block-style empty sequences — the custom _brain.yaml parser does not
    // handle inline `[]`; it would fall through to a literal string, causing
    // the validator to silently drop the discipline_report section.
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "discipline_report:",
        "  enabled: true",
        "  timezone: UTC",
        "  watched_paths:",
        "  known_agents:",
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCli(["discipline", "report", "--vault", vault], {
      env: isolatedEnv(),
      subprocess: true,
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Open Second Brain discipline");
    expect(r.stdout).not.toContain("\\-");
    expect(r.stdout).toContain("Status: info");
  });

  test("disabled config → exit 0, stderr contains 'disabled'", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "discipline_report:",
        "  enabled: false",
        "  timezone: UTC",
        "  watched_paths:",
        "  known_agents:",
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCli(["discipline", "report", "--vault", vault], {
      env: isolatedEnv(),
      subprocess: true,
    });
    expect(r.returncode).toBe(0);
    expect(r.stderr).toContain("disabled");
  });
});
