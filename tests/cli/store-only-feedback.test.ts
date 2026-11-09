/**
 * End to end through the CLI (task 2.10, design D14 item 1): on a fresh
 * install `o2b store init` records this device's switch, and from then on
 * `o2b brain feedback` lands in the store only. The feedback runs in its
 * own process, so the switch is read from the store, not from anything
 * the first process remembered; a `Brain/` that appears in the vault
 * afterwards does not bring the legacy writer back.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPartition } from "../../src/core/store/state-digest.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let vault: string;
let env: Record<string, string>;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-cli-store-only-"));
  vault = join(parent, "vault");
  mkdirSync(vault, { recursive: true });
  const config = join(parent, "config.yaml");
  writeFileSync(config, `vault: ${vault}\n`);
  env = {
    OPEN_SECOND_BRAIN_CONFIG: config,
    OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
    O2B_DEVICE_ID: "dev-cli",
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a fresh install switched by store init writes feedback to the store only", async () => {
  const init = await runCli(["store", "init", "--json"], { env });
  expect(init.returncode).toBe(0);
  const switched = readPartition(join(parent, "store", "shared"))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === "device-switched");
  expect(switched.map((r) => r.body["device"])).toEqual(["dev-cli"]);

  // An older writer creating the legacy tree later must not flip the machine back.
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const feedback = await runCli(
    [
      "brain",
      "feedback",
      "--vault",
      vault,
      "--topic",
      "tabs",
      "--signal",
      "positive",
      "--principle",
      "Use tabs",
    ],
    { env, subprocess: true },
  );
  expect(feedback.returncode).toBe(0);
  expect(readdirSync(join(vault, "Brain"))).toEqual([]);
  const signals = readPartition(join(parent, "store", "shared"))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === "signal");
  expect(
    signals.map((r) => (r.body["frontmatter"] as Record<string, unknown>)["principle"]),
  ).toEqual(["Use tabs"]);
}, 60_000);

test("o2b init on a fresh vault records the switch once the store exists", async () => {
  initStore({ root: join(parent, "store"), partitions: ["shared"] });
  const init = await runCli(["init", "--vault", vault], { env });
  expect(init.returncode).toBe(0);
  const switched = readPartition(join(parent, "store", "shared"))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === "device-switched");
  expect(switched.map((r) => r.body["device"])).toEqual(["dev-cli"]);
});
