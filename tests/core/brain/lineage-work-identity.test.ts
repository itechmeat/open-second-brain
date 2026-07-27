/**
 * Durable work identity above the timing crutch (signals-that-survive,
 * Unit 9; kanban t_e6be4f6b).
 *
 * Session continuation used to have exactly two durable signals - the
 * lineage the host declared and a fifteen-minute freshness window - so a
 * work item resumed after a model, account, branch or worktree switch
 * never re-attached. This pins the third: an OPTIONAL declared work id
 * and lane id, sourced in strict precedence at the capture boundary and
 * ranked above the window.
 *
 * Two properties carry the whole unit:
 *
 *   - identity is DECLARED, never derived. Nothing here fingerprints a
 *     remote, a merge-base or a gitdir, and no rung accumulates a union
 *     of what it has seen;
 *   - a lane is a HARD separator, never a tiebreak. Two entries sharing
 *     a work id under different lanes can never link, at any rung, and
 *     the refusal is a named outcome rather than a silent non-link.
 *
 * With both fields absent every assertion in `lineage.test.ts` and
 * `lineage-continuation.test.ts` still holds unmodified; the byte-
 * identical cases below pin the same property from this side.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DegradationNotice } from "../../../src/core/integrity/degradation.ts";
import { CRUTCH_ABSTENTION, resolveCrutchLineage } from "../../../src/core/brain/lineage/crutch.ts";
import {
  brainStateDirPath,
  CRUTCH_LINK_WINDOW_MS,
  type LineageObservation,
  readLineageLedger,
  recordLineageObservation,
  sessionLineageLedgerPath,
} from "../../../src/core/brain/lineage/ledger.ts";
import {
  clearWorkIdentityMarker,
  readWorkIdentityMarker,
  recordWorkIdentityMarker,
  resolveWorkIdentity,
  WORK_IDENTITY_MARKER_MAX_AGE_MS,
  WORK_IDENTITY_MARKER_MAX_FILES,
  WORK_IDENTITY_MARKER_STATUS,
  WORK_IDENTITY_SOURCE,
  workIdentityMarkerPath,
} from "../../../src/core/brain/lineage/identity.ts";
import {
  resolveSessionLineage,
  resolveSessionLineageDetailed,
} from "../../../src/core/brain/lineage/resolve.ts";
import { verifyLineageLedger } from "../../../src/core/brain/lineage/verify.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-work-identity-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-06-10T08:00:00Z");

const WORK_ID = "w-refactor-ledger";
const OTHER_WORK_ID = "w-unrelated";
const LANE_A = "lane-alpha";
const LANE_B = "lane-beta";
const WORKTREE_A = "/work/tree-a";
const WORKTREE_B = "/work/tree-b";

const WORK_ID_ENV_KEY = "OPEN_SECOND_BRAIN_WORK_ID";
const LANE_ID_ENV_KEY = "OPEN_SECOND_BRAIN_LANE_ID";

/** A config file carrying only the keys a case declares. */
function writeConfig(entries: Readonly<Record<string, string>>): string {
  const path = join(tmp, `config-${Object.keys(entries).join("-") || "empty"}.yaml`);
  writeFileSync(
    path,
    `${Object.entries(entries)
      .map(([key, value]) => `${key}: "${value}"`)
      .join("\n")}\n`,
    "utf8",
  );
  return path;
}

function seed(obs: Partial<LineageObservation> & { sessionId: string; atMs: number }): void {
  const { atMs, ...rest } = obs;
  recordLineageObservation(tmp, {
    at: new Date(atMs).toISOString(),
    event: "UserPromptSubmit",
    ...rest,
  });
}

// ----- rung 1..3: where a declaration is read from -------------------------

