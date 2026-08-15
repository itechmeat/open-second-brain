/**
 * When the ownership close fires, and when it must not.
 *
 * `o2b install --check` exits 0 for `not-installed` by design - the
 * operator never asked for that runtime - so "exit 0" is the wrong trigger
 * for a statement congratulating them on owning their brain: on a machine
 * where the install did nothing, it would be the only output. The close is
 * bound to a target that verified `ok`, and to an apply that ran, which are
 * the two states where something was actually established.
 *
 * The second thing pinned here is PARITY. The human `--check` table is
 * pinned byte-for-byte against the install documents and the JSON twin is
 * pinned by this file; nothing else would notice a close that reached one
 * surface and not the other, which is exactly how the two drifted before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";

function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-ioc-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-ioc-h-"));
  configPath = join(home, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function envBase() {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
  };
}

/**
 * Every case here spawns real `o2b` children, which cost about two seconds
 * of module graph each. The default five would make this file fail for
 * being slow rather than for being wrong.
 */
const CLI_TIMEOUT_MS = 30_000;

/** The heading the composed statement always opens with. */
const CLOSE_HEADING = "Your data, and where it is:";

describe("a successful apply closes by saying what the operator owns", () => {
  test(
    "the human surface names the resolved vault and the exceptions",
    async () => {
      const r = await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
      expect(r.returncode).toBe(0);
      expect(r.stdout).toContain(CLOSE_HEADING);
      expect(r.stdout).toContain(vault);
      // The counterexample is named rather than omitted.
      expect(r.stdout).toContain("opencode session spool");
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "the machine surface carries the same value under data_ownership",
    async () => {
      const r = await runCli(["install", "--target", "cursor", "--apply", "--json"], {
        env: envBase(),
      });
      expect(r.returncode).toBe(0);
      const payload = JSON.parse(r.stdout) as Record<string, unknown>;
      const ownership = payload["data_ownership"] as Record<string, unknown>;
      expect(ownership).toBeDefined();
      expect(ownership["vault"]).toBe(vault);
      // A verdict is always present, and it is allowed to be `undetermined`.
      expect(typeof (ownership["backing"] as Record<string, unknown>)["state"]).toBe("string");
      expect((ownership["outside_vault"] as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    },
    CLI_TIMEOUT_MS,
  );
});

describe("a verify only closes when something verified ok", () => {
  test(
    "with nothing installed the close stays silent on both surfaces",
    async () => {
      const human = await runCli(["install", "--check"], { env: envBase() });
      expect(human.returncode).toBe(0);
      expect(human.stdout).toContain("not-installed");
      expect(human.stdout).not.toContain(CLOSE_HEADING);

      const machine = await runCli(["install", "--check", "--json"], { env: envBase() });
      expect(machine.returncode).toBe(0);
      expect(JSON.parse(machine.stdout)["data_ownership"]).toBeUndefined();
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "after an install, a passing check closes on both surfaces",
    async () => {
      await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });

      const human = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
      expect(human.returncode).toBe(0);
      expect(human.stdout).toContain(CLOSE_HEADING);

      const machine = await runCli(["install", "--check", "--target", "cursor", "--json"], {
        env: envBase(),
      });
      expect(machine.returncode).toBe(0);
      const ownership = JSON.parse(machine.stdout)["data_ownership"] as Record<string, unknown>;
      expect(ownership["vault"]).toBe(vault);
      // Three subprocess CLI runs: an apply plus both check surfaces.
    },
    CLI_TIMEOUT_MS,
  );
});

describe("the onboarding checklist carries the same field", () => {
  test(
    "o2b onboarding --json exposes data_ownership beside the steps",
    async () => {
      const r = await runCli(["onboarding", "--json"], { env: envBase() });
      expect(r.returncode).toBe(0);
      const payload = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(payload["steps"]).toBeDefined();
      const ownership = payload["data_ownership"] as Record<string, unknown>;
      expect(ownership["vault"]).toBe(vault);
      expect(ownership["backing"]).toBeDefined();
    },
    CLI_TIMEOUT_MS,
  );
});
