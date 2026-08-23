/**
 * `computeBrainStatus`'s derived `maintenance_debt` block
 * (nothing-writes-silently, Unit D / t_6285e06f).
 *
 * Claims pinned here:
 *
 *   1. A vault that has never dreamed reports `status: "never_dreamed"`
 *      with `log_events_since_dream` equal to every log event ever
 *      recorded — never `0`, which would read as "no debt" rather than
 *      "no dream has ever run".
 *   2. Once a `dream` event exists, `status` becomes `"counted"` and
 *      `log_events_since_dream` counts only events strictly AFTER the
 *      dream's own timestamp — the dream event itself is the boundary,
 *      not a countable event.
 *   3. Events recorded before `last_dream_at` are excluded even when
 *      they share the same log day as the dream event.
 *   4. A `--dry-run` dream emits no `dream` log event, so it moves
 *      neither `last_dream_at` nor `maintenance_debt` — the wet/dry
 *      split already in `dream.ts` is the whole clearing mechanism;
 *      there is no separate counter to reset.
 *   5. A vault with no `Brain/` layer at all reports the same honest
 *      `never_dreamed` / zero shape as an empty-but-present Brain, not
 *      an error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBrainStatus, MAINTENANCE_DEBT_STATUS } from "../../../src/core/brain/status.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-status-maint-debt-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-status-maint-debt-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function logEvent(timestamp: string): void {
  appendLogEvent(vault, {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.note,
    agent: "tester",
    body: { text: "note" },
  });
}

/** Three same-sign signals: enough for `dream` to plan a real change. */
function seedPromotion(topic = "maint-debt-topic"): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Prefer the ${topic} approach`,
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

describe("computeBrainStatus — maintenance_debt (never dreamed)", () => {
  test("reports never_dreamed with the true event count, not zero-debt", () => {
    logEvent("2026-06-01T10:00:00Z");
    logEvent("2026-06-01T11:00:00Z");
    logEvent("2026-06-02T09:00:00Z");

    const snapshot = computeBrainStatus(vault);
    expect(snapshot.last_dream_at).toBeNull();
    expect(snapshot.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.neverDreamed);
    expect(snapshot.maintenance_debt.log_events_since_dream).toBe(3);
  });

  test("an empty, never-dreamed Brain reports zero — not an error, not a lie", () => {
    const snapshot = computeBrainStatus(vault);
    expect(snapshot.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.neverDreamed);
    expect(snapshot.maintenance_debt.log_events_since_dream).toBe(0);
  });
});

describe("computeBrainStatus — maintenance_debt (dreamed)", () => {
  test("counts only events strictly after the dream boundary", () => {
    logEvent("2026-06-01T10:00:00Z"); // before dream — excluded
    appendLogEvent(vault, {
      timestamp: "2026-06-01T12:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      agent: "tester",
      body: {},
    });
    logEvent("2026-06-01T12:00:00Z"); // same instant as the dream — NOT after it, excluded
    logEvent("2026-06-01T13:00:00Z"); // after dream, same day — included
    logEvent("2026-06-02T09:00:00Z"); // after dream, later day — included

    const snapshot = computeBrainStatus(vault);
    expect(snapshot.last_dream_at).toBe("2026-06-01T12:00:00Z");
    expect(snapshot.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.counted);
    expect(snapshot.maintenance_debt.log_events_since_dream).toBe(2);
  });

  test("zero events since the last dream reports counted, not never_dreamed", () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-01T12:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      agent: "tester",
      body: {},
    });

    const snapshot = computeBrainStatus(vault);
    expect(snapshot.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.counted);
    expect(snapshot.maintenance_debt.log_events_since_dream).toBe(0);
  });
});

describe("computeBrainStatus — maintenance_debt (Brain absent)", () => {
  test("reports the same honest never_dreamed shape as an empty Brain", () => {
    const bareVault = mkdtempSync(join(tmpdir(), "o2b-status-maint-debt-bare-"));
    try {
      const snapshot = computeBrainStatus(bareVault);
      expect(snapshot.present).toBe(false);
      expect(snapshot.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.neverDreamed);
      expect(snapshot.maintenance_debt.log_events_since_dream).toBe(0);
    } finally {
      rmSync(bareVault, { recursive: true, force: true });
    }
  });
});

describe("computeBrainStatus — dry-run dream moves nothing in the ledger", () => {
  test("a --dry-run dream leaves last_dream_at and maintenance_debt untouched", () => {
    seedPromotion();
    logEvent("2026-05-19T09:00:00Z");
    const before = computeBrainStatus(vault);
    expect(before.last_dream_at).toBeNull();

    dream(vault, { now: new Date("2026-05-23T12:00:00Z"), dryRun: true });

    const after = computeBrainStatus(vault);
    expect(after.last_dream_at).toBeNull();
    expect(after.maintenance_debt).toEqual(before.maintenance_debt);
  });

  test("the same seeded state DOES move the ledger on a wet run", () => {
    seedPromotion();
    logEvent("2026-05-19T09:00:00Z");

    dream(vault, { now: new Date("2026-05-23T12:00:00Z") });

    const after = computeBrainStatus(vault);
    expect(after.last_dream_at).not.toBeNull();
    expect(after.maintenance_debt.status).toBe(MAINTENANCE_DEBT_STATUS.counted);
  });
});
