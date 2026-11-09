/**
 * The write guard and the one-operation shape of record-lane writers on a
 * store-only machine: every writer of one lane family passes the same
 * guard, and a writer whose records belong together writes them as one
 * operation in one partition.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addPledge, listPledges } from "../../../src/core/brain/pledges.ts";
import {
  listPendingLane,
  rejectPendingLane,
  stageForReview,
} from "../../../src/core/brain/pending/pending-lanes.ts";
import { rejectPending, stagePendingSignal } from "../../../src/core/brain/pending.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import {
  lanePageExists,
  laneVaultRoot,
  readLaneText,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { archivePage } from "../../../src/core/brain/recompile.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { PROFILE_STORE_NAME, writeProfileDoc } from "../../../src/core/brain/profile-doc.ts";
import { confirmTension, persistTension } from "../../../src/core/brain/tensions.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  listProceduralMemory,
  reconcileProceduralMemory,
} from "../../../src/core/brain/procedural-memory.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
import { intakePledges } from "../../../src/core/brain/pledge-intake.ts";
import { holdMigrationGate, releaseMigrationGate } from "../../../src/core/migration-gate.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  if (lane !== null) releaseMigrationGate(lane.vault, "leftover");
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-07T12:00:00Z");

describe("pledge writers on a store-only machine", () => {
  test("the intake passes the same guard as add: a leftover legacy gate refuses neither", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "call.md"), "# Call\n\nI will send the report by Friday.\n");
    // The legacy vault guard's migration gate names this vault; the store
    // write checks the store identity instead (design D14 item 13).
    holdMigrationGate(vault, "leftover");
    addPledge(vault, {
      title: "Send the report",
      due: "2026-11-13",
      source: "notes/call.md",
      evidence: ["I will send the report by Friday."],
      agent: "@t",
      now: NOW,
    });
    const result = intakePledges(
      vault,
      {
        source: "notes/call.md",
        pledges: [{ title: "Send the slides", due: "2026-11-14", evidence: ["I will send"] }],
      },
      { agent: "@t", now: NOW },
    );
    expect(result.created).toHaveLength(1);
    expect(listPledges(vault, { now: NOW })).toHaveLength(2);
  });
});

describe.each(LANE_MODES)("the review queue's reject (%s)", (mode) => {
  test("a staged ingest page is rejected into the retired lane, nothing else changes", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const before = lane.vaultHash();
    const staged = stageForReview(
      vault,
      "ingest",
      "Brain/sources/src-paper.md",
      () => "---\nkind: brain-source\n---\nPaper.\n",
    );
    const rejected = rejectPendingLane(vault, staged.pendingId, "not useful");
    expect(listPendingLane(vault, "ingest").entries).toEqual([]);
    expect(lanePageExists(vault, rejected.path)).toBe(true);
    if (mode === "legacy") return;
    expect(lane.vaultHash()).toBe(before);
    expect(existsSync(laneVaultRoot(null))).toBe(false);
  });
});

describe("a staged page's reject on a store-only machine", () => {
  test("the retire copy is private and the shared staged entry's tombstone stays shared", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "secret.md"), "---\nvisibility: [private]\n---\nSecret.\n");
    const staged = stageForReview(
      vault,
      "ingest",
      "Brain/sources/src-paper.md",
      () => "---\nkind: brain-source\n---\nPaper.\n",
    );
    const stagedShared = lane.laneRecords("shared").length;
    // The reason names a private page: the retire copy is private. The
    // staged entry lives in shared, so its tombstone (no content) stays
    // there: a machine that holds only shared sees the staged page go.
    rejectPendingLane(vault, staged.pendingId, "duplicates [[notes/secret]]");
    const added = lane.laneRecords("shared").slice(stagedShared);
    expect(added.map((r) => r.kind)).toEqual(["lane-entry-remove"]);
    expect(JSON.stringify(added.map((r) => r.body))).not.toContain("secret");
    expect(lane.laneRecords("private").map((r) => r.kind)).toEqual(["lane-entry"]);
  });
});

describe("a staged signal's reject on a store-only machine", () => {
  test("passes the lane guard apply passes: a leftover legacy gate refuses neither", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const staged = stagePendingSignal(vault, {
      topic: "reject-me",
      signal: "positive",
      agent: "claude",
      principle: "Principle of reject-me",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "reject-me",
    });
    holdMigrationGate(vault, "leftover");
    rejectPending(vault, staged.id, "not a rule");
    const states = readSignals({ vault }, { states: "all" }).map((s) => [s.id, s.state]);
    expect(states).toEqual([[staged.id, "rejected"]]);
  });
});

describe("the hygiene archive on a store-only machine", () => {
  test("a Brain/ page held as a lane record is archived out of the store", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const page = join(vault, "Brain", "reports", "old.md");
    writeLaneText(vault, page, "---\nkind: report\n---\nOld.\n");
    const before = lane.vaultHash();
    const target = archivePage(vault, page, NOW);
    expect(readFileSync(target, "utf8")).toContain("Old.");
    expect(target.startsWith(vault)).toBe(false);
    expect(lanePageExists(vault, page)).toBe(false);
    expect(lane.vaultHash()).toBe(before);
  });

  test("a leftover pre-switch file is left alone; the store record is archived", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const page = join(vault, "Brain", "reports", "old.md");
    writeLaneText(vault, page, "---\nkind: report\n---\nFrom the store.\n");
    // The legacy tree a switch leaves in place holds the page too.
    mkdirSync(join(vault, "Brain", "reports"), { recursive: true });
    writeFileSync(page, "---\nkind: report\n---\nLeftover.\n");
    const before = lane.vaultHash();
    const target = archivePage(vault, page, NOW);
    expect(readFileSync(target, "utf8")).toContain("From the store.");
    expect(lanePageExists(vault, page)).toBe(false);
    expect(lane.vaultHash()).toBe(before);
  });
});

describe("procedural memory projections on a store-only machine", () => {
  test("an index naming a private page writes every projection to private", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    mkdirSync(join(vault, "runbooks"), { recursive: true });
    writeFileSync(
      join(vault, "runbooks", "secret-runbook.md"),
      `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n# Secret runbook\n\nSteps.\n`,
    );
    const before = lane.vaultHash();
    reconcileProceduralMemory(vault, { roots: [join(vault, "runbooks")] });
    expect(listProceduralMemory(vault).map((e) => e.sourcePath)).toEqual([
      "runbooks/secret-runbook.md",
    ]);
    expect(lane.laneRecords("private").length).toBeGreaterThan(0);
    expect(lane.laneRecords("shared")).toHaveLength(0);
    expect(lane.vaultHash()).toBe(before);
  });

  test("a Brain/ root is read from the store only, never the legacy tree", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    // A stale legacy file and a store entry under the same root.
    mkdirSync(join(vault, "Brain", "procedures"), { recursive: true });
    writeFileSync(join(vault, "Brain", "procedures", "stale.md"), "# Stale\n");
    writeLaneText(vault, join(vault, "Brain", "procedures", "live.md"), "# Live\n");
    reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
    // The store entry is listed (the store is read) and the stale file is
    // not (the legacy tree is not).
    expect(listProceduralMemory(vault).map((e) => e.sourcePath)).toEqual([
      "Brain/procedures/live.md",
    ]);
  });
});

describe("a reserved tension on a store-only machine", () => {
  test("its page and its log events land in private only", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const { record } = persistTension(
      vault,
      {
        aId: "pref-tabs",
        bId: "pref-spaces",
        subject: "tabs use",
        jaccard: 0.6,
        aSign: "positive",
        bSign: "negative",
        aQuote: "Always use tabs.",
        bQuote: "Never use tabs.",
        action: "ask_user",
      },
      { agent: "@t", now: NOW, visibility: [REMOTE_DENY_VISIBILITY_TOKEN] },
    );
    confirmTension(vault, record.slug, { agent: "@t", now: NOW, reason: "real" });
    const shared = readPartition(join(lane.env.storeRoot, "shared"))
      .flatMap((shard) => shard.all)
      .filter((r) => r.kind === "log-event" || r.kind === "lane-entry");
    expect(shared).toEqual([]);
    expect(lane.laneRecords("private").length).toBeGreaterThan(0);
  });
});

describe("a tension marked private by hand on a store-only machine", () => {
  test("its transition and event stay private, and the page keeps the reservation", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const { record } = persistTension(
      vault,
      {
        aId: "pref-tabs",
        bId: "pref-spaces",
        subject: "tabs use",
        jaccard: 0.6,
        aSign: "positive",
        bSign: "negative",
        aQuote: "Always use tabs.",
        bQuote: "Never use tabs.",
        action: "ask_user",
      },
      { agent: "@t", now: NOW },
    );
    // The operator marks the page private with the informal marker.
    const text = readLaneText(vault, record.path)!;
    writeLaneText(vault, record.path, text.replace("---\n", "---\naccess: private\n"));
    const sharedBefore = readPartition(join(lane.env.storeRoot, "shared")).flatMap(
      (shard) => shard.all,
    ).length;
    const confirmed = confirmTension(vault, record.slug, { agent: "@t", now: NOW, reason: "real" });
    const sharedAfter = readPartition(join(lane.env.storeRoot, "shared")).flatMap(
      (shard) => shard.all,
    ).length;
    expect(sharedAfter).toBe(sharedBefore);
    expect(confirmed.visibility).toContain(REMOTE_DENY_VISIBILITY_TOKEN);
  });
});

describe("the profile page on a store-only machine", () => {
  test("drawn from a private preference, its record is private and it names no file", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    writePreference(
      vault,
      {
        slug: "hush",
        topic: "t",
        principle: "keep <private>this</private> to me",
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-30T00:00:00Z",
        status: "confirmed",
        evidenced_by: [],
      },
      { authority: "agent" },
    );
    const result = writeProfileDoc(vault, { now: NOW });
    expect(result.path).toBe(PROFILE_STORE_NAME);
    expect(result.markerPath).toBeNull();
    const profile = (partition: "shared" | "private") =>
      lane!.laneRecords(partition).filter((r) => r.body["entry"] === "profile");
    expect(profile("shared")).toEqual([]);
    expect(profile("private").length).toBeGreaterThan(0);
  });
});
