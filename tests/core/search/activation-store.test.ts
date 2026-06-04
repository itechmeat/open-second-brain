/**
 * Activation event store (Time-Aware Recall & Activation Suite,
 * t_2bc79017 + t_c5ef25a3): one JSON file per recorded access under
 * `Brain/search/activation/`, a replayable fold into the derived
 * activation state, and a bounded sweep.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCESS_EVENT_PATHS_CAP,
  activationDir,
  activationStateFingerprint,
  activationStatePath,
  computeActivationState,
  loadAccessEvents,
  readActivationState,
  recordAccessEvent,
  sweepActivationEvents,
} from "../../../src/core/search/activation/store.ts";
import type { ActivationAccessEvent } from "../../../src/core/search/activation/types.ts";

let vault: string;

const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function ev(ts: number, paths: string[]): ActivationAccessEvent {
  return { ts, queryHash: "deadbeef", paths };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-activation-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("recordAccessEvent", () => {
  test("writes one event file and refreshes the derived state", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/notes/a.md", "Brain/notes/b.md"]));
    expect(readdirSync(activationDir(vault)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    const state = readActivationState(vault);
    expect(state?.events).toBe(1);
    expect(state?.paths["Brain/notes/a.md"]?.accessCount).toBe(1);
  });

  test("recording the identical event twice is idempotent", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/notes/a.md"]));
    recordAccessEvent(vault, ev(T0, ["Brain/notes/a.md"]));
    expect(loadAccessEvents(vault)).toHaveLength(1);
  });

  test("surfaced paths are capped per event", () => {
    const many = Array.from({ length: 25 }, (_, i) => `Brain/notes/n${i}.md`);
    recordAccessEvent(vault, ev(T0, many));
    const events = loadAccessEvents(vault);
    expect(events[0]?.paths).toHaveLength(ACCESS_EVENT_PATHS_CAP);
  });
});

describe("computeActivationState", () => {
  test("strength accumulates per access and caps at 1.0", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(T0 + i * 1000, ["Brain/notes/hot.md"]));
    const state = computeActivationState(events);
    expect(state.paths["Brain/notes/hot.md"]?.strength).toBe(1);
    expect(state.paths["Brain/notes/hot.md"]?.accessCount).toBe(12);
    expect(state.paths["Brain/notes/hot.md"]?.lastAccessAt).toBe(T0 + 11 * 1000);
  });

  test("the fold is order-insensitive", () => {
    const a = ev(T0, ["Brain/x.md", "Brain/y.md"]);
    const b = ev(T0 + 1000, ["Brain/y.md", "Brain/z.md"]);
    const c = ev(T0 + 2000, ["Brain/x.md"]);
    expect(computeActivationState([a, b, c])).toEqual(computeActivationState([c, a, b]));
  });

  test("co-access pairs count unordered companions", () => {
    const state = computeActivationState([
      ev(T0, ["Brain/x.md", "Brain/y.md"]),
      ev(T0 + 1000, ["Brain/y.md", "Brain/x.md"]),
      ev(T0 + 2000, ["Brain/x.md", "Brain/z.md"]),
    ]);
    const xy = state.coAccess.find((p) => p.a === "Brain/x.md" && p.b === "Brain/y.md");
    expect(xy?.count).toBe(2);
    const xz = state.coAccess.find((p) => p.a === "Brain/x.md" && p.b === "Brain/z.md");
    expect(xz?.count).toBe(1);
  });

  test("empty input yields the neutral state", () => {
    const state = computeActivationState([]);
    expect(state.events).toBe(0);
    expect(Object.keys(state.paths)).toHaveLength(0);
    expect(state.coAccess).toHaveLength(0);
  });
});

describe("replayability and robustness", () => {
  test("deleting the derived state and refolding reproduces it exactly", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/x.md", "Brain/y.md"]));
    recordAccessEvent(vault, ev(T0 + 1000, ["Brain/y.md"]));
    const first = readActivationState(vault);
    rmSync(activationStatePath(vault));
    const refolded = computeActivationState(loadAccessEvents(vault));
    expect(refolded).toEqual(first!);
  });

  test("a malformed event file never breaks the fold", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/x.md"]));
    writeFileSync(join(activationDir(vault), "zz-junk.json"), "{not json");
    writeFileSync(join(activationDir(vault), "zz-shape.json"), JSON.stringify({ ts: "no" }));
    expect(loadAccessEvents(vault)).toHaveLength(1);
  });

  test("corrupt nested rows in the derived state read as null (fail closed)", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/x.md"]));
    const good = readActivationState(vault)!;
    const poisonPath = {
      ...good,
      paths: { "Brain/x.md": { strength: "NaN", lastAccessAt: T0, accessCount: 1 } },
    };
    writeFileSync(activationStatePath(vault), JSON.stringify(poisonPath));
    expect(readActivationState(vault)).toBeNull();
    const poisonPair = { ...good, coAccess: [{ a: "Brain/x.md", count: 2 }] };
    writeFileSync(activationStatePath(vault), JSON.stringify(poisonPair));
    expect(readActivationState(vault)).toBeNull();
  });

  test("fingerprint is 'off' without state and stable with it", () => {
    expect(activationStateFingerprint(vault)).toBe("off");
    recordAccessEvent(vault, ev(T0, ["Brain/x.md"]));
    const fp = activationStateFingerprint(vault);
    expect(fp).not.toBe("off");
    expect(activationStateFingerprint(vault)).toBe(fp);
  });
});

describe("sweepActivationEvents", () => {
  test("drops events older than the retention window and refolds", () => {
    recordAccessEvent(vault, ev(T0 - 120 * DAY, ["Brain/old.md"]));
    recordAccessEvent(vault, ev(T0, ["Brain/new.md"]));
    const outcome = sweepActivationEvents(vault, { nowMs: T0 + 1000 });
    expect(outcome.removed).toBe(1);
    expect(outcome.kept).toBe(1);
    const state = readActivationState(vault);
    expect(state?.paths["Brain/old.md"]).toBeUndefined();
    expect(state?.paths["Brain/new.md"]).toBeDefined();
  });

  test("keeps only the newest events beyond the count cap", () => {
    for (let i = 0; i < 7; i++) {
      recordAccessEvent(vault, ev(T0 + i * 1000, [`Brain/n${i}.md`]));
    }
    const outcome = sweepActivationEvents(vault, { nowMs: T0 + DAY, maxEvents: 3 });
    expect(outcome.removed).toBe(4);
    expect(outcome.kept).toBe(3);
    expect(loadAccessEvents(vault).map((e) => e.ts)).toEqual([T0 + 4000, T0 + 5000, T0 + 6000]);
  });

  test("a missing event directory refolds a leftover derived state to empty", () => {
    recordAccessEvent(vault, ev(T0, ["Brain/x.md"]));
    rmSync(activationDir(vault), { recursive: true, force: true });
    const outcome = sweepActivationEvents(vault, { nowMs: T0 + DAY });
    expect(outcome).toEqual({ removed: 0, kept: 0 });
    const state = readActivationState(vault);
    expect(state?.events).toBe(0);
    expect(Object.keys(state?.paths ?? { x: 1 })).toHaveLength(0);
  });
});
