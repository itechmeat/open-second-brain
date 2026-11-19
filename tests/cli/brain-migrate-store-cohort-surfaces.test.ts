/**
 * One judgement of the migration cohort on every surface (change
 * stale-device-retirement, design D5-D7): on a switched machine whose
 * cohort holds a switched device, a pending one and two retired by
 * silence, every surface that names the devices still on the legacy
 * layout names the same pending device, and none of them names a device
 * retired by silence as pending: `o2b brain migrate-store` (text and
 * `--json`), `--remove-legacy`, `o2b status --json` and `o2b brain
 * doctor --json`. Runs the CLI as a subprocess with every host home inside the
 * fixture.
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
  fx = makeLegacyVault("osb-cli-cohort-surfaces-");
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

/**
 * dev-a migrated (switched); the threshold is 10 days, so dev-b
 * (2026-11-02) and dev-c (2026-09) are retired by silence; dev-p, on an
 * old release, wrote a log row now: it is pending.
 */
async function oneOfEachKind(): Promise<void> {
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
  const now = new Date();
  writeFileSync(
    join(fx.vault, "Brain", "log", `${now.toISOString().slice(0, 10)}.dev-p.jsonl`),
    `${JSON.stringify({ ts: now.toISOString(), event_type: "note", text: "live" })}\n`,
  );
}

/** Every object anywhere in `value` for which `pick` answers. */
function find<T>(value: unknown, pick: (o: Record<string, unknown>) => T | undefined): T[] {
  const out: T[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      const hit = pick(v as Record<string, unknown>);
      if (hit !== undefined) out.push(hit);
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return out;
}

const devicesOf = (list: unknown): string[] =>
  (list as Array<string | { device: string }>).map((d) => (typeof d === "string" ? d : d.device));

describe("every surface names the same devices still on the legacy layout", () => {
  test("pending: dev-p only; retired by silence: dev-b and dev-c, never as pending", async () => {
    await oneOfEachKind();
    const pending: Record<string, string[]> = {};
    const silent: Record<string, string[]> = {};

    const json = await migrate("--json");
    expect(json.stderr).toBe("");
    const transition = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(transition["mode"]).toBe("transition");
    pending["migrate-store --json"] = devicesOf(transition["legacy_devices"]);
    silent["migrate-store --json"] = devicesOf(transition["retired_by_silence"]);

    const text = await migrate();
    const line = text.stdout
      .split("\n")
      .find((l) => l.startsWith("devices still on the legacy layout: "));
    expect(line).toBeDefined();
    pending["migrate-store"] = line!
      .slice("devices still on the legacy layout: ".length)
      .split(", ")
      .map((d) => d.replace(/ \(.*\)$/, ""));
    expect(text.stdout).toMatch(
      /retired by silence \(.*\): dev-b \(last evidence 2026-11-02\), dev-c/,
    );

    const removal = JSON.parse((await migrate("--remove-legacy", "--json")).stdout) as Record<
      string,
      unknown
    >;
    pending["migrate-store --remove-legacy --json"] = devicesOf(removal["pending"]);
    silent["migrate-store --remove-legacy --json"] = devicesOf(removal["retired_by_silence"]);

    const status = JSON.parse((await cli("status", "--json")).stdout) as unknown;
    const cohorts = find(status, (o) =>
      "cohort" in o && o["cohort"] !== null && typeof o["cohort"] === "object"
        ? (o["cohort"] as Record<string, unknown>)
        : undefined,
    );
    expect(cohorts.length).toBe(1);
    pending["status --json"] = devicesOf(cohorts[0]!["pending"]);
    silent["status --json"] = devicesOf(cohorts[0]!["retired_by_silence"]);

    const doctor = JSON.parse(
      (await cli("brain", "doctor", "--json", "--vault", fx.vault)).stdout,
    ) as unknown;
    const finding = find(doctor, (o) =>
      o["code"] === "legacy-devices-pending" ? String(o["message"]) : undefined,
    );
    expect(finding.length).toBe(1);
    const named = /switched to the brain store; (.+?) still writes? the legacy/.exec(finding[0]!);
    expect(named).not.toBeNull();
    pending["doctor --json"] = named![1]!.split(", ");

    for (const [surface, devices] of Object.entries(pending)) {
      expect([surface, devices]).toEqual([surface, ["dev-p"]]);
    }
    for (const [surface, devices] of Object.entries(silent)) {
      expect([surface, devices]).toEqual([surface, ["dev-b", "dev-c"]]);
    }
  });
});
