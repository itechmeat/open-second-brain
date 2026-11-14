/**
 * `o2b store device list|retire`: the roster of devices the store knows
 * (id, last record, switched / legacy / retired) and the human
 * `device-retire` record that takes a gone machine off the digest roster
 * and out of the removal gate. This machine's own id is refused.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendRecord } from "../../src/core/store/appender.ts";
import { DEVICE_RETIRE_KIND, STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { partitionDir } from "../../src/core/store/store-paths.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-device-"));
  root = join(parent, "store");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(device = "dev-a"): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state", device),
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
    O2B_DEVICE_ID: device,
  };
}

/** A record written by another machine, with its own device-local state. */
function writeFrom(device: string): void {
  const store = openStore({
    root,
    device,
    dirs: {
      platform: process.platform,
      home: join(parent, "home", device),
      env: {
        XDG_STATE_HOME: join(parent, "state", device),
        LOCALAPPDATA: join(parent, "state", device),
      },
    },
  });
  appendRecord(store, {
    partition: "shared",
    stream: "log",
    kind: "log-event",
    agent: "t",
    body: { text: "hello" },
  });
}

function retireRecords() {
  return readPartition(partitionDir(root, "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === DEVICE_RETIRE_KIND);
}

describe("o2b store device", () => {
  test("list shows each device with its last record and state", async () => {
    initStore({ root });
    writeFrom("dev-b");
    const text = await runCli(["store", "device", "list"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toMatch(/dev-b\s+\d{4}-\d{2}-\d{2}T\S+\s+legacy/);

    const json = await runCli(["store", "device", "list", "--json"], { env: env() });
    const body = JSON.parse(json.stdout) as {
      ok: boolean;
      device: string;
      devices: Array<{
        device: string;
        state: string;
        last_seen: string | null;
        on_roster: boolean;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.device).toBe("dev-a");
    const b = body.devices.find((d) => d.device === "dev-b")!;
    expect(b.state).toBe("legacy");
    expect(b.on_roster).toBe(true);
    expect(typeof b.last_seen).toBe("string");
  });

  test("retire writes the human record with the reason; list shows the device retired", async () => {
    initStore({ root });
    writeFrom("dev-b");
    const r = await runCli(["store", "device", "retire", "dev-b", "--reason", "laptop sold"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Retired dev-b");
    const records = retireRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toEqual({
      authority: "human",
      device: "dev-b",
      reason: "laptop sold",
    });

    const list = await runCli(["store", "device", "list"], { env: env() });
    expect(list.stdout).toMatch(/dev-b\s+\S+\s+retired/);

    const again = await runCli(["store", "device", "retire", "dev-b"], { env: env() });
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain("already retired");
    expect(retireRecords()).toHaveLength(1);
  });

  test("retiring this machine's own id is refused with exit 1 and writes nothing", async () => {
    initStore({ root });
    const r = await runCli(["store", "device", "retire", "dev-a", "--json"], { env: env() });
    expect(r.returncode).toBe(1);
    const body = JSON.parse(r.stdout) as { ok: boolean; reason: string };
    expect(body).toMatchObject({ ok: false, reason: "own-device" });
    expect(retireRecords()).toHaveLength(0);
  });

  test("no store is a refusal that names the init; a missing id is a usage error", async () => {
    const none = await runCli(["store", "device", "list"], { env: env() });
    expect(none.returncode).toBe(1);
    expect(none.stderr).toContain("o2b store init");
    const usage = await runCli(["store", "device", "retire"], { env: env() });
    expect(usage.returncode).toBe(2);
    const unknown = await runCli(["store", "device", "nope"], { env: env() });
    expect(unknown.returncode).toBe(2);
  });

  test("retire refuses an id the store has never seen unless --force", async () => {
    initStore({ root });
    writeFrom("dev-b");
    const typo = await runCli(["store", "device", "retire", "dev-bb", "--json"], { env: env() });
    expect(typo.returncode).toBe(1);
    expect(JSON.parse(typo.stdout)).toMatchObject({ ok: false, reason: "unknown-device" });
    expect(retireRecords()).toHaveLength(0);
    const forced = await runCli(["store", "device", "retire", "dev-bb", "--force"], { env: env() });
    expect(forced.returncode).toBe(0);
    expect(retireRecords()).toHaveLength(1);
  });

  test("a malformed id gets its own refusal, never the advice to pass --force", async () => {
    initStore({ root });
    const bad = await runCli(["store", "device", "retire", "Dev_B", "--json"], { env: env() });
    expect(bad.returncode).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, reason: "invalid-device" });
    expect(JSON.parse(bad.stdout).error).not.toContain("--force");
  });

  test("each refusal has its own JSON reason, and a usage error answers JSON too", async () => {
    const none = await runCli(["store", "device", "list", "--json"], { env: env() });
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, reason: "no-store" });
    const usage = await runCli(["store", "device", "retire", "--json"], { env: env() });
    expect(usage.returncode).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({ ok: false, reason: "usage" });
  });

  test("list on a machine with no device id refuses and writes no config", async () => {
    initStore({ root });
    const config = join(parent, "config.yaml");
    writeFileSync(config, "");
    const r = await runCli(["store", "device", "list", "--json"], {
      env: { ...env(), O2B_DEVICE_ID: "" },
    });
    expect(r.returncode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, reason: "no-device" });
    expect(readFileSync(config, "utf8")).toBe("");
  });
});
