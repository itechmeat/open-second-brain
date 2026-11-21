/**
 * The evidence of life of each device (change stale-device-retirement,
 * design D1): legacy shard name dates and row times, never a file's
 * modification time; the clocks of the store records a device wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  baseDateMs,
  isRowTimeField,
  legacyDeviceEvidence,
  newestRowTimeMs,
  storeDeviceEvidence,
  TAIL_BYTES,
} from "../../../src/core/store-migration/device-evidence.ts";
import { migrationCatalogue } from "../../../src/core/store-migration/catalogue.ts";
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
    expect(baseDateMs("recall")).toBeNull();
  });

  test("row times: ISO strings in time fields only, never a time still to come", () => {
    const text = [
      JSON.stringify({ ts: "2026-11-01T10:00:00Z" }),
      JSON.stringify({ run_at: "2026-11-03T10:00:00Z" }),
      JSON.stringify({ createdAt: "2026-11-04T10:00:00Z" }),
      JSON.stringify({ when: "2026-12-31T10:00:00Z" }),
      JSON.stringify({ expires_at: "2027-01-01T00:00:00Z" }),
      JSON.stringify({ retryAfter: "2027-01-01T00:00:00Z" }),
      JSON.stringify({ unconfirmed_until: "2027-01-01T00:00:00Z" }),
      JSON.stringify({ ts: 1_900_000_000_000 }),
      "{broken",
    ].join("\n");
    expect(newestRowTimeMs(text)).toBe(at("2026-11-04T10:00:00Z"));
  });

  test("row time fields by name, read from the product's writers", () => {
    // Past-facing: when the row's event happened. snoozed_at (triggers) is
    // when a trigger was snoozed, run_at (metrics) when a run ran,
    // planned_at (note reverts) when a plan was made.
    for (const yes of [
      "snoozed_at",
      "snoozedAt",
      "runAt",
      "planned_at",
      "started_at",
      "validated_at",
      "last_seen_at",
    ]) {
      expect([yes, isRowTimeField(yes)]).toEqual([yes, true]);
    }
    // Future-facing: a time still to come (a schedule, a reminder, an
    // expiry, a sunset, a not-before), never evidence of life.
    for (const no of [
      "scheduled_at",
      "scheduledAt",
      "remind_at",
      "reminderAt",
      "fire_at",
      "fireAt",
      "not_before_at",
      "notBeforeAt",
      "starts_at",
      "startsAt",
      "sunset_at",
      "survey_sunset_at",
      "wake_at",
      "nextDueAt",
    ]) {
      expect([no, isRowTimeField(no)]).toEqual([no, false]);
    }
  });

  test("row time fields by name", () => {
    for (const yes of [
      "ts",
      "timestamp",
      "time",
      "created_at",
      "createdAt",
      "recordedAt",
      "run_at",
    ]) {
      expect(isRowTimeField(yes)).toBe(true);
    }
    for (const no of [
      "when",
      "expires_at",
      "expiresAt",
      "retry_after",
      "next_run_at",
      "landsAt",
      "due_at",
      "n",
    ]) {
      expect(isRowTimeField(no)).toBe(false);
    }
  });

  test("base dates: an ISO week at its Monday", () => {
    expect(baseDateMs("2026-W45")).toBe(at("2026-11-02T00:00:00Z"));
    expect(baseDateMs("2026-W01")).toBe(at("2025-12-29T00:00:00Z"));
  });
});

/**
 * A shard base each naming scheme of the catalogue accepts, by its
 * grammar. A scheme this table does not know fails the table: a new
 * ledger gets a row here.
 */
const SAMPLE_BASES: Readonly<Record<string, string>> = Object.freeze({
  "\\d{4}-\\d{2}-\\d{2}": "2026-11-01",
  "\\d{4}-\\d{2}": "2026-11",
  "\\d{4}-W\\d{2}": "2026-W44",
  "[a-z][a-z0-9_]{0,63}": "recall",
  "pref-.+?\\.history": "pref-sample.history",
});

function sampleBase(grammarBase: string): string | null {
  if (grammarBase in SAMPLE_BASES) return SAMPLE_BASES[grammarBase]!;
  return /^[\w-]+$/.test(grammarBase) ? grammarBase : null;
}

describe("legacy evidence over every shard naming scheme", () => {
  // The newest row: later than every name period of the table.
  const NEWEST = "2026-11-04T19:27:16Z";

  test("the newest row time dates the device, whatever the scheme and the time field", () => {
    vault = makeLegacyVault("osb-evidence-schemes-");
    const locators = migrationCatalogue(vault.vault)
      .flatMap((entry) => entry.locators.map((l) => ({ id: entry.id, l })))
      .filter(({ l }) => l.shape === "jsonl");
    expect(locators.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    let n = 0;
    for (const { id, l } of locators) {
      if (l.shape !== "jsonl") continue;
      const base = sampleBase(l.grammar.base);
      if (base === null) {
        wrong.push(`${id}: no sample base for ${l.grammar.base}`);
        continue;
      }
      for (const field of ["createdAt", "ts", "recorded_at", "timestamp"]) {
        n += 1;
        const device = `dev-s${n}`;
        const dir = l.subdirs ? join(l.dir, "sample") : l.dir;
        mkdirSync(dir, { recursive: true });
        const rows = [
          JSON.stringify({ [field]: "2026-10-01T00:00:00Z", n: 1 }),
          JSON.stringify({ [field]: NEWEST, n: 2 }),
        ];
        writeFileSync(join(dir, `${base}.${device}.jsonl`), `${rows.join("\n")}\n`);
        const got = legacyDeviceEvidence(vault.vault).get(device);
        if (got !== at(NEWEST)) {
          wrong.push(
            `${id} (${l.grammar.base}, ${field}): ${got === undefined || got === null ? got : new Date(got).toISOString()}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the name's period is the floor when every row is older or has no time", () => {
    vault = makeLegacyVault("osb-evidence-floor-");
    vault.write(
      "Brain/log/continuity/2026-11.dev-f.jsonl",
      `${JSON.stringify({ createdAt: "2026-10-30T00:00:00Z" })}\n`,
    );
    expect(legacyDeviceEvidence(vault.vault).get("dev-f")).toBe(at("2026-11-01T00:00:00Z"));
    // A week dates its shard at its Monday.
    vault.write(".open-second-brain/hook-audit/2026-W45.dev-g.jsonl", "{}\n");
    expect(legacyDeviceEvidence(vault.vault).get("dev-g")).toBe(at("2026-11-02T00:00:00Z"));
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
    expect(storeDeviceEvidence(a.store()).evidence.get("dev-a")).toBeGreaterThanOrEqual(when);
    expect(storeDeviceEvidence(a.store()).evidence.has("dev-b")).toBe(false);
  });
});