describe("resolveWorkIdentity - declared, in strict precedence", () => {
  test("the host payload field outranks the environment, the config and the marker", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: "w-marker", laneId: LANE_B });
    const identity = resolveWorkIdentity({
      vault: tmp,
      payloadWorkId: WORK_ID,
      payloadLaneId: LANE_A,
      worktree: WORKTREE_A,
      env: { [WORK_ID_ENV_KEY]: "w-env", [LANE_ID_ENV_KEY]: LANE_B },
      configPath: writeConfig({ work_id: "w-config" }),
    });
    expect(identity).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.payload,
    });
  });

  test("the environment variable outranks the config key and the marker", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: "w-marker" });
    const identity = resolveWorkIdentity({
      vault: tmp,
      worktree: WORKTREE_A,
      env: { [WORK_ID_ENV_KEY]: WORK_ID, [LANE_ID_ENV_KEY]: LANE_A },
      configPath: writeConfig({ work_id: "w-config", lane_id: LANE_B }),
    });
    expect(identity).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.environment,
    });
  });

  test("the config key is read when neither payload nor environment declares one", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: "w-marker" });
    const identity = resolveWorkIdentity({
      vault: tmp,
      worktree: WORKTREE_A,
      env: {},
      configPath: writeConfig({ work_id: WORK_ID, lane_id: LANE_A }),
    });
    expect(identity).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.environment,
    });
  });

  test("the per-worktree marker is the last rung", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID, laneId: LANE_A });
    const identity = resolveWorkIdentity({
      vault: tmp,
      worktree: WORKTREE_A,
      env: {},
      configPath: writeConfig({}),
    });
    expect(identity).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.marker,
    });
  });

  test("the lane rides with the rung that declared the work id", () => {
    const identity = resolveWorkIdentity({
      vault: tmp,
      payloadWorkId: WORK_ID,
      worktree: WORKTREE_A,
      env: { [LANE_ID_ENV_KEY]: LANE_B },
      configPath: writeConfig({}),
    });
    expect(identity).toEqual({ workId: WORK_ID, source: WORK_IDENTITY_SOURCE.payload });
  });

  test("a lane alone is a declaration - a work id is not required", () => {
    const identity = resolveWorkIdentity({
      vault: tmp,
      payloadLaneId: LANE_A,
      worktree: WORKTREE_A,
      env: {},
      configPath: writeConfig({}),
    });
    expect(identity).toEqual({ laneId: LANE_A, source: WORK_IDENTITY_SOURCE.payload });
  });

  test("nothing declared anywhere resolves to null", () => {
    expect(
      resolveWorkIdentity({
        vault: tmp,
        worktree: WORKTREE_A,
        env: {},
        configPath: writeConfig({}),
      }),
    ).toBeNull();
  });

  test("blank declarations are not declarations", () => {
    expect(
      resolveWorkIdentity({
        vault: tmp,
        payloadWorkId: "   ",
        payloadLaneId: "",
        worktree: WORKTREE_A,
        env: { [WORK_ID_ENV_KEY]: " " },
        configPath: writeConfig({}),
      }),
    ).toBeNull();
  });

  test("a marker recorded for one worktree is never read for another", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID });
    expect(readWorkIdentityMarker(tmp, WORKTREE_B)).toBeNull();
    expect(readWorkIdentityMarker(tmp, WORKTREE_A)).toEqual({
      workId: WORK_ID,
      source: WORK_IDENTITY_SOURCE.marker,
    });
  });

  test("a marker whose recorded worktree no longer matches is not read", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID });
    const path = workIdentityMarkerPath(tmp, WORKTREE_A);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, worktree: WORKTREE_B }), "utf8");
    expect(readWorkIdentityMarker(tmp, WORKTREE_A)).toBeNull();
  });

  test("the marker lives under the Brain state directory, not in the note tree", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID });
    expect(workIdentityMarkerPath(tmp, WORKTREE_A).startsWith(brainStateDirPath(tmp))).toBe(true);
  });

  test("the environment rung is taken WHOLE: a config lane never joins a shell work id", () => {
    const identity = resolveWorkIdentity({
      vault: tmp,
      worktree: WORKTREE_A,
      env: { [WORK_ID_ENV_KEY]: WORK_ID },
      configPath: writeConfig({ lane_id: LANE_B }),
    });
    // A composite nobody declared - shell work id + file lane - is exactly
    // what the rung boundary exists to prevent, and a lane is a hard
    // separator, so composing one could refuse a link both sides agreed on.
    expect(identity).toEqual({ workId: WORK_ID, source: WORK_IDENTITY_SOURCE.environment });
  });

  test("the config rung is taken whole too, when the environment declares nothing", () => {
    const identity = resolveWorkIdentity({
      vault: tmp,
      worktree: WORKTREE_A,
      env: {},
      configPath: writeConfig({ work_id: WORK_ID, lane_id: LANE_A }),
    });
    expect(identity).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.environment,
    });
  });
});

