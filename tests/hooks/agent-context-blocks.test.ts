/**
 * The digest glue (task 4.2): a `head_select` step that fails while it
 * asks keeps the deterministic head order, so the heads block still
 * shows, and the heads come from the store of the config the hook reads
 * its decision settings from.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentContextBlocks } from "../../hooks/lib/agent-context-blocks.ts";
import { createInjectionMeter, resolveInjectionLimits } from "../../hooks/lib/active-context.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { newUlid } from "../../src/core/store/ulid.ts";
import { TEST_DEVICE_ID } from "../helpers/test-vault.ts";

let base: string;
let vault: string;
let storeRoot: string;
let projectDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_STORE_ROOT",
  "OPEN_SECOND_BRAIN_CONFIG",
  "O2B_DEVICE_ID",
  "VAULT_DIR",
] as const;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "o2b-agent-blocks-"));
  vault = join(base, "vault");
  storeRoot = join(base, "store");
  projectDir = join(base, "work", "o2b");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, ".o2b-vault.json"), JSON.stringify({ vault }));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = storeRoot;
  process.env["O2B_DEVICE_ID"] = TEST_DEVICE_ID;
  process.env["VAULT_DIR"] = vault;
  initStore({ root: storeRoot });
  const store = openStore({ root: storeRoot, device: TEST_DEVICE_ID });
  for (let i = 0; i < 2; i++) {
    const at = Date.UTC(2026, 11, 1) + i * 1000;
    appendRecord(
      store,
      {
        partition: "shared",
        stream: "topics",
        kind: "topic-create",
        agent: "seed",
        topic: newUlid(at),
        body: { authority: "agent", title: `Topic number ${i}`, scope: "project:o2b" },
      },
      { now: () => at },
    );
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

function headLines(block: string): string[] {
  return block.split("\n").filter((l) => /^- Topic number \d \[active\]/.test(l));
}

test("a head_select call that fails while it asks keeps the deterministic heads", async () => {
  const limits = resolveInjectionLimits(vault);
  const configPath = join(base, "config.yaml");
  writeFileSync(
    configPath,
    [
      "decision_model_enabled: true",
      "decision_model_provider: compatible",
      "decision_model_base_url: https://decide.invalid/v1",
      "decision_model_id: decide-model",
      "decision_model_uses: head_select:enforce",
    ].join("\n"),
  );
  // An environment that throws on any read: the call fails while it asks,
  // and the deterministic order stands.
  const env = new Proxy({} as Record<string, string | undefined>, {
    get: () => {
      throw new Error("environment unavailable");
    },
  });
  const blocks = await buildAgentContextBlocks({
    vault,
    workspaceDir: projectDir,
    limits,
    meter: createInjectionMeter(limits.injectBudgetChars),
    remainingMs: 1000,
    configPath,
    env,
  });
  expect(headLines(blocks.headsBlock)).toHaveLength(2);
});

test("the heads come from the store of the config the hook was given", async () => {
  // The process names another config with an empty store; the hook's own
  // config names the store that holds the topics.
  delete process.env["OPEN_SECOND_BRAIN_STORE_ROOT"];
  const otherStore = join(base, "other-store");
  initStore({ root: otherStore });
  const otherConfig = join(base, "other-config.yaml");
  writeFileSync(
    otherConfig,
    [`vault: ${vault}`, `store_root: ${otherStore}`, `device_id: ${TEST_DEVICE_ID}`].join("\n"),
  );
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = otherConfig;
  const configPath = join(base, "config.yaml");
  writeFileSync(
    configPath,
    [`vault: ${vault}`, `store_root: ${storeRoot}`, `device_id: ${TEST_DEVICE_ID}`].join("\n"),
  );
  const limits = resolveInjectionLimits(vault);
  const blocks = await buildAgentContextBlocks({
    vault,
    workspaceDir: projectDir,
    limits,
    meter: createInjectionMeter(limits.injectBudgetChars),
    remainingMs: 1000,
    configPath,
  });
  expect(headLines(blocks.headsBlock)).toHaveLength(2);
});
