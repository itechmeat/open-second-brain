/**
 * The evidence of life of each device (change stale-device-retirement,
 * design D1): legacy shard name dates and row times, never a file's
 * modification time; the clocks of the store records a device wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  baseDateMs,
  legacyDeviceEvidence,
  newestRowTimeMs,
  storeDeviceEvidence,
  TAIL_BYTES,
} from "../../../src/core/store-migration/device-evidence.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";
import { makeLegacyVault, type LegacyVaultFixture } from "./fixtures/legacy-vault.ts";

let vault: LegacyVaultFixture | null = null;
let fleet: Fleet | null = null;
afterEach(() => {
  vault?.cleanup();
  vault = null;
  fleet?.cleanup();
  fleet = null;
});

const at = (iso: string): number => Date.parse(iso);

describe("legacy evidence", () => {
  test("shard name dates and row times, per device", () => {
    vault = makeLegacyVault("osb-evidence-");
    const evidence = legacyDeviceEvidence(vault.vault);
    // dev-a: log rows at 10:00 and 11:00, its month and metric shards older.
    expect(evidence.get("dev-a")).toBe(at("2026-11-01T11:00:00Z"));
    // dev-b: its hook-audit row of 2026-11-02 is its newest trace.
    expect(evidence.get("dev-b")).toBe(at("2026-11-02T00:00:00Z"));
    // dev-c: one continuity shard of 2026-09 whose rows carry no time.
    expect(evidence.get("dev-c")).toBe(at("2026-09-01T00:00:00Z"));
  });

  test("a file's modification time is never evidence", () => {
    vault = makeLegacyVault("osb-evidence-mtime-");
    const path = join(vault.vault, "Brain", "log", "continuity", "2026-09.dev-c.jsonl");
    const future = new Date(at("2030-01-01T00:00:00Z"));
    utimesSync(path, future, future);
    expect(legacyDeviceEvidence(vault.vault).get("dev-c")).toBe(at("2026-09-01T00:00:00Z"));
  });

  test("a device whose shards carry no date and no row time is known, with no evidence", () => {
    vault = makeLegacyVault("osb-evidence-nodate-");
    vault.write("Brain/logs/idempotency/2026-11.dev-q.jsonl", "");
    // A month base dates it; a fixed stem would not.
    expect(legacyDeviceEvidence(vault.vault).get("dev-q")).toBe(at("2026-11-01T00:00:00Z"));
    vault.write("Brain/metrics/recall.dev-z.jsonl", `${JSON.stringify({ n: 1 })}\n`);
    const evidence = legacyDeviceEvidence(vault.vault);
    expect(evidence.has("dev-z")).toBe(true);
    expect(evidence.get("dev-z")).toBeNull();
  });

  test("the newest row of a shard larger than the tail read is found", () => {
    vault = makeLegacyVault("osb-evidence-tail-");
    const old = JSON.stringify({ ts: "2026-01-01T00:00:00Z", event_type: "note", text: "x" });
    const lines = Array.from({ length: Math.ceil((TAIL_BYTES * 2) / old.length) }, () => old);
    lines.push(JSON.stringify({ ts: "2026-11-18T08:00:00Z", event_type: "note", text: "new" }));
    vault.write("Brain/log/2026-01-01.dev-t.jsonl", `${lines.join("\n")}\n`);
    expect(legacyDeviceEvidence(vault.vault).get("dev-t")).toBe(at("2026-11-18T08:00:00Z"));
  });

  test("a newest row longer than the tail read still dates its device", () => {
    vault = makeLegacyVault("osb-evidence-longrow-");
    const old = JSON.stringify({ ts: "2026-11-02T00:00:00Z", key: "k1" });
    const long = JSON.stringify({ ts: "2026-11-18T08:00:00Z", key: "x".repeat(TAIL_BYTES * 2) });
    vault.write("Brain/logs/idempotency/2026-11.dev-w.jsonl", `${old}\n${long}\n`);
    // Without its newest row the month base (2026-11-01) would date dev-w.
    expect(legacyDeviceEvidence(vault.vault).get("dev-w")).toBe(at("2026-11-18T08:00:00Z"));
    // A single row, with no line before it, too.
    vault.write("Brain/logs/idempotency/2026-11.dev-v.jsonl", long);
    expect(legacyDeviceEvidence(vault.vault).get("dev-v")).toBe(at("2026-11-18T08:00:00Z"));
  });

  test("base dates: a day, a month, nothing else", () => {
    expect(baseDateMs("2026-11-01")).toBe(at("2026-11-01T00:00:00Z"));
    expect(baseDateMs("2026-11")).toBe(at("2026-11-01T00:00:00Z"));
    expect(baseDateMs("2026-W45")).toBeNull();
    expect(baseDateMs("recall")).toBeNull();
  });

  test("row times: ISO strings in the known fields only", () => {
    const text = [
      JSON.stringify({ ts: "2026-11-01T10:00:00Z" }),
      JSON.stringify({ run_at: "2026-11-03T10:00:00Z" }),
      JSON.stringify({ when: "2026-12-31T10:00:00Z" }),
      JSON.stringify({ ts: 1_900_000_000_000 }),
      "{broken",
    ].join("\n");
    expect(newestRowTimeMs(text)).toBe(at("2026-11-03T10:00:00Z"));
  });
});

describe("store evidence", () => {
  test("the newest clock of the records each device wrote", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const when = at("2026-11-10T09:00:00Z");
    appendRecord(
      a.store(),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "x" } },
      { now: () => when },
    );
    expect(storeDeviceEvidence(a.store()).get("dev-a")).toBeGreaterThanOrEqual(when);
    expect(storeDeviceEvidence(a.store()).has("dev-b")).toBe(false);
  });
});