// ----- the marker rung is bounded in time and in count ----------------------

describe("the marker rung expires; a declaration does not", () => {
  test("a marker read after the staleness bound declares nothing", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    expect(readWorkIdentityMarker(tmp, WORKTREE_A, { nowMs: T0 + 1_000 })).toEqual({
      workId: WORK_ID,
      source: WORK_IDENTITY_SOURCE.marker,
    });
    expect(
      readWorkIdentityMarker(tmp, WORKTREE_A, {
        nowMs: T0 + WORK_IDENTITY_MARKER_MAX_AGE_MS + 1,
      }),
    ).toBeNull();
  });

  test("a payload or environment declaration still links across the same gap", () => {
    const nowMs = T0 + WORK_IDENTITY_MARKER_MAX_AGE_MS * 10;
    expect(
      resolveWorkIdentity({
        vault: tmp,
        payloadWorkId: WORK_ID,
        worktree: WORKTREE_A,
        env: {},
        configPath: writeConfig({}),
        nowMs,
      }),
    ).toEqual({ workId: WORK_ID, source: WORK_IDENTITY_SOURCE.payload });
    expect(
      resolveWorkIdentity({
        vault: tmp,
        worktree: WORKTREE_A,
        env: { [WORK_ID_ENV_KEY]: WORK_ID },
        configPath: writeConfig({}),
        nowMs,
      }),
    ).toEqual({ workId: WORK_ID, source: WORK_IDENTITY_SOURCE.environment });
  });

  test("an undatable marker declares nothing: freshness that cannot be shown is not assumed", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    const path = workIdentityMarkerPath(tmp, WORKTREE_A);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete stored["at"];
    writeFileSync(path, `${JSON.stringify(stored)}\n`, "utf8");
    expect(readWorkIdentityMarker(tmp, WORKTREE_A, { nowMs: T0 + 1_000 })).toBeNull();
  });

  test("a live declaration refreshes the marker, so continuous work keeps inheriting", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    const later = T0 + WORK_IDENTITY_MARKER_MAX_AGE_MS - 1;
    expect(recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: later })).toBe(
      WORK_IDENTITY_MARKER_STATUS.written,
    );
    expect(
      readWorkIdentityMarker(tmp, WORKTREE_A, {
        nowMs: later + WORK_IDENTITY_MARKER_MAX_AGE_MS - 1,
      }),
    ).not.toBeNull();
  });

  test("an unchanged declaration inside the refresh interval does not rewrite the file", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    const before = readFileSync(workIdentityMarkerPath(tmp, WORKTREE_A), "utf8");
    expect(
      recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 + 1_000 }),
    ).toBe(WORK_IDENTITY_MARKER_STATUS.unchanged);
    expect(readFileSync(workIdentityMarkerPath(tmp, WORKTREE_A), "utf8")).toBe(before);
  });

  test("a changed declaration always rewrites, refresh interval or not", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    expect(
      recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: OTHER_WORK_ID }, { nowMs: T0 + 1_000 }),
    ).toBe(WORK_IDENTITY_MARKER_STATUS.written);
    expect(readWorkIdentityMarker(tmp, WORKTREE_A, { nowMs: T0 + 2_000 })?.workId).toBe(
      OTHER_WORK_ID,
    );
  });

  test("clearing a marker is one documented call, and the rung goes quiet", () => {
    recordWorkIdentityMarker(tmp, WORKTREE_A, { workId: WORK_ID }, { nowMs: T0 });
    expect(clearWorkIdentityMarker(tmp, WORKTREE_A)).toBe(true);
    expect(readWorkIdentityMarker(tmp, WORKTREE_A, { nowMs: T0 + 1_000 })).toBeNull();
    // Idempotent: clearing what is not there is not an error.
    expect(clearWorkIdentityMarker(tmp, WORKTREE_A)).toBe(false);
  });

  test("the marker directory is bounded: a fresh worktree per job cannot grow it forever", () => {
    const total = WORK_IDENTITY_MARKER_MAX_FILES + 20;
    for (let i = 0; i < total; i++) {
      recordWorkIdentityMarker(tmp, `/ci/job-${i}`, { workId: `w-${i}` }, { nowMs: T0 + i });
    }
    const dir = join(brainStateDirPath(tmp), "work-identity");
    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(WORK_IDENTITY_MARKER_MAX_FILES);
    // The newest declaration is always among the survivors.
    expect(
      readWorkIdentityMarker(tmp, `/ci/job-${total - 1}`, { nowMs: T0 + total }),
    ).not.toBeNull();
  });

  test("the sweep drops expired markers before it drops live ones", () => {
    recordWorkIdentityMarker(tmp, "/ci/ancient", { workId: "w-ancient" }, { nowMs: T0 });
    const fresh = T0 + WORK_IDENTITY_MARKER_MAX_AGE_MS * 2;
    for (let i = 0; i < WORK_IDENTITY_MARKER_MAX_FILES + 1; i++) {
      recordWorkIdentityMarker(tmp, `/ci/job-${i}`, { workId: `w-${i}` }, { nowMs: fresh + i });
    }
    expect(existsSync(workIdentityMarkerPath(tmp, "/ci/ancient"))).toBe(false);
  });
});

