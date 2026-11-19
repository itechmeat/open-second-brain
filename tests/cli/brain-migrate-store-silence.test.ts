/**
 * `o2b brain migrate-store --remove-legacy` with devices retired by
 * silence (change stale-device-retirement, design D6): the text and
 * `--json` reports name the devices that switched and, apart from them,
 * each device retired by silence with its last evidence date; a pending
 * device still refuses the removal. Runs the CLI as a subprocess with
 * every host home inside the fixture.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeLegacyVault,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fx: LegacyVaultFixture;
let env: Record<string, string>;

beforeEach(() => {
  fx = makeLegacyVault("osb-cli-silence-");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(fx.parent, "home"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    APPDATA: join(fx.parent, "data"),
    [STORE_ROOT_ENV]: join(fx.parent, "store"),
    O2B_DEVICE_ID: "dev-a",
  };
});
afterEach(() => fx.cleanup());

const cli = (...args: string[]) => runCli([...args], { env });
const migrate = (...args: string[]) => cli("brain", "migrate-store", "--vault", fx.vault, ...args);

/** Migrate dev-a and set the threshold to 10 days: dev-b (2026-11-02) and dev-c (2026-09) are silent. */
async function migratedWithTenDays(): Promise<void> {
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
  const set = await cli(
    "brain",
    "settings",
    "set",
    "migration.silent_device_days",
    "10",
    "--vault",
    fx.vault,
  );
  expect([set.returncode, set.stderr]).toEqual([0, ""]);
}

/** dev-p, on an old release, wrote a log row now: it is pending. */
function pendingDevice(): string {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  writeFileSync(
    join(fx.vault, "Brain", "log", `${day}.dev-p.jsonl`),
    `${JSON.stringify({ ts: now.toISOString(), event_type: "note", text: "live" })}\n`,
  );
  return day;
}

describe("o2b brain migrate-store --remove-legacy with devices retired by silence", () => {
  test("a pending device refuses; text names it with its date, and the silent ones apart", async () => {
    await migratedWithTenDays();
    const day = pendingDevice();
    const res = await migrate("--remove-legacy");
    expect(res.returncode).toBe(1);
    expect(res.stdout).toContain(`dev-p still writes the legacy layout (last evidence ${day})`);
    expect(res.stdout).toContain("switched: dev-a");
    expect(res.stdout).toMatch(
      /retired by silence \(no evidence of life for more than 10 days before \d{4}-\d{2}-\d{2}\): dev-b \(last evidence 2026-11-02\), dev-c \(last evidence 2026-09-01\)/,
    );
  });

  test("--json of a refusal carries the lists", async () => {
    await migratedWithTenDays();
    pendingDevice();
    const res = await migrate("--remove-legacy", "--json");
    expect(res.returncode).toBe(1);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      removed: false,
      reason: "cohort-pending",
      pending: ["dev-p"],
      switched: ["dev-a"],
      retired_by_silence: [
        { device: "dev-b", last_evidence: "2026-11-02T00:00:00.000Z" },
        { device: "dev-c", last_evidence: "2026-09-01T00:00:00.000Z" },
      ],
      silence_threshold_days: 10,
    });
    expect(typeof out["as_of"]).toBe("string");
  });

  test("only silent devices left: the tree leaves; text and --json name them", async () => {
    await migratedWithTenDays();
    const res = await migrate("--remove-legacy", "--json");
    expect([res.returncode, res.stderr]).toEqual([0, ""]);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      removed: true,
      forced: false,
      stopped: [],
      switched: ["dev-a"],
      retired_by_silence: [
        { device: "dev-b", last_evidence: "2026-11-02T00:00:00.000Z" },
        { device: "dev-c", last_evidence: "2026-09-01T00:00:00.000Z" },
      ],
      silence_threshold_days: 10,
    });
  });

  test("the text report of a removal names the switched and the silent devices", async () => {
    await migratedWithTenDays();
    const res = await migrate("--remove-legacy");
    expect([res.returncode, res.stderr]).toEqual([0, ""]);
    expect(res.stdout).toContain("switched: dev-a");
    expect(res.stdout).toMatch(
      /retired by silence \(no evidence of life for more than 10 days before \d{4}-\d{2}-\d{2}\): dev-b \(last evidence 2026-11-02\), dev-c \(last evidence 2026-09-01\)/,
    );
  });
});
