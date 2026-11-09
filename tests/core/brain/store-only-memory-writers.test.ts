/**
 * The memory event writers once switched (task 2.10, design D14 items 1
 * and 5): signals, their lifecycle, preferences, retires, pins, pinned
 * context and evidence go to the store only, and nothing under the
 * vault's `Brain/` changes. Unswitched, the same calls keep the legacy
 * tree and dual-write as in phase 1.
 *
 * The operational log, the idempotency ledger and the audit trails under
 * `Brain/log/` and the permissions decision ledger under `Brain/logs/`
 * are another package's surfaces (the log and ledgers move
 * to the store with their own writers), so the tree comparison here
 * covers every file under `Brain/` outside those two folders.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { emptyPlan } from "../../../src/core/brain/dream-plan.ts";
import { applyDreamPlan } from "../../../src/core/brain/dream-apply.ts";
import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { setPinned } from "../../../src/core/brain/pin.ts";
import {
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
} from "../../../src/core/brain/pinned.ts";
import { loadBrainConfig } from "../../../src/core/brain/policy.ts";
import {
  loadPreference,
  moveToRetired,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import { writePreferenceTxn } from "../../../src/core/brain/preference-txn.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { deviceMintTag } from "../../../src/core/brain/record-name.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { retireSignal, SignalNotFoundError } from "../../../src/core/brain/signal-retire.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { SIGNAL_STATE_KIND } from "../../../src/core/store/fold-signals.ts";
import { readPreferences, readRetired } from "../../../src/core/store/read/preferences.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { brainOutsideLog, switchDevice as switchDeviceAt } from "./store-only/fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-06T12:00:00Z");

function switchDevice(e: StoreEnv): void {
  switchDeviceAt(e.storeRoot);
}

function records(e: StoreEnv, kind?: string): StoreRecord[] {
  return (["shared", "private"] as const)
    .flatMap((p) => (existsSync(join(e.storeRoot, p)) ? readPartition(join(e.storeRoot, p)) : []))
    .flatMap((shard) => shard.records)
    .filter((r) => kind === undefined || r.kind === kind);
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

const prefInput = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  topic: slug,
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-30T00:00:00Z",
  status: "unconfirmed" as const,
  evidenced_by: [],
  ...extra,
});

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-wp1-switched-", { dualWrite: false });
  switchDevice(e);
  return e;
}

describe("signals once switched", () => {
  test("a signal is a record only, with its id allocated against the fold", () => {
    env = switchedEnv();
    const before = brainOutsideLog(env.vault);
    const first = writeSignal(env.vault, signalInput("tabs"));
    const second = writeSignal(env.vault, signalInput("tabs"));
    // A switched machine's ids carry its device tag; the collision suffix
    // still separates two mints on one device.
    const tag = deviceMintTag();
    expect(first.id).toBe(`sig-2026-11-06-tabs-${tag}`);
    expect(second.id).toBe(`sig-2026-11-06-tabs-${tag}-2`);
    expect(existsSync(first.path)).toBe(false);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(readSignals({ vault: env.vault }).map((s) => [s.id, s.state])).toEqual([
      [`sig-2026-11-06-tabs-${tag}`, "active"],
      [`sig-2026-11-06-tabs-${tag}-2`, "active"],
    ]);
  });

  test("a retire is a signal-state record; the facade leaves the signal out by default", () => {
    env = switchedEnv();
    const { id } = writeSignal(env.vault, signalInput("retire-me"));
    const before = brainOutsideLog(env.vault);
    retireSignal(env.vault, id, { reason: "superseded", agent: "claude", now: NOW });
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [state] = records(env, SIGNAL_STATE_KIND);
    expect(state?.body).toMatchObject({
      signal: id,
      state: "retired",
      fields: { _status: "retired", retired_reason: "superseded", retired_by: "claude" },
    });
    expect(readSignals({ vault: env.vault })).toEqual([]);
    const all = readSignals({ vault: env.vault }, { states: "all" });
    expect(all.map((s) => [s.id, s.state, s.frontmatter["retired_reason"]])).toEqual([
      [id, "retired", "superseded"],
    ]);
    expect(() => retireSignal(env!.vault, id, { reason: "again" })).toThrow();
    expect(() => retireSignal(env!.vault, "sig-2026-11-06-nope", { reason: "x" })).toThrow(
      SignalNotFoundError,
    );
  });

  test("the dream pass consumes and archives signals as records, moving no file", () => {
    env = switchedEnv();
    const a = writeSignal(env.vault, signalInput("consume"));
    const b = writeSignal(env.vault, signalInput("archive"));
    const plan = emptyPlan();
    plan.signalsToMove.set(a.id, { id: a.id, date: "2026-11-06", slug: "consume", path: a.path });
    plan.signalsToArchive.set(b.id, { id: b.id, path: b.path });
    const before = brainOutsideLog(env.vault);
    const result = applyDreamPlan({
      vault: env.vault,
      cfg: loadBrainConfig(env.vault),
      now: NOW,
      plan,
      refresh: { confirmed: new Set(), updated: new Map(), bandDrops: [], outcomeRegressions: [] },
      agentName: "claude",
      wikilinkToRun: "[[Brain/log/2026-11-06]]",
      healEnrichEnabled: false,
      workrun: null,
    });
    expect(result.moved).toEqual([a.id]);
    expect(result.archived).toEqual([b.id]);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const states = readSignals({ vault: env.vault }, { states: "all" }).map((s) => [s.id, s.state]);
    expect(states).toEqual([
      [b.id, "archived"],
      [a.id, "consumed"],
    ]);
  });
});

describe("preferences once switched", () => {
  test("a preference write, rewrite and retire are records only", () => {
    env = switchedEnv();
    const before = brainOutsideLog(env.vault);
    writePreference(env.vault, prefInput("tabs"), { authority: "agent" });
    expect(() => writePreference(env!.vault, prefInput("tabs"))).toThrow(/exists/);
    expect(loadPreference(env.vault, "tabs")?.principle).toBe("principle tabs");

    const sets = records(env, "preference-set").length;
    // A rewrite that changes no field writes nothing (the no-op rerun rule).
    writePreference(env.vault, prefInput("tabs"), { overwrite: true, authority: "agent" });
    expect(records(env, "preference-set")).toHaveLength(sets);
    writePreference(env.vault, prefInput("tabs", { principle: "changed" }), {
      overwrite: true,
      authority: "agent",
    });
    expect(loadPreference(env.vault, "tabs")?.principle).toBe("changed");

    moveToRetired(env.vault, preferencePath(env.vault, "tabs"), "stale-no-evidence", {
      now: NOW,
      retired_by: "[[Brain/log/2026-11-06]]",
      authority: "agent",
    });
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(loadPreference(env.vault, "tabs")).toBeNull();
    expect(readPreferences({ vault: env.vault })).toEqual([]);
    const [retired] = readRetired({ vault: env.vault });
    expect(retired?.fields).toMatchObject({
      status: "retired",
      retired_reason: "stale-no-evidence",
    });
  });

  test("the preference transaction locks outside the vault and bumps the revision", () => {
    env = switchedEnv();
    const before = brainOutsideLog(env.vault);
    writePreferenceTxn(env.vault, prefInput("txn"), [], { authority: "agent" });
    writePreferenceTxn(env.vault, prefInput("txn", { principle: "second" }), [], {
      overwrite: true,
      authority: "agent",
    });
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(loadPreference(env.vault, "txn")).toMatchObject({ principle: "second", revision: 2 });
  });

  test("pins and evidence are records only and fold into the preference", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("pinme"), { authority: "agent" });
    const before = brainOutsideLog(env.vault);
    expect(setPinned(env.vault, "pref-pinme", true, { now: NOW }).changed).toBe(true);
    expect(setPinned(env.vault, "pref-pinme", true, { now: NOW }).changed).toBe(false);
    appendApplyEvidence(env.vault, {
      pref_id: "pref-pinme",
      artifact: "[[note]]",
      agent: "claude",
      result: "applied",
    });
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [entry] = readPreferences({ vault: env.vault });
    expect(entry?.fields["pinned"]).toBe(true);
    expect(entry?.counters.applied_count).toBe(1);
  });
});

describe("a preference private by its partition alone", () => {
  test("a pin keeps every record of the flip out of shared", () => {
    env = switchedEnv();
    // Written inside a private operation: its records live in `private`
    // with no visibility field to say so.
    withOperationPrivacy(true, () =>
      writePreference(env!.vault, prefInput("hush"), { authority: "agent" }),
    );
    const shared = () =>
      records(env!).filter((r) => JSON.stringify(r).includes("hush") && sharedIds(env!).has(r.id));
    expect(shared()).toEqual([]);
    expect(setPinned(env.vault, "pref-hush", true, { now: NOW }).changed).toBe(true);
    expect(shared()).toEqual([]);
    const [entry] = readPreferences({ vault: env.vault });
    expect(entry?.fields["pinned"]).toBe(true);
    expect(entry?.private).toBe(true);
  });
});

/** The ids of the records in `shared`. */
function sharedIds(e: StoreEnv): Set<string> {
  const dir = join(e.storeRoot, "shared");
  if (!existsSync(dir)) return new Set();
  return new Set(readPartition(dir).flatMap((shard) => shard.records.map((r) => r.id)));
}