// ----- the ledger line ------------------------------------------------------

describe("lineage ledger - the declared identity rides the line", () => {
  test("records and reads back the work id and the lane id", () => {
    seed({ sessionId: "s-1", atMs: T0, workId: WORK_ID, laneId: LANE_A });
    const entry = readLineageLedger(tmp).get("s-1");
    expect(entry?.workId).toBe(WORK_ID);
    expect(entry?.laneId).toBe(LANE_A);
  });

  test("carries the last declared identity forward across observations", () => {
    seed({ sessionId: "s-1", atMs: T0, workId: WORK_ID, laneId: LANE_A });
    seed({ sessionId: "s-1", atMs: T0 + 1_000, event: "PostToolUse" });
    const entry = readLineageLedger(tmp).get("s-1");
    expect(entry?.workId).toBe(WORK_ID);
    expect(entry?.laneId).toBe(LANE_A);
  });

  test("a line written without an identity carries neither key", () => {
    seed({ sessionId: "s-1", atMs: T0, cwd: WORKTREE_A });
    const raw = readFileSync(sessionLineageLedgerPath(tmp), "utf8").trim();
    const line = JSON.parse(raw) as Record<string, unknown>;
    expect("wid" in line).toBe(false);
    expect("lane" in line).toBe(false);
    expect(readLineageLedger(tmp).get("s-1")?.workId).toBeUndefined();
  });

  test("the integrity chain verifies with the new fields present", () => {
    seed({ sessionId: "s-1", atMs: T0, workId: WORK_ID, laneId: LANE_A });
    seed({ sessionId: "s-2", atMs: T0 + 1_000, workId: WORK_ID, laneId: LANE_A });
    seed({ sessionId: "s-3", atMs: T0 + 2_000 });
    const report = verifyLineageLedger(tmp);
    expect(report.ok).toBe(true);
    expect(report.notices).toEqual([]);
  });
});

