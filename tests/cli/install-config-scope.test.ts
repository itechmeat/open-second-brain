/**
 * One run, one config file - and one refusal, printed as one line.
 *
 * Two operator-visible defects live at the same seam:
 *
 *   1. `o2b install --config <p>` used to parameterise only half the run.
 *      The agent name, timezone and vault came from `<p>`; the
 *      install-settings ladder (`install_hook_timeout_seconds`,
 *      `mcp_tool_profile`) came from the machine default, because
 *      `InstallEnv` carried no config path and the resolver fell back. On
 *      a machine with both files populated, `--apply` generated from one
 *      and `--check` verified against the other.
 *   2. An unreadable `<vault>/Brain/_brain.yaml` escaped `main()` as a
 *      stack trace. The refusal is correct - a writer cannot infer intent
 *      from bytes it could not parse - but `main()` handled only
 *      `CliError`, `NoVaultConfiguredError` and `ConfigReadError`, so a
 *      single typo crashed plain `o2b install` before it printed the
 *      status of ANY target, including the nine that never read that file.
 */

import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";
import { INSTALL_EXIT } from "../../src/cli/install/install.ts";

function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
/** The file the MACHINE would pick if nobody passed `--config`. */
let machineConfig: string;
/** The file the operator names on the command line. */
let namedConfig: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-cfgscope-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-cfgscope-h-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(home, ".config", "open-second-brain"), { recursive: true });
  machineConfig = join(home, ".config", "open-second-brain", "config.yaml");
  namedConfig = join(home, "named.yaml");
  const body = `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`;
  writeFileSync(machineConfig, `${body}mcp_tool_profile: recall\n`);
  writeFileSync(namedConfig, `${body}mcp_tool_profile: minimal\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

/**
 * A shell that has named NEITHER `OPEN_SECOND_BRAIN_CONFIG` nor
 * `XDG_CONFIG_HOME`, so the machine default really is `$HOME/.config/...`
 * and `--config` is the only thing that can point elsewhere.
 */
function bareEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, ...extra };
}

function cursorArgs(): ReadonlyArray<string> {
  const parsed = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  return parsed.mcpServers["open-second-brain"]!.args;
}

describe("--config parameterises the whole run", () => {
  test("the named file supplies the tool profile, not the machine default", async () => {
    const applied = await runCli(
      ["install", "--target", "cursor", "--config", namedConfig, "--apply"],
      { env: bareEnv() },
    );
    expect(applied.returncode).toBe(INSTALL_EXIT.ok);
    const args = cursorArgs();
    expect(args).toContain("minimal");
    expect(args).not.toContain("recall");
  });

  test("--check against the same file reports no drift", async () => {
    await runCli(["install", "--target", "cursor", "--config", namedConfig, "--apply"], {
      env: bareEnv(),
    });
    const checked = await runCli(
      ["install", "--check", "--target", "cursor", "--config", namedConfig],
      { env: bareEnv() },
    );
    expect(`${checked.returncode}: ${checked.stdout}`).toContain("ok");
    expect(checked.returncode).toBe(INSTALL_EXIT.ok);
  });

  test("--check against the OTHER file honestly reports drift", async () => {
    // The two files disagree, so they must produce different bytes and the
    // check must say so. This is the control for the case above: a fix
    // that made every config path resolve to the same answer would pass
    // the first two cases and fail this one.
    await runCli(["install", "--target", "cursor", "--config", namedConfig, "--apply"], {
      env: bareEnv(),
    });
    const checked = await runCli(
      ["install", "--check", "--target", "cursor", "--config", machineConfig],
      { env: bareEnv() },
    );
    expect(checked.returncode).toBe(INSTALL_EXIT.drift);
  });
});

describe("an unreadable _brain.yaml is one line, not a stack trace", () => {
  beforeEach(() => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ninstall:\n  tool_profile: [broken\n",
    );
  });

  test("plain `o2b install` refuses with exit 1 and names the file", async () => {
    const result = await runCli(["install", "--config", namedConfig], { env: bareEnv() });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("error: ");
    expect(result.stderr).toContain(join(vault, "Brain", "_brain.yaml"));
    // A stack trace is the failure this case exists to prevent; the whole
    // refusal is one line.
    expect(result.stderr.trimEnd().split("\n").length).toBe(1);
  });

  test("`o2b install --check` refuses the same way", async () => {
    const result = await runCli(["install", "--check", "--config", namedConfig], {
      env: bareEnv(),
    });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain(join(vault, "Brain", "_brain.yaml"));
  });

  test("`o2b install --friction` stays a report and still exits 0", async () => {
    // A report has no notion of a bad answer, only of an honest one, so
    // the unresolvable cells name the refusal instead of taking the whole
    // surface down with them.
    const result = await runCli(["install", "--friction", "--json", "--config", namedConfig], {
      env: bareEnv(),
    });
    expect(result.returncode).toBe(INSTALL_EXIT.ok);
    const parsed = JSON.parse(result.stdout) as {
      friction: {
        targets: Array<{ target: string; cells: Array<{ value: string; detail: string | null }> }>;
      };
    };
    const unresolved = parsed.friction.targets.flatMap((t) =>
      t.cells.filter((c) => c.value === "unresolved"),
    );
    expect(unresolved.length).toBeGreaterThan(0);
    for (const cell of unresolved) expect(cell.detail ?? "").toContain("_brain.yaml");
  });
});
