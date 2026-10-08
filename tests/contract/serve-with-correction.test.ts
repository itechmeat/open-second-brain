/**
 * The wave-level contract (truth-correctable-time-aware, Task 21).
 *
 * Sub-suite A's temporal ledger and sub-suite B's serve-with-correction
 * coupling compose into one guarantee on every serving surface: a record
 * retired through a validity close stays serveable, but appears only
 * beside its resolved, readable chain-tip correction, and is dropped
 * fail-closed the moment that correction is unreadable; a flatly-wrong
 * correction tombstones, and the tombstone stays hidden everywhere
 * before any coupling question arises. The ledger side of the same
 * composition is pinned too: the correction event carries the closed
 * window, folds as a same-source self-correction (never a conflict) and
 * classifies as a succession in the dedicated channel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { queryByTopic } from "../../src/core/brain/query.ts";
import { correct } from "../../src/core/brain/lifecycle/correction.ts";
import { appendClaimEvent, readClaimEvents } from "../../src/core/brain/truth/store.ts";
import { computeTruthStateWithConflicts } from "../../src/core/brain/truth/conflicts.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-15T12:00:00Z");
const CORRECTION_TS = "2026-06-15T12:00:00Z";
const TARGET = "Brain/preferences/pref-old.md";
const TARGET_SOURCE = "[[Brain/preferences/pref-old.md]]";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-contract-correction-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-contract-correction-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** The corrected record, its successor and the stale claim the ledger holds. */
function seedPair(): void {
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
  writeFileSync(
    join(vault, TARGET),
    [
      "---",
      "kind: brain-preference",
      "id: pref-old",
      "_status: confirmed",
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-01T00:00:00Z",
      "_confirmed_at: 2026-05-01T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout",
      "principle: Keep the deploy timeout at 30 seconds.",
      "pinned: false",
      "---",
      "",
      "The stale body.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(brainDirs(vault).preferences, "pref-new.md"),
    [
      "---",
      "kind: brain-preference",
      "id: pref-new",
      "_status: confirmed",
      "created_at: 2026-06-02T00:00:00Z",
      "unconfirmed_until: 2026-06-02T00:00:00Z",
      "_confirmed_at: 2026-06-02T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout-v2",
      "principle: Keep the deploy timeout at two minutes.",
      "pinned: false",
      "---",
      "",
      "The live body.",
      "",
    ].join("\n"),
  );
  appendClaimEvent(
    vault,
    {
      ts: "2026-05-02T00:00:00Z",
      agent: "tester",
      entity: "deploy timeout",
      aspect: "limit",
      value: "30s",
      source: TARGET_SOURCE,
      validFrom: "2026-05-02T00:00:00Z",
      validUntil: "2026-06-10T00:00:00Z",
    },
    { configPath },
  );
}

function applyCorrection(overrides: { flatlyWrong?: boolean }): ReturnType<typeof correct> {
  return correct({
    vault,
    configPath,
    target: TARGET,
    value: "two minutes",
    successor: "pref-new",
    reason: "the timeout changed",
    dryRun: false,
    now: NOW,
    agent: "tester",
    ...overrides,
  });
}

describe("serve-with-correction contract", () => {
  test("a validity-closed correction keeps the predecessor serveable and closes the ledger window", () => {
    seedPair();

    const res = applyCorrection({});
    const retirement = res.retirements[0]!;
    expect(retirement.endState).toBe("validity_close");
    expect(retirement.reasonCode).toBe("supersede");
    expect(retirement.validUntil).toBe(CORRECTION_TS);

    const event = readClaimEvents(vault).events.find((e) => e.value === "two minutes");
    expect(event).toBeDefined();
    expect(event!.validFrom).toBe(CORRECTION_TS);

    const out = queryByTopic(vault, "deploy-timeout");
    expect(out.preference?.id).toBe("pref-old");
  });

  test("the serveable predecessor is dropped fail-closed once its chain-tip correction is unreadable", () => {
    seedPair();
    applyCorrection({});

    rmSync(join(brainDirs(vault).preferences, "pref-new.md"));

    const out = queryByTopic(vault, "deploy-timeout");
    expect(out.preference).toBeNull();
  });

  test("a flatly-wrong correction tombstones the predecessor out of every surface", () => {
    seedPair();

    const res = applyCorrection({ flatlyWrong: true });
    const retirement = res.retirements[0]!;
    expect(retirement.endState).toBe("tombstone");
    expect(retirement.reasonCode).toBe("tombstone");
    expect(retirement.validUntil).toBeNull();

    const out = queryByTopic(vault, "deploy-timeout");
    expect(out.preference).toBeNull();
  });

  test("the corrected slot folds as a same-source self-correction in the succession channel", () => {
    seedPair();
    applyCorrection({});

    const state = computeTruthStateWithConflicts(readClaimEvents(vault).events);
    expect(state.conflicts).toHaveLength(0);
    expect(state.successions).toHaveLength(1);
  });
});