// ----- the identity rung ----------------------------------------------------

describe("resolveCrutchLineage - the identity rung above the window", () => {
  test("links on a shared work id alone: outside the window, across worktrees", () => {
    seed({
      sessionId: "s-parent",
      atMs: T0,
      cwd: WORKTREE_A,
      workId: WORK_ID,
      workspace: { repo: "https://example.invalid/o/r", branch: "main", commit: "a".repeat(40) },
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_B,
      workId: WORK_ID,
      workspace: { repo: "https://example.invalid/o/r", branch: "feature", commit: "b".repeat(40) },
      ledger: readLineageLedger(tmp),
      nowMs: T0 + CRUTCH_LINK_WINDOW_MS * 10,
    });
    expect(outcome).toEqual({
      kind: "linked",
      lineage: { rootId: "s-parent", parentId: "s-parent", depth: 1, source: "identity" },
    });
  });

  test("links with no compression evidence anywhere in the ledger", () => {
    seed({ sessionId: "s-parent", atMs: T0, cwd: WORKTREE_A, workId: WORK_ID });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(outcome.kind).toBe("linked");
  });

  test("inherits the predecessor's root and continues its depth", () => {
    seed({
      sessionId: "s-parent",
      atMs: T0,
      workId: WORK_ID,
      lineage: { rootId: "s-root", parentId: "s-root", depth: 1, source: "payload" },
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(outcome).toMatchObject({
      kind: "linked",
      lineage: { rootId: "s-root", parentId: "s-parent", depth: 2 },
    });
  });

  test("a different lane id never links, and the refusal is named", () => {
    seed({
      sessionId: "s-parent",
      atMs: T0,
      cwd: WORKTREE_A,
      workId: WORK_ID,
      laneId: LANE_A,
      compressionEvidence: true,
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      workId: WORK_ID,
      laneId: LANE_B,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(outcome).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.laneConflict });
  });

  test("a lane conflict blocks the window rung too, so no rung can link it", () => {
    // No shared work id: only the lane separates them, and everything the
    // window rung requires (same cwd, fresh, evidenced) holds.
    seed({
      sessionId: "s-parent",
      atMs: T0,
      cwd: WORKTREE_A,
      laneId: LANE_A,
      compressionEvidence: true,
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      laneId: LANE_B,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(outcome).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.laneConflict });
  });

  test("two same-lane predecessors sharing a work id abstain as work-ambiguous", () => {
    seed({ sessionId: "s-one", atMs: T0, cwd: WORKTREE_A, workId: WORK_ID, laneId: LANE_A });
    seed({
      sessionId: "s-two",
      atMs: T0 + 1_000,
      cwd: WORKTREE_B,
      workId: WORK_ID,
      laneId: LANE_A,
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      workId: WORK_ID,
      laneId: LANE_A,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 2_000,
    });
    expect(outcome).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.workAmbiguous,
      considered: 2,
    });
  });

  test("a predecessor another session already continued from is spoken for", () => {
    seed({ sessionId: "s-a", atMs: T0, workId: WORK_ID });
    seed({
      sessionId: "s-b",
      atMs: T0 + 1_000,
      workId: WORK_ID,
      lineage: { rootId: "s-a", parentId: "s-a", depth: 1, source: "identity" },
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-c",
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 2_000,
    });
    expect(outcome).toMatchObject({
      kind: "linked",
      lineage: { parentId: "s-b", rootId: "s-a", depth: 2 },
    });
  });

  test("falls through to the window rung when no predecessor shares the work id", () => {
    seed({
      sessionId: "s-parent",
      atMs: T0,
      cwd: WORKTREE_A,
      workId: OTHER_WORK_ID,
      compressionEvidence: true,
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(outcome).toMatchObject({
      kind: "linked",
      lineage: { parentId: "s-parent", source: "crutch" },
    });
  });

  test("a session with its own ledger history stays self-known", () => {
    seed({ sessionId: "s-parent", atMs: T0, workId: WORK_ID });
    seed({ sessionId: "s-child", atMs: T0 + 1_000, workId: WORK_ID });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 2_000,
    });
    expect(outcome).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.selfKnown });
  });

  test("a spoken-for predecessor is checked BEFORE its lane, so it cannot veto rung 2", () => {
    // s-a declares the work id under lane A and has already been continued
    // from; s-b is the live predecessor and declares no lane at all.
    seed({ sessionId: "s-a", atMs: T0, cwd: WORKTREE_A, workId: WORK_ID, laneId: LANE_A });
    seed({
      sessionId: "s-b",
      atMs: T0 + 1_000,
      cwd: WORKTREE_A,
      compressionEvidence: true,
      lineage: { rootId: "s-a", parentId: "s-a", depth: 1, source: "identity" },
    });
    const outcome = resolveCrutchLineage({
      sessionId: "s-c",
      cwd: WORKTREE_A,
      workId: WORK_ID,
      laneId: LANE_B,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 2_000,
    });
    // A predecessor already spoken for is not a lane conflict: counting it
    // as one produced a TERMINAL lane-conflict abstention that hid the
    // legitimate window-rung link below.
    expect(outcome).toMatchObject({
      kind: "linked",
      lineage: { parentId: "s-b", source: "crutch" },
    });
  });

  test("the abstention detail names the lane only when a lane actually refused one", () => {
    seed({ sessionId: "s-parent", atMs: T0, cwd: WORKTREE_A });
    const quiet = resolveCrutchLineage({
      sessionId: "s-child",
      cwd: WORKTREE_A,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
    });
    expect(quiet).toMatchObject({ kind: "abstained" });
    expect((quiet as { detail: string }).detail).not.toContain("another lane");

    seed({ sessionId: "s-laned", atMs: T0 + 2_000, cwd: WORKTREE_B, laneId: LANE_A });
    const refused = resolveCrutchLineage({
      sessionId: "s-other",
      cwd: WORKTREE_B,
      laneId: LANE_B,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 3_000,
    });
    expect((refused as { detail: string }).detail).toContain("1 in another lane");
  });

  test("a declared work id does not rescue a session the gap sidecar recorded", () => {
    seed({ sessionId: "s-parent", atMs: T0, workId: WORK_ID });
    const outcome = resolveCrutchLineage({
      sessionId: "s-child",
      workId: WORK_ID,
      ledger: readLineageLedger(tmp),
      nowMs: T0 + 1_000,
      gapSessionIds: new Set(["s-child"]),
    });
    expect(outcome).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.selfKnown });
  });
});

