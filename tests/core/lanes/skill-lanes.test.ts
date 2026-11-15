/**
 * Skill proposals, the accept journal and procedural memory on the lane
 * page store (task 2.10 WP6), in every mode: an unswitched machine writes
 * its pages, a store-only machine and one with no vault write lane-entry
 * records and leave the vault unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
  SkillAcceptLockedError,
  skillAcceptLockPath,
} from "../../../src/core/brain/skill-proposals.ts";
import {
  readSkillAcceptJournals,
  writeSkillAcceptJournal,
} from "../../../src/core/brain/skill-accept-journal.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  proceduralEntryId,
  reconcileProceduralMemory,
  recordProceduralOutcome,
} from "../../../src/core/brain/procedural-memory.ts";
import { readProceduralGraph } from "../../../src/core/brain/procedural-graph.ts";
import { readProceduralHints } from "../../../src/core/brain/procedural-hints.ts";
import { proceduralGraphPath, proceduralMemoryUsagePath } from "../../../src/core/brain/paths.ts";
import { procedurePath } from "../../../src/core/brain/paths.ts";
import {
  laneVaultRoot,
  lanePageExists,
  writeLanePage,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

describe.each(LANE_MODES)("skill and procedure lanes (%s)", (mode) => {
  test("learn, accept, reject, reconcile and project", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    seedCorePatterns(vault);
    // The continuity rows are another package's ledger; the lanes are measured from here.
    const before = lane.vaultHash();
    learnSkillProposals(vault, { now: new Date("2026-06-01T12:00:00Z"), minSupport: 3 });
    const pending = listPendingSkillProposals(vault);
    const accept = pending.find((p) => p.patternKind === "repeated_action")!;
    const reject = pending.find((p) => p.patternKind === "co_occurrence")!;
    expect(accept).toBeDefined();
    expect(reject).toBeDefined();
    expect(
      acceptSkillProposal(vault, accept.slug, { now: new Date("2026-06-01T12:10:00Z") }).status,
    ).toBe("accepted");
    expect(lanePageExists(vault, procedurePath(vault, accept.slug))).toBe(true);
    rejectSkillProposal(vault, reject.slug, {
      now: new Date("2026-06-01T12:20:00Z"),
      note: "noisy",
    });
    expect(listPendingSkillProposals(vault).map((p) => p.slug)).not.toContain(accept.slug);
    reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
    expect(listProceduralMemory(vault).length).toBeGreaterThan(0);
    expect(readProceduralGraph(vault)).not.toBeNull();
    if (mode === "legacy") return;
    expect(lane.vaultHash()).toBe(before);
    expect(existsSync(laneVaultRoot(null))).toBe(false);
    const lanes = new Set(lane.laneRecords().map((r) => String(r.body["lane"])));
    expect(lanes.has("skill-proposals")).toBe(true);
    expect(lanes.has("procedures")).toBe(true);
  });
});

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "procedural usage counters (%s)",
  (mode) => {
    test("a usage tick appends no store record, and the counters read back", () => {
      lane = makeLaneEnv(mode);
      const { vault } = lane;
      const procedures = join(vault, "Brain", "procedures");
      writeLanePage(
        vault,
        join(procedures, "proc-deploy.md"),
        { kind: "brain-procedure", triggers: ["deploy"] },
        "# Deploy\n",
      );
      reconcileProceduralMemory(vault, { roots: [procedures] });
      const [entry] = listProceduralMemory(vault);
      const before = lane.laneRecords().length;

      markProceduralMemoryUsed(vault, entry!.id, new Date("2026-11-15T10:00:00Z"));
      markProceduralMemoryUsed(vault, entry!.id, new Date("2026-11-15T11:00:00Z"));
      recordProceduralOutcome(vault, entry!.id, "success");
      expect(lane.laneRecords()).toHaveLength(before);

      const counted = {
        usedCount: 2,
        lastUsedAt: "2026-11-15T11:00:00.000Z",
        successCount: 1,
        failureCount: 0,
      };
      expect(listProceduralMemory(vault)[0]).toMatchObject(counted);
      // A reconcile with no source change keeps the counters and appends nothing either.
      reconcileProceduralMemory(vault, { roots: [procedures] });
      expect(lane.laneRecords()).toHaveLength(before);
      expect(listProceduralMemory(vault)[0]).toMatchObject(counted);
    });
  },
);

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "procedural files a machine switched before they became machine state (%s)",
  (mode) => {
    test("are read from their store records before the next reconcile, and adopted", () => {
      lane = makeLaneEnv(mode);
      const { vault } = lane;
      const pmem = join(vault, "Brain", "procedural-memory");
      // What a migration of an earlier release imported: the files as lane entries.
      const index = {
        schema_version: 1,
        entries: [
          {
            id: "pmem-1",
            kind: "procedure",
            sourcePath: "Brain/procedures/deploy.md",
            title: "Deploy",
            triggers: [],
            tags: [],
            permissions: [],
            source: null,
            version: null,
            lastUsedAt: null,
            usedCount: 0,
            successCount: 0,
            failureCount: 0,
          },
        ],
      };
      const graph = {
        schema_version: 1 as const,
        generated_at: "2026-11-01T00:00:00.000Z",
        nodes: [],
        edges: [],
      };
      const hints = {
        schema_version: 1 as const,
        generated_at: "2026-11-01T00:00:00.000Z",
        entries: [],
      };
      writeLaneText(vault, join(pmem, "index.json"), `${JSON.stringify(index)}\n`);
      writeLaneText(
        vault,
        join(pmem, "usage.jsonl"),
        `${JSON.stringify({ id: "pmem-1", usedCount: 7, lastUsedAt: "2026-11-02T00:00:00.000Z" })}\n`,
      );
      writeLaneText(vault, join(pmem, "graph.json"), `${JSON.stringify(graph)}\n`);
      writeLaneText(vault, join(pmem, "hints.json"), `${JSON.stringify(hints)}\n`);
      const records = lane.laneRecords().length;

      expect(readProceduralGraph(vault)).toEqual(graph);
      expect(readProceduralHints(vault)).toEqual(hints);
      expect(listProceduralMemory(vault)[0]).toMatchObject({ id: "pmem-1", usedCount: 7 });
      // Adopted into this machine's state on the first read, writing no record.
      expect(readFileSync(proceduralMemoryUsagePath(vault), "utf8")).toContain('"usedCount":7');
      expect(existsSync(proceduralGraphPath(vault))).toBe(true);
      expect(lane.laneRecords()).toHaveLength(records);
      // A tick counts on from the adopted counters.
      markProceduralMemoryUsed(vault, "pmem-1", new Date("2026-11-15T10:00:00Z"));
      expect(listProceduralMemory(vault)[0]?.usedCount).toBe(8);
    });
  },
);

describe.each(LANE_MODES)("the skill accept journal (%s)", (mode) => {
  test("a journal left by an interrupted accept is read back and resolved", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const before = lane.vaultHash();
    writeSkillAcceptJournal(vault, {
      slug: "half-done",
      id: "sp-half-done",
      phase: "archive",
      startedAt: "2026-06-01T12:00:00Z",
      acceptedExisted: false,
      materializedExisted: false,
    });
    expect(readSkillAcceptJournals(vault).entries.map((e) => e.slug)).toEqual(["half-done"]);
    expect(recoverSkillProposalAccepts(vault).map((r) => r.slug)).toEqual(["half-done"]);
    expect(readSkillAcceptJournals(vault).entries).toEqual([]);
    if (mode === "legacy") return;
    expect(lane.vaultHash()).toBe(before);
    // A repair marker is machine state, never a lane record.
    expect(lane.laneRecords()).toEqual([]);
  });

  test("a held accept lock refuses and names a file that is there", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const held = acquireLockSync(skillAcceptLockPath(vault).replace(/\.lock$/u, ""));
    try {
      let refusal: unknown = null;
      try {
        recoverSkillProposalAccepts(vault);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(SkillAcceptLockedError);
      expect(existsSync((refusal as SkillAcceptLockedError).path)).toBe(true);
    } finally {
      held.release();
    }
  });
});

function seedCorePatterns(vaultPath: string): void {
  const records = [
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-20T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 101 in module alpha",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-20T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 102 in module beta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-21T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 103 in module gamma",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-21T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 104 in module delta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-22T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 105 in module epsilon",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-22T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 106 in module zeta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-23T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 107 in module eta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-23T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 108 in module theta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-24T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 109 in module iota",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-24T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 110 in module kappa",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-25T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 111 in module lambda",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-25T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 112 in module mu",
      },
    },
  ];

  for (const record of records) {
    appendContinuityRecord(vaultPath, {
      kind: record.kind,
      createdAt: record.createdAt,
      sourceRefs: [{ id: `src-${record.createdAt}` }],
      payload: record.payload,
    });
  }
}

describe("procedural usage counted by two processes", () => {
  test("a reconcile never drops a tick another process counted", async () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const procedures = join(vault, "Brain", "procedures");
    writeLanePage(
      vault,
      join(procedures, "proc-deploy.md"),
      { kind: "brain-procedure" },
      "# Deploy\n",
    );
    reconcileProceduralMemory(vault, { roots: [procedures] });
    const [entry] = listProceduralMemory(vault);
    const TICKS = 60;
    const readyDir = join(lane.env.parent, "ready");
    const goFile = join(lane.env.parent, "go");
    mkdirSync(readyDir, { recursive: true });
    const worker = join(import.meta.dir, "fixtures", "usage-worker.ts");
    const children = (
      [
        ["tick", TICKS],
        ["reconcile", 20],
      ] as const
    ).map(([role, rounds]) =>
      Bun.spawn(
        [process.execPath, worker, vault, role, String(rounds), entry!.id, readyDir, goFile],
        { stdout: "ignore", stderr: "pipe", env: { ...process.env } },
      ),
    );
    const readyBy = Date.now() + 30_000;
    while (readdirSync(readyDir).length < 2 && Date.now() < readyBy) await Bun.sleep(5);
    writeFileSync(goFile, "go\n");
    const [codes, errors] = await Promise.all([
      Promise.all(children.map((child) => child.exited)),
      Promise.all(children.map((child) => new Response(child.stderr).text())),
    ]);
    expect(errors.filter((e) => e.trim() !== "")).toEqual([]);
    expect(codes).toEqual([0, 0]);
    expect(listProceduralMemory(vault)[0]?.usedCount).toBe(TICKS);
  }, 60_000);
});

describe("a reconcile that fails after the index", () => {
  test("has already moved the counters an older index carried into the usage file", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const procedures = join(vault, "Brain", "procedures");
    writeLanePage(
      vault,
      join(procedures, "proc-deploy.md"),
      { kind: "brain-procedure" },
      "# Deploy\n",
    );
    const id = proceduralEntryId("Brain/procedures/proc-deploy.md");
    // An index of an earlier release, its counters on the entry itself.
    const entry = {
      id,
      kind: "procedure",
      sourcePath: "Brain/procedures/proc-deploy.md",
      title: "Deploy",
      triggers: [],
      tags: [],
      permissions: [],
      source: null,
      version: null,
      lastUsedAt: "2026-11-01T00:00:00.000Z",
      usedCount: 5,
      successCount: 0,
      failureCount: 0,
    };
    writeLaneText(
      vault,
      join(vault, "Brain", "procedural-memory", "index.json"),
      `${JSON.stringify({ schema_version: 1, entries: [entry] })}\n`,
    );
    // The graph cannot be written: the rebuild after the index fails.
    mkdirSync(proceduralGraphPath(vault), { recursive: true });
    expect(() => reconcileProceduralMemory(vault, { roots: [procedures] })).toThrow();
    expect(listProceduralMemory(vault)[0]).toMatchObject({ id, usedCount: 5 });
  });
});