describe("pinned context once switched", () => {
  test("write, append and clear are records only and read back from the register", () => {
    env = switchedEnv();
    const before = brainOutsideLog(env.vault);
    writePinnedContext(env.vault, "first fact");
    appendPinnedContext(env.vault, "second fact");
    expect(readPinnedContext(env.vault)).toMatchObject({
      present: true,
      content: "first fact\n\nsecond fact",
    });
    clearPinnedContext(env.vault);
    expect(readPinnedContext(env.vault).present).toBe(false);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(existsSync(join(env.vault, "Brain", "pinned.md"))).toBe(false);
  });
});

describe("unswitched machines keep the legacy tree", () => {
  test("a retire moves the file and dual-writes its signal-state record", () => {
    env = makeStoreEnv("osb-wp1-legacy-");
    const { id } = writeSignal(env.vault, signalInput("legacy"));
    retireSignal(env.vault, id, { reason: "done", now: NOW });
    expect(existsSync(join(env.vault, "Brain", "retired", `${id}.md`))).toBe(true);
    expect(records(env, SIGNAL_STATE_KIND).map((r) => r.body["state"])).toEqual(["retired"]);
    expect(readSignals({ vault: env.vault }, { states: "all" }).map((s) => s.state)).toEqual([
      "retired",
    ]);
  });

  test("a retired preference record carries real booleans and numbers", () => {
    env = makeStoreEnv("osb-wp1-legacy-");
    writePreference(env.vault, prefInput("typed", { confidence_value: 0.5, pinned: false }));
    moveToRetired(env.vault, preferencePath(env.vault, "typed"), "stale-no-evidence", {
      now: NOW,
      retired_by: "[[Brain/log/2026-11-06]]",
    });
    const retire = records(env, "preference-set").at(-1)!;
    const fields = retire.body["fields"] as Record<string, unknown>;
    expect(fields["status"]).toBe("retired");
    expect(fields["pinned"]).toBe(false);
    expect(fields["confidence_value"]).toBe(0.5);
    expect(readdirSync(join(env.vault, "Brain", "retired"))).toContain("ret-typed.md");
  });

  test("pinned context still writes Brain/pinned.md", () => {
    env = makeStoreEnv("osb-wp1-legacy-", { dualWrite: false });
    writePinnedContext(env.vault, "legacy fact");
    expect(existsSync(join(env.vault, "Brain", "pinned.md"))).toBe(true);
    expect(records(env)).toEqual([]);
  });
});