// ----- the resolution ladder ------------------------------------------------

describe("resolveSessionLineageDetailed - identity between payload and the window", () => {
  test("native payload lineage still outranks a declared work identity", () => {
    seed({ sessionId: "s-parent", atMs: T0, workId: WORK_ID });
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-child", parentSessionId: "s-native", workId: WORK_ID },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 1_000 },
    );
    expect(resolution.lineage).toEqual({
      rootId: "s-native",
      parentId: "s-native",
      depth: 1,
      source: "payload",
    });
  });

  test("resolves through the identity rung when the payload carries no lineage", () => {
    seed({ sessionId: "s-parent", atMs: T0, cwd: WORKTREE_A, workId: WORK_ID });
    const lineage = resolveSessionLineage(
      { sessionId: "s-child", cwd: WORKTREE_B, workId: WORK_ID },
      { ledger: readLineageLedger(tmp), nowMs: T0 + CRUTCH_LINK_WINDOW_MS * 4 },
    );
    expect(lineage).toEqual({
      rootId: "s-parent",
      parentId: "s-parent",
      depth: 1,
      source: "identity",
    });
  });

  test("a lane conflict is reported as a refused continuation, not a silent flat", () => {
    seed({
      sessionId: "s-parent",
      atMs: T0,
      cwd: WORKTREE_A,
      workId: WORK_ID,
      laneId: LANE_A,
      compressionEvidence: true,
    });
    const notices: DegradationNotice[] = [];
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-child", cwd: WORKTREE_A, workId: WORK_ID, laneId: LANE_B },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 1_000, notices },
    );
    expect(resolution.lineage.source).toBe("flat");
    expect(resolution.crutch).toMatchObject({ reason: CRUTCH_ABSTENTION.laneConflict });
    expect(notices.length).toBe(1);
  });

  test("with no identity declared the resolution shape is unchanged", () => {
    seed({ sessionId: "s-parent", atMs: T0, cwd: WORKTREE_A, compressionEvidence: true });
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-child", cwd: WORKTREE_A },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 1_000 },
    );
    expect(Object.keys(resolution).toSorted()).toEqual(["crutch", "lineage"]);
    expect(resolution.lineage).toEqual({
      rootId: "s-parent",
      parentId: "s-parent",
      depth: 1,
      source: "crutch",
    });
  });
});

