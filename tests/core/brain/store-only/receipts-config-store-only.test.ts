/**
 * Decision receipts under an explicit machine config (task 2.10): the
 * idempotency probe reads the same store, in the same mode, as the append
 * it guards, so a replay under that config appends nothing, and once
 * switched both an append and a replay name the store ledger.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendDecisionChangeReceipt } from "../../../../src/core/brain/decisions/receipts.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { ledgerRows, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const RECEIPT = {
  subject: "tabs",
  before: "spaces",
  after: "tabs",
  actor: "@tester",
  reasonCode: "user",
  ts: "2026-11-06T10:00:00.000Z",
} as const;

describe("decision receipts under an explicit config", () => {
  test("a replay reads the store the append wrote to", () => {
    env = makeStoreEnv("osb-receipts-config-", { dualWrite: false });
    switchDevice(env.storeRoot);
    // Only the explicit config names this machine's device: the default
    // one reads as an unswitched machine.
    delete process.env["O2B_DEVICE_ID"];
    const explicit = join(env.parent, "explicit.yaml");
    writeFileSync(explicit, `vault: ${env.vault}\ndevice_id: dev-a\n`);
    const first = appendDecisionChangeReceipt(env.vault, { ...RECEIPT, configPath: explicit });
    const again = appendDecisionChangeReceipt(env.vault, { ...RECEIPT, configPath: explicit });
    expect(first.appended).toBe(true);
    expect(again.appended).toBe(false);
    expect(ledgerRows(env.storeRoot, "shared", "decision-receipts")).toHaveLength(1);
    expect(again.path).toBe(first.path);
    expect(first.path).not.toContain(env.vault);
  });
});
