/**
 * The doctor's view writer section (task 2.7): a view writer that has
 * published nothing for 3 days is reported on every machine with the
 * command that moves the role; a writer that renders or sends its idle
 * heartbeat is not, and nothing is said while the store is not in use.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { VIEW_WRITER_SILENT_CODE } from "../../../src/core/brain/doctor/view-writer-check.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { claimViewWriter, requestViewWriter } from "../../../src/core/view/writer.ts";
import { ensureStore } from "../store/fixtures/temp-store.ts";

const ENV_KEYS = [STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV, "HOME", "XDG_STATE_HOME", "LOCALAPPDATA"];
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const DAY = 86_400_000;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-doctor-view-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  delete process.env[STORE_DUAL_WRITE_ENV];
  process.env[STORE_ROOT_ENV] = storeRoot;
  resetVaultIdentityPins();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetVaultIdentityPins();
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function machine(device: string): StoreHandle {
  ensureStore(storeRoot);
  return openStore({
    root: storeRoot,
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
}

function silent(at: number) {
  const report = runDoctor(vault, { now: new Date(at) });
  return [...report.warnings, ...report.errors].filter((i) => i.code === VIEW_WRITER_SILENT_CODE);
}

function pass(store: StoreHandle, ms: number): void {
  runViewPass(store, { target: join(parent, "view"), vault: null, agent: "t", now: () => ms });
}

describe("doctor: silent view writer", () => {
  test("a writer that published nothing for 3 days is reported with the command to move the role", () => {
    const a = machine("dev-a");
    claimViewWriter(a, { agent: "t", now: () => NOW });
    pass(a, NOW + 1000);
    pass(a, NOW + 2000);
    expect(silent(NOW + 2 * DAY)).toEqual([]);
    const issues = silent(NOW + 4 * DAY);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("the view writer dev-a has published nothing");
    expect(issues[0]!.message).toContain("o2b view writer --here");
    // Another machine's doctor reports the same.
    machine("dev-b");
    expect(silent(NOW + 4 * DAY)).toHaveLength(1);
  });

  test("an idle writer's daily heartbeat keeps it from being reported", () => {
    const a = machine("dev-a");
    claimViewWriter(a, { agent: "t", now: () => NOW });
    pass(a, NOW + 1000);
    pass(a, NOW + 2000);
    pass(a, NOW + 2 * DAY);
    pass(a, NOW + 4 * DAY);
    expect(silent(NOW + 5 * DAY)).toEqual([]);
  });

  test("a writer that never rendered is counted from its claim", () => {
    const a = machine("dev-a");
    claimViewWriter(a, { agent: "t", now: () => NOW });
    expect(silent(NOW + 2 * DAY)).toEqual([]);
    expect(silent(NOW + 4 * DAY)).toHaveLength(1);
  });

  test("a role taken back counts from the move, not from the writer's renders before it", () => {
    const a = machine("dev-a");
    claimViewWriter(a, { agent: "t", now: () => NOW });
    pass(a, NOW + 1000);
    pass(a, NOW + 2000);
    const b = machine("dev-b");
    requestViewWriter(b, { agent: "t", force: true, now: () => NOW + DAY });
    // dev-a takes the role back two days after its last render.
    requestViewWriter(a, { agent: "t", force: true, now: () => NOW + 2 * DAY });
    // Four days after those renders, two after the move: not silent yet.
    expect(silent(NOW + 4 * DAY)).toEqual([]);
    expect(silent(NOW + 5 * DAY + 1000)).toHaveLength(1);
  });

  test("nothing is said when the store is not in use or no machine holds the role", () => {
    machine("dev-a");
    expect(silent(NOW + 10 * DAY)).toEqual([]);
    delete process.env[STORE_ROOT_ENV];
    expect(silent(NOW + 10 * DAY)).toEqual([]);
  });
});
