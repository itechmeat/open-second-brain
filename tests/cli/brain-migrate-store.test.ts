/**
 * `o2b brain migrate-store` (tasks 2.2 to 2.6): the dry run prints the
 * plan as text and as JSON and writes nothing anywhere under the sandbox
 * (vault, HOME, state and config directories alike); the real run refuses
 * while legacy entries are unmapped, then migrates the vault and records
 * the switch; a re-run imports late legacy writes, `--remove-legacy` stays
 * closed while other devices still write the legacy layout, and
 * `--rollback` returns the machine to it (and is refused with no migration
 * on this machine). Conflicting flag combinations are usage errors.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeLegacyVault,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";
import { digestVaultTree } from "../helpers/vault-digest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fx: LegacyVaultFixture;
let env: Record<string, string>;

beforeEach(() => {
  fx = makeLegacyVault("osb-cli-migrate-store-");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(fx.parent, "home"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    [STORE_ROOT_ENV]: join(fx.parent, "store"),
    O2B_DEVICE_ID: "dev-a",
  };
});
afterEach(() => fx.cleanup());

const migrate = (...args: string[]) =>
  runCli(["brain", "migrate-store", "--vault", fx.vault, ...args], { env });

describe("o2b brain migrate-store --dry-run", () => {
  test("--json prints the plan and fails on unmapped entries, writing nothing", async () => {
    const before = digestVaultTree(fx.parent, { mtime: true });
    const res = await migrate("--dry-run", "--json");
    expect(digestVaultTree(fx.parent, { mtime: true })).toBe(before);
    expect(res.returncode).toBe(1);
    const plan = JSON.parse(res.stdout) as {
      dry_run: boolean;
      ok: boolean;
      devices: { cohort: Array<{ device: string }>; roster: string[] };
      unmapped: Array<{ path: string }>;
      unparseable: Array<{ path: string; line: number | null }>;
      surfaces: Array<{ id: string; items: number; planned: string }>;
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.ok).toBe(false);
    expect(plan.devices.cohort.map((d) => d.device)).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(plan.devices.roster).toEqual(["dev-a", "dev-b"]);
    expect(plan.unmapped.map((u) => u.path)).toContain("Brain/procedures/index.bin");
    expect(plan.unparseable).toContainEqual(
      expect.objectContaining({ path: "Brain/log/2026-11-01.dev-b.jsonl", line: 2 }),
    );
    expect(plan.surfaces.find((s) => s.id === "signals")?.items).toBe(3);
  });

  test("the text form names devices, destinations, unparseable and unmapped entries", async () => {
    const before = digestVaultTree(fx.parent, { mtime: true });
    const res = await migrate("--dry-run");
    expect(digestVaultTree(fx.parent, { mtime: true })).toBe(before);
    expect(res.returncode).toBe(1);
    expect(res.stdout).toContain("dry run: nothing was written");
    expect(res.stdout).toContain("dev-c:");
    expect(res.stdout).toContain("not seen in 30 days");
    expect(res.stdout).toContain("-> stream log (log-event)");
    expect(res.stdout).toContain("Brain/log/2026-11-01.dev-b.jsonl:2 (brain_log): not JSON");
    expect(res.stdout).toContain("  Brain/procedures/index.bin\n");
  });

  test("exits 0 once every legacy entry has a destination", async () => {
    for (const rel of [
      "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
      "Brain/log/stray.txt",
      "Brain/procedures/index.bin",
    ]) {
      rmSync(join(fx.vault, ...rel.split("/")), { recursive: true });
    }
    const res = await migrate("--dry-run");
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("Every legacy entry has a destination.");
  });

  test.each([
    [["--dry-run", "--rollback"]],
    [["--rollback", "--remove-legacy"]],
    [["--resume", "--force-release-gate"]],
    [["--force"]],
    [["--dry-run", "--wait", "5"]],
    [["--rollback", "--wait", "5"]],
  ])("refuses %p as a usage error and changes nothing", async (args) => {
    const before = digestVaultTree(fx.parent, { mtime: true });
    const res = await migrate(...args);
    expect(res.returncode).toBe(2);
    expect(res.stdout).toBe("");
    expect(digestVaultTree(fx.parent, { mtime: true })).toBe(before);
  });

  test("--rollback with no migration on this machine is refused", async () => {
    initStore({ root: join(fx.parent, "store") });
    const res = await migrate("--rollback");
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("no migration backup to roll back to");
  });

  test("--dry-run and --resume cannot be combined", async () => {
    const res = await migrate("--dry-run", "--resume");
    expect(res.returncode).toBe(2);
  });
});

describe("o2b brain migrate-store --force-release-gate", () => {
  const gatePath = (): string =>
    join(fx.parent, "state", "open-second-brain", "migration-gate.json");
  const writeGate = (pid: number): void => {
    mkdirSync(dirname(gatePath()), { recursive: true });
    writeFileSync(
      gatePath(),
      JSON.stringify({ vault: fx.vault, run_id: "migrate-gone", since: "", pid }),
    );
  };

  test("releases a gate whose run is gone and names it", async () => {
    // A pid no live process can hold.
    writeGate(2 ** 31 - 2);
    const res = await migrate("--force-release-gate");
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("Released the migration gate of run migrate-gone");
    expect(existsSync(gatePath())).toBe(false);
  });

  test("with no gate held, changes nothing", async () => {
    const res = await migrate("--force-release-gate", "--json");
    expect(res.returncode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ kind: "none" });
  });
});

describe("o2b brain migrate-store", () => {
  test("refuses while legacy entries are unmapped, naming them", async () => {
    initStore({ root: join(fx.parent, "store") });
    const res = await migrate("--json");
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("have no destination");
    expect(res.stderr).toContain("Brain/procedures/index.bin");
  });

  test("migrates the vault and records the switch", async () => {
    for (const rel of [
      "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
      "Brain/log/stray.txt",
      "Brain/procedures/index.bin",
    ]) {
      rmSync(join(fx.vault, ...rel.split("/")), { recursive: true });
    }
    initStore({ root: join(fx.parent, "store") });
    const res = await migrate("--json");
    expect([res.returncode, res.stderr]).toEqual([0, ""]);
    const result = JSON.parse(res.stdout) as {
      ok: boolean;
      imported: number;
      device: string;
      mode: string;
      role: string;
      migration_done: string | null;
      device_switched: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.device).toBe("dev-a");
    expect([result.mode, result.role]).toEqual(["migration", "first"]);
    expect(result.imported).toBeGreaterThan(10);
    expect(result.device_switched).not.toBeNull();
    const again = await migrate();
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain(
      "already switched to the brain store; imported late legacy writes",
    );
    expect(again.stdout).toContain("devices still on the legacy layout: dev-b, dev-c");
    const blocked = await migrate("--remove-legacy");
    expect(blocked.returncode).toBe(1);
    expect(blocked.stdout).toContain("dev-b, dev-c still write the legacy layout");
    const back = await migrate("--rollback");
    expect([back.returncode, back.stderr]).toEqual([0, ""]);
    expect(back.stdout).toContain("is back on the legacy layout");
  }, 60_000);
});
