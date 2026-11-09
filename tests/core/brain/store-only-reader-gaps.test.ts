/**
 * Readers of a switched machine that must see what the store holds and
 * answer as the legacy tree would: the vault delta's retire time, the
 * timeline's retire events, merge chains, the citing pages of a source
 * archive and the counts of status.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { retireSignal } from "../../../src/core/brain/signal-retire.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { appendClaimEvent, TRUTH_STORE_NAME } from "../../../src/core/brain/truth/store.ts";
import {
  appendDecisionLedger,
  queryDecisionLedger,
} from "../../../src/core/brain/permissions/ledger.ts";
import {
  emitRecallTelemetry,
  listRecallTelemetry,
  RECALL_CHANNEL,
  summarizeRecallTelemetry,
} from "../../../src/core/brain/recall-telemetry.ts";
import { computeTokenFootprint } from "../../../src/core/brain/token-footprint.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { vaultDelta } from "../../../src/core/discipline/vault-delta.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-reader-gaps-", { dualWrite: false });
  switchDevice(e.storeRoot);
  return e;
}

const signalInput = (slug: string) => ({
  topic: slug,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-06T10:00:00Z",
  date: "2026-11-06",
  slug,
});

describe("the vault delta on a switched machine", () => {
  test("a signal captured before the window and retired inside it counts as retired", () => {
    env = switchedEnv();
    const { id } = writeSignal(env.vault, signalInput("late-retire"));
    Bun.sleepSync(5);
    const start = new Date();
    retireSignal(env.vault, id, { reason: "obsolete", now: start });
    const delta = vaultDelta(env.vault, {
      startUtc: start,
      endUtc: new Date(start.getTime() + 3_600_000),
    });
    expect(delta.newSignals).toBe(0);
    expect(delta.newRetired).toBe(1);
  });
});

describe("ledger appends on a switched machine name no device path", () => {
  test("a truth claim reports the ledger's name", () => {
    env = switchedEnv();
    const result = appendClaimEvent(env.vault, {
      entity: "api",
      aspect: "port",
      value: "8080",
      agent: "@tester",
      source: "chat",
      ts: "2026-11-06T10:00:00Z",
    });
    expect(result.path).toBe(TRUTH_STORE_NAME);
  });
});

describe("ledgers with no vault", () => {
  test("a decision row written with no vault is read back with no vault", () => {
    env = makeStoreEnv("osb-ledger-novault-", { legacyTree: false, configureVault: false });
    const row = {
      ts: "2026-11-06T10:00:00Z",
      actor: "@t",
      via: "operator",
      action: "resolution" as const,
      target: "notes/a.md",
      verdict: "resolved",
      source: "review-door",
      reason: "applied",
    };
    expect(appendDecisionLedger(null, row).logged).toBe(true);
    expect(queryDecisionLedger(null).map((r) => r.target)).toEqual(["notes/a.md"]);
  });
});

test("recall telemetry written with no vault is listed and summarised with no vault", () => {
  env = makeStoreEnv("osb-telemetry-novault-", { legacyTree: false, configureVault: false });
  emitRecallTelemetry(null, {
    host: "test",
    channel: RECALL_CHANNEL.cli,
    mode: "search",
    status: "empty",
    durationMs: 0,
    resultCount: 0,
  });
  expect(listRecallTelemetry(null)).toHaveLength(1);
  expect(summarizeRecallTelemetry(null).total).toBe(1);
});

test("the token footprint counts the store's log, not files left under Brain/", () => {
  env = switchedEnv();
  appendLogEvent(env.vault, {
    timestamp: "2026-11-06T10:00:00Z",
    eventType: "note",
    body: { text: "a note", agent: "@t" },
  });
  writeFileSync(join(env.vault, "Brain", "leftover.md"), "a leftover page\n".repeat(50));
  const report = computeTokenFootprint(env.vault);
  const log = report.byCategory.find((c) => c.name === "log");
  expect(log?.files ?? 0).toBeGreaterThan(0);
  expect(report.byCategory.find((c) => c.name === "other")).toBeUndefined();
});
