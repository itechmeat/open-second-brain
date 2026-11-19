/**
 * `o2b update` and the store migration (change auto-store-migration,
 * design D4): after updating, the update runs the same check the start
 * runs and, with a migration available, the same worker logic in the
 * foreground, with progress on stderr. The outcome is named in the text
 * and in the `store_migration` field of `--json`; a migration failure does
 * not fail the update. `--skip-store-migration` skips it once; an
 * opted-out machine is offered the migration and never runs it.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeLegacyVault,
  UNMAPPED_LEGACY_ENTRIES,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { dropUnparseable } from "../core/store-migration/fixtures/migration-env.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

interface StoreMigrationField {
  outcome: string;
  error: string | null;
  manual_command: string | null;
}

let fx: LegacyVaultFixture;
let env: Record<string, string>;
let storeRoot: string;
beforeEach(() => {
  fx = makeLegacyVault("osb-cli-update-migrate-");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  storeRoot = join(fx.parent, "store");
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(fx.parent, "home"),
    USERPROFILE: join(fx.parent, "home"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    [STORE_ROOT_ENV]: storeRoot,
    O2B_DEVICE_ID: "dev-a",
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
    // Every agent host's configuration directory inside the fixture, even
    // when the developer exports one of these for daily use.
    CODEX_HOME: join(fx.parent, "home", ".codex"),
    GROK_HOME: join(fx.parent, "home", ".grok"),
    PI_HOME: join(fx.parent, "home", ".pi"),
  };
});
afterEach(() => fx.cleanup());

/**
 * Drop the fixture's deliberately unmapped entries and its unparseable
 * line, so the automatic migration can run.
 */
function mapEverything(): void {
  for (const rel of UNMAPPED_LEGACY_ENTRIES) {
    rmSync(join(fx.vault, ...rel.split("/")), { force: true });
  }
  dropUnparseable(fx.vault);
}

// In its own process: `o2b update` takes the home directory from
// `os.homedir()`, which reads the real environment, so an in-process run
// would hand every agent host the developer's real home whatever HOME the
// fixture names.
const update = (...args: string[]) => runCli(["update", ...args], { env, subprocess: true });

function field(stdout: string): StoreMigrationField {
  return (JSON.parse(stdout) as { store_migration: StoreMigrationField }).store_migration;
}

describe("o2b update stays inside the fixture", () => {
  test("it re-registers the Codex host in the fixture's Codex home, never the real one", async () => {
    // Open Second Brain is registered with Codex on this (fixture) machine,
    // so the update re-registers it: through the Codex CLI when one is
    // installed, which writes the Codex home it is handed, or through the
    // file merge. On a machine with Codex installed, an update that ran with
    // the developer's real home rewrote the developer's real configuration.
    const codexHome = join(fx.parent, "home", ".codex");
    mkdirSync(codexHome, { recursive: true });
    const config = join(codexHome, "config.toml");
    writeFileSync(
      config,
      [
        "[mcp_servers.open-second-brain]",
        'command = "o2b"',
        'args = ["mcp", "--vault", "/earlier/vault"]',
        "",
        "[mcp_servers.open-second-brain-writer]",
        'command = "o2b"',
        'args = ["mcp", "--writer-only", "--vault", "/earlier/vault"]',
        "",
      ].join("\n"),
    );
    mapEverything();
    const res = await update("--json");
    expect(res.returncode).toBe(0);
    // Read as TOML, not as text: the file holds the path TOML-escaped (on
    // Windows every backslash doubled), and the command line may be wrapped
    // (`cmd /d /c o2b ...` on Windows), so the parsed `--vault` value is the
    // one compared.
    const parsed = Bun.TOML.parse(readFileSync(config, "utf8")) as {
      mcp_servers?: Record<string, { args?: unknown }>;
    };
    for (const server of ["open-second-brain", "open-second-brain-writer"]) {
      const args = parsed.mcp_servers?.[server]?.args;
      expect(Array.isArray(args)).toBe(true);
      const list = args as unknown[];
      expect(list[list.indexOf("--vault") + 1]).toBe(fx.vault);
    }
  });
});

describe("o2b update runs the store migration", () => {
  test("applied: the migration runs in the foreground with progress on stderr", async () => {
    mapEverything();
    const res = await update("--json");
    expect(res.returncode).toBe(0);
    expect(field(res.stdout).outcome).toBe("applied");
    expect(res.stderr).toContain("store migration: running the migration");
    expect(existsSync(storeRoot)).toBe(true);
  });

  test("the text output names the outcome", async () => {
    mapEverything();
    const res = await update();
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("store migration: applied");
  });

  test("failed: named in the output, and the update still succeeds", async () => {
    // The fixture's unmapped entries make the dry run refuse.
    const res = await update("--json");
    expect(res.returncode).toBe(0);
    const outcome = field(res.stdout);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.error).toContain("no destination");
    expect(outcome.manual_command).toBe("o2b brain migrate-store --dry-run");
  });

  test("--skip-store-migration skips it once", async () => {
    mapEverything();
    const res = await update("--json", "--skip-store-migration");
    expect(res.returncode).toBe(0);
    expect(field(res.stdout).outcome).toBe("skipped");
    expect(existsSync(storeRoot)).toBe(false);
  });

  test("an opted-out machine is offered the migration and never runs it", async () => {
    mapEverything();
    env["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"] = "false";
    const res = await update("--json");
    expect(res.returncode).toBe(0);
    const outcome = field(res.stdout);
    expect(outcome.outcome).toBe("disabled");
    // No store yet: the commands to run by hand, in order.
    expect(outcome.manual_command).toBe("o2b store init, then o2b brain migrate-store --dry-run");
    expect(existsSync(storeRoot)).toBe(false);
  });

  test("--dry-run names the pending migration and runs nothing", async () => {
    mapEverything();
    const res = await update("--json", "--dry-run");
    expect(res.returncode).toBe(0);
    expect(field(res.stdout).outcome).toBe("pending");
    expect(existsSync(storeRoot)).toBe(false);
  });
});
