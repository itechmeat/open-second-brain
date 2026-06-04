/**
 * Claim ledger store (Entity Truth & Self-Improving Dream Suite,
 * t_d6849b56): device-sharded append-only JSONL under `Brain/truth/`,
 * fail-closed line parsing, derived state cache that is never
 * authority, and an explicit sweep bounded by a newest-N cap.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendClaimEvent,
  CLAIM_EVENT_MAX_COUNT,
  claimShardPath,
  readClaimEvents,
  readTruthState,
  sweepClaimEvents,
  truthDir,
  truthStatePath,
  writeTruthState,
} from "../../../../src/core/brain/truth/store.ts";
import { computeTruthState } from "../../../../src/core/brain/truth/fold.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-truth-store-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function append(
  over: Partial<Parameters<typeof appendClaimEvent>[1]> = {},
): ReturnType<typeof appendClaimEvent> {
  return appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
    ...over,
  });
}

describe("appendClaimEvent", () => {
  test("appends one JSONL line to the device shard and normalizes identity", () => {
    const written = append({ entity: "  Alice   Mason ", aspect: " Employer " });
    expect(written.path).toBe(claimShardPath(vault));
    const lines = readFileSync(written.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row["v"]).toBe(1);
    expect(row["entity"]).toBe("alice mason");
    expect(row["aspect"]).toBe("employer");
    expect(row["value"]).toBe("Google");
  });

  test("two appends accumulate; the derived state cache refreshes", () => {
    append();
    append({ ts: "2026-06-02T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" });
    expect(readClaimEvents(vault).events).toHaveLength(2);
    const state = readTruthState(vault);
    expect(state).not.toBeNull();
    expect(state!.events).toBe(2);
  });

  test("rejects an empty entity or aspect", () => {
    expect(() => append({ entity: "  " })).toThrow();
    expect(() => append({ aspect: "" })).toThrow();
  });

  test("quantity claims persist the quantity payload", () => {
    append({
      value: "3",
      valueKind: "quantity",
      quantity: { value: 3, unit: "usd", action: "spent" },
    });
    const events = readClaimEvents(vault).events;
    expect(events[0]!.valueKind).toBe("quantity");
    expect(events[0]!.quantity).toEqual({ value: 3, unit: "usd", action: "spent" });
  });
});

describe("readClaimEvents", () => {
  test("merges device shards sorted by (ts, shard, line)", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const rowA = {
      v: 1,
      ts: "2026-06-02T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Meta",
      valueKind: "text",
      source: "[[x]]",
    };
    const rowB = { ...rowA, ts: "2026-06-01T09:00:00Z", agent: "b", value: "Google" };
    writeFileSync(join(truthDir(vault), "claims.dev-a.jsonl"), JSON.stringify(rowA) + "\n");
    writeFileSync(join(truthDir(vault), "claims.dev-b.jsonl"), JSON.stringify(rowB) + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(warnings).toHaveLength(0);
    expect(events.map((e) => e.value)).toEqual(["Google", "Meta"]);
  });

  test("fail-closed: malformed lines and wrong versions surface as warnings, never throw", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const good = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[x]]",
    };
    const lines = [
      "not json at all",
      JSON.stringify({ ...good, v: 99 }),
      JSON.stringify({ ...good, ts: "yesterday" }),
      JSON.stringify({ ...good, entity: 42 }),
      JSON.stringify(good),
    ].join("\n");
    writeFileSync(join(truthDir(vault), "claims.jsonl"), lines + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(4);
  });

  test("sync-conflict copies are never read as shards", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    writeFileSync(
      join(truthDir(vault), "claims.sync-conflict-20260601-foo.jsonl"),
      JSON.stringify({ v: 1 }) + "\n",
    );
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("missing directory reads as empty", () => {
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });
});

describe("derived state cache", () => {
  test("readTruthState is fail-closed on corrupt nested rows", () => {
    writeTruthState(vault, computeTruthState([]));
    expect(readTruthState(vault)).not.toBeNull();
    writeFileSync(
      truthStatePath(vault),
      JSON.stringify({
        version: 1,
        events: 1,
        updatedAt: null,
        slots: [{ bogus: true }],
        conflicts: [],
      }),
    );
    expect(readTruthState(vault)).toBeNull();
    writeFileSync(truthStatePath(vault), "{ not json");
    expect(readTruthState(vault)).toBeNull();
  });

  test("state cache is recomputable: deleting it loses nothing", () => {
    append();
    append({ ts: "2026-06-02T10:00:00Z", value: "Meta" });
    const before = readTruthState(vault);
    rmSync(truthStatePath(vault));
    const refolded = computeTruthState(readClaimEvents(vault).events);
    expect(refolded).toEqual(before!);
  });
});

describe("sweepClaimEvents", () => {
  test("keeps the newest N events and refolds", () => {
    for (let i = 0; i < 5; i++) {
      append({
        ts: `2026-06-0${i + 1}T10:00:00Z`,
        value: `v${i}`,
        source: `[[Brain/notes/n${i}.md]]`,
      });
    }
    const outcome = sweepClaimEvents(vault, { maxEvents: 2 });
    expect(outcome.removed).toBe(3);
    expect(outcome.kept).toBe(2);
    const { events } = readClaimEvents(vault);
    expect(events.map((e) => e.value)).toEqual(["v3", "v4"]);
    expect(readTruthState(vault)!.events).toBe(2);
  });

  test("default cap is generous", () => {
    expect(CLAIM_EVENT_MAX_COUNT).toBeGreaterThanOrEqual(10000);
  });

  test("sweep with no directory refolds an orphaned state file", () => {
    writeTruthState(vault, {
      ...computeTruthState([]),
      events: 42,
    });
    const outcome = sweepClaimEvents(vault, {});
    expect(outcome).toEqual({ removed: 0, kept: 0 });
    expect(existsSync(truthStatePath(vault))).toBe(true);
    expect(readTruthState(vault)!.events).toBe(0);
  });
});