// ----- the capture boundary -------------------------------------------------

describe("captureSessionLifecycleEvent - sourcing the declaration", () => {
  let vault: string;

  beforeEach(() => {
    vault = join(tmp, "vault");
    mkdirSync(vault, { recursive: true });
    bootstrapBrain(vault);
  });

  test("stamps the payload-declared work id and lane onto the ledger observation", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "c-1",
        cwd: WORKTREE_A,
        work_id: WORK_ID,
        lane_id: LANE_A,
        prompt: "hi",
      },
      { agent: "tester", now: new Date(T0) },
    );
    const entry = readLineageLedger(vault).get("c-1");
    expect(entry?.workId).toBe(WORK_ID);
    expect(entry?.laneId).toBe(LANE_A);
  });

  test("records the declaration as a per-worktree marker", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "c-1",
        cwd: WORKTREE_A,
        work_id: WORK_ID,
        lane_id: LANE_A,
        prompt: "hi",
      },
      { agent: "tester", now: new Date(T0) },
    );
    expect(readWorkIdentityMarker(vault, WORKTREE_A, { nowMs: T0 })).toEqual({
      workId: WORK_ID,
      laneId: LANE_A,
      source: WORK_IDENTITY_SOURCE.marker,
    });
  });

  test("a later session in the same worktree inherits the recorded marker", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "c-1",
        cwd: WORKTREE_A,
        work_id: WORK_ID,
        prompt: "hi",
      },
      { agent: "tester", now: new Date(T0) },
    );
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "c-2", cwd: WORKTREE_A, prompt: "again" },
      { agent: "tester", now: new Date(T0 + CRUTCH_LINK_WINDOW_MS * 5) },
    );
    expect(result.lineage).toEqual({
      rootId: "c-1",
      parentId: "c-1",
      depth: 1,
      source: "identity",
    });
  });

  test("an unrelated session a month later does NOT chain onto the inherited marker", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "c-1",
        cwd: WORKTREE_A,
        work_id: WORK_ID,
        prompt: "hi",
      },
      { agent: "tester", now: new Date(T0) },
    );
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "c-2", cwd: WORKTREE_A, prompt: "again" },
      { agent: "tester", now: new Date(T0 + WORK_IDENTITY_MARKER_MAX_AGE_MS + 1) },
    );
    // A missed stitch is strictly better than a false one: nothing here
    // declared this work, the marker is only what the directory last saw,
    // and it is now older than the rung's bound.
    expect(result.lineage).toBeUndefined();
  });

  test("a payload declaring nothing writes no marker and no identity fields", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "c-1", cwd: WORKTREE_A, prompt: "hi" },
      { agent: "tester", now: new Date(T0) },
    );
    expect(readWorkIdentityMarker(vault, WORKTREE_A)).toBeNull();
    const raw = readFileSync(sessionLineageLedgerPath(vault), "utf8").trim();
    expect(raw.includes('"wid"')).toBe(false);
    expect(raw.includes('"lane"')).toBe(false);
  });
});
