/**
 * The record-lane modules on the lane page store (task 2.10 WP6), each in
 * every mode: an unswitched machine writes its pages, a store-only machine
 * and a machine with no vault write lane-entry records, change nothing in
 * the vault, and read back what they wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeHandoffNote } from "../../../src/core/brain/handoff.ts";
import {
  addObligation,
  completeObligation,
  listObligations,
  obligationExists,
  removeObligation,
  showObligation,
} from "../../../src/core/brain/obligations.ts";
import {
  closeThesis,
  listTheses,
  recordThesis,
  recordThesisSupport,
  showThesis,
} from "../../../src/core/brain/health/thesis.ts";
import {
  confirmTension,
  listTensions,
  persistTension,
  showTension,
} from "../../../src/core/brain/tensions.ts";
import {
  addPledge,
  fulfillPledge,
  listPledges,
  removePledge,
  showPledge,
} from "../../../src/core/brain/pledges.ts";
import { isProfileStale, writeProfileDoc } from "../../../src/core/brain/profile-doc.ts";
import {
  loadLatestReportSnapshot,
  writeReportSnapshot,
} from "../../../src/core/brain/report-snapshot.ts";
import { loadPersonas, personasDir } from "../../../src/core/brain/write-session/personas.ts";
import {
  createWriteSession,
  deleteWriteSession,
  listWriteSessions,
  readWriteSession,
  saveWriteSession,
} from "../../../src/core/brain/write-session/store.ts";
import type { WriteSessionRecord } from "../../../src/core/brain/write-session/types.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import {
  autoCloseRecalledGaps,
  GAP_TASK_CLOSED_RETENTION_MS,
  GAP_TASK_STATUS_CLOSED,
  gapTaskKey,
  listGapTasks,
  promoteGapsToTasks,
  type GapRecallRetriever,
} from "../../../src/core/brain/gaps/gap-loop.ts";
import type { RecallResultSet } from "../../../src/core/brain/recall-inject.ts";
import {
  archiveCapture,
  listAllCaptures,
  listStagedCaptures,
  readCaptureNote,
  writeCaptureNote,
} from "../../../src/core/brain/capture/capture-note.ts";
import {
  archiveEntity,
  getEntity,
  listEntities,
  relateEntities,
  upsertEntity,
} from "../../../src/core/brain/entities/registry.ts";
import { resolvePersonNicknameMap } from "../../../src/core/brain/entities/person-nicknames.ts";
import { listAttentionFlows } from "../../../src/core/brain/attention-flows.ts";
import {
  dismissHallwayKey,
  readDismissedHallwayKeys,
} from "../../../src/core/brain/link-graph/hallways.ts";
import {
  CO_OCCURRENCE_SCHEMA_VERSION,
  readCoOccurrenceSuggestions,
  writeCoOccurrenceSuggestions,
} from "../../../src/core/brain/link-graph/co-occurrence.ts";
import {
  discardDreamBundle,
  listDreamBundles,
  stageDream,
} from "../../../src/core/brain/dream-stage.ts";
import { writeResearchReport } from "../../../src/core/brain/research/research.ts";
import {
  discardSourceArchive,
  putSourceArchive,
  readSourceArchiveEntry,
  sourceArchiveStats,
} from "../../../src/core/brain/provenance/source-archive.ts";
import {
  applyPendingLane,
  listPendingLane,
  stageForReview,
} from "../../../src/core/brain/pending/pending-lanes.ts";
import { deleteBySource } from "../../../src/core/brain/source-cleanup.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { storeSignalRecords } from "../../../src/core/brain/memory-page-records.ts";
import { storeRecordPages } from "../../../src/core/brain/memory-pages.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  listIntentions,
  moveIntentionToHistory,
  setIntention,
  showIntention,
} from "../../../src/core/brain/intentions.ts";
import { discoverIdeas } from "../../../src/core/brain/idea-discovery.ts";
import { commitDesignNote } from "../../../src/core/brain/design-note.ts";
import {
  listOpenDecisions,
  openDecision,
  resolveOpenDecision,
} from "../../../src/core/brain/decisions/open-store.ts";
import {
  backfillOutcome,
  listDecisions,
  recordDecision,
  showDecision,
} from "../../../src/core/brain/decisions/record.ts";
import {
  createTriggers,
  listTriggers,
  transitionTrigger,
} from "../../../src/core/brain/triggers/store.ts";
import {
  lanePageExists,
  laneVaultRoot,
  readLanePage,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-07T12:00:00Z");

/** In store modes: nothing changed in the vault, and the lane records are of exactly `laneNames`. */
function expectStoreOnly(env: LaneEnv, before: string, ...laneNames: string[]): void {
  if (env.mode === "legacy") return;
  expect(env.vaultHash()).toBe(before);
  expect(existsSync(laneVaultRoot(null))).toBe(false);
  const lanes = new Set(env.laneRecords().map((r) => r.body["lane"]));
  expect([...lanes].toSorted()).toEqual(laneNames.toSorted());
}

describe.each(LANE_MODES)("record lanes (%s)", (mode) => {
  test("obligations: add, complete, list, archive", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    addObligation(vault, {
      title: "Pay rent",
      cadence: "monthly",
      agent: "@t",
      anchor: "2026-11-01",
      now: NOW,
    });
    expect(obligationExists(vault, "pay-rent")).toBe(true);
    const done = completeObligation(vault, { slug: "pay-rent", date: "2026-11-01", now: NOW });
    expect(done.nextDue).toBe("2026-12-01");
    expect(showObligation(vault, "pay-rent")?.completions).toEqual(["2026-11-01"]);
    expect(listObligations(vault, { now: NOW }).map((o) => o.slug)).toEqual(["pay-rent"]);
    const removed = removeObligation(vault, "pay-rent");
    expect(removed.archivePath).toContain(join("obligations", "archive"));
    expect(listObligations(vault, { now: NOW })).toEqual([]);
    expectStoreOnly(lane, before, "obligations");
  });

  test("handoffs: the session note is written and reads back", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const result = writeHandoffNote(lane.vault, {
      sessionId: "session-1",
      agent: "@t",
      turns: [],
      now: NOW,
    } as Parameters<typeof writeHandoffNote>[1]);
    expect(readLanePage(lane.vault, result.path)?.frontmatter["session_id"]).toBe("session-1");
    expectStoreOnly(lane, before, "handoffs");
  });

  test("theses: record, support, close, list", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const thesis = recordThesis(vault, {
      statement: "Small PRs ship faster",
      agent: "@t",
      now: NOW,
    } as Parameters<typeof recordThesis>[1]);
    recordThesisSupport(vault, thesis.slug, { date: "2026-11-07", now: NOW });
    closeThesis(vault, thesis.slug);
    expect(showThesis(vault, thesis.slug)?.status).toBe("closed");
    expect(listTheses(vault).map((t) => t.slug)).toEqual([thesis.slug]);
    expect(listTheses(vault, { activeOnly: true })).toEqual([]);
    expectStoreOnly(lane, before, "theses");
  });

  test("tensions: persist, confirm, list", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
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
      { agent: "tester", now: NOW },
    );
    confirmTension(vault, record.slug, { agent: "tester", now: NOW });
    expect(showTension(vault, record.slug)?.status).toBe("confirmed");
    expect(listTensions(vault).map((t) => t.slug)).toEqual([record.slug]);
    expectStoreOnly(lane, before, "tensions");
  });

  test("tensions: a tension private by its partition alone stays out of shared", () => {
    lane = makeLaneEnv(mode);
    // An unswitched machine's page is the file, which holds no partition.
    if (mode === "legacy") return;
    const { vault } = lane;
    // Two shared preferences, so the tension's links name pages that judge
    // shared: the tension is private only by where its records sit.
    for (const slug of ["tabs", "spaces"]) {
      writePreference(
        vault,
        {
          slug,
          topic: slug,
          principle: `principle ${slug}`,
          created_at: "2026-11-01T00:00:00Z",
          unconfirmed_until: "2026-11-30T00:00:00Z",
          status: "unconfirmed",
          evidenced_by: [],
        },
        { authority: "agent" },
      );
    }
    const { record } = withOperationPrivacy(true, () =>
      persistTension(
        vault,
        {
          aId: "pref-tabs",
          bId: "pref-spaces",
          subject: "secret subject",
          jaccard: 0.6,
          aSign: "positive",
          bSign: "negative",
          aQuote: "Always use tabs.",
          bQuote: "Never use tabs.",
          action: "ask_user",
        },
        { agent: "tester", now: NOW },
      ),
    );
    const shared = () =>
      readPartition(join(lane!.env.storeRoot, "shared"))
        .flatMap((shard) => shard.all)
        .filter((r) => JSON.stringify(r).includes(record.slug));
    expect(shared()).toEqual([]);
    confirmTension(vault, record.slug, { agent: "tester", now: NOW });
    expect(shared()).toEqual([]);
    expect(showTension(vault, record.slug)?.status).toBe("confirmed");
  });

  test("pledges: add from a source note, fulfill, list, archive", () => {
    // A pledge cites a user note, so it needs a vault (the note is a file
    // in every mode); its own page is a lane page.
    if (mode === "no-vault") return;
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "call.md"), "# Call\n\nI will send the report by Friday.\n");
    const before = lane.vaultHash();
    const page = addPledge(vault, {
      title: "Send the report",
      due: "2026-11-13",
      source: "notes/call.md",
      evidence: ["I will send the report by Friday."],
      agent: "@t",
      now: NOW,
    });
    fulfillPledge(vault, { slug: page.slug, date: "2026-11-12", now: NOW });
    expect(showPledge(vault, { slug: page.slug })?.fulfilled).toBe("2026-11-12");
    expect(listPledges(vault, { now: NOW, includeFulfilled: true }).map((p) => p.slug)).toEqual([
      page.slug,
    ]);
    removePledge(vault, { slug: page.slug });
    expect(showPledge(vault, { slug: page.slug })).toBeNull();
    expectStoreOnly(lane, before, "pledges");
  });

  test("profile: written, fresh, stale later", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    // The legacy profile ages by its file time, so the clock is the real one.
    const now = new Date();
    expect(isProfileStale(vault, 3600, now)).toBe(true);
    writeProfileDoc(vault, { now });
    expect(isProfileStale(vault, 3600, now)).toBe(false);
    expect(isProfileStale(vault, 3600, new Date(now.getTime() + 7_200_000))).toBe(true);
    expect(existsSync(join(vault, ".o2bfs"))).toBe(mode === "legacy");
    expectStoreOnly(lane, before, "brain");
  });

  test("report snapshots: the newest before a date", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    writeReportSnapshot(vault, "health", "2026-11-05", { a: 1 });
    writeReportSnapshot(vault, "health", "2026-11-06", { a: 2 });
    expect(loadLatestReportSnapshot(vault, "health", "2026-11-07")).toEqual({
      date: "2026-11-06",
      payload: { a: 2 },
    });
    expect(loadLatestReportSnapshot(vault, "health", "2026-11-05")).toBeNull();
    expectStoreOnly(lane, before, "reports");
  });

  test("write sessions: create exclusively, save, list, delete", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const at = NOW.toISOString();
    const build = (id: string): WriteSessionRecord => ({
      id,
      kind: "artifact",
      status: "needs-llm-step",
      step: "artifact",
      agent: "@t",
      createdAt: at,
      updatedAt: at,
      expiresAt: "2026-11-09T12:00:00Z",
      attempts: 0,
      retryCap: 3,
      targetPath: "notes/x.md",
      intent: "create",
      requireReview: false,
      prompt: "Write it.",
      schemaType: null,
      topic: null,
      personas: [],
      responses: {},
      pendingArtifact: null,
      lastErrors: [],
      failReason: null,
    });
    const a = createWriteSession(vault, at, build);
    const b = createWriteSession(vault, at, build);
    expect(a.id).not.toBe(b.id);
    saveWriteSession(vault, { ...a, attempts: 1 });
    expect(readWriteSession(vault, a.id, at).session?.attempts).toBe(1);
    expect(listWriteSessions(vault, at).length).toBe(2);
    deleteWriteSession(vault, a.id);
    expect(readWriteSession(vault, a.id, at).session).toBeNull();
    expectStoreOnly(lane, before, "write-session");
  });

  test("personas: defaults, then a curated one", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const defaults = loadPersonas(vault);
    const before = lane.vaultHash();
    writeLaneText(
      vault,
      join(personasDir(vault), "skeptic.md"),
      "---\nkind: persona\nlens: doubt\n---\nFind the weak spot.\n",
    );
    expect(loadPersonas(vault)).toEqual([
      { slug: "skeptic", lens: "doubt", prompt: "Find the weak spot." },
    ]);
    expect(defaults.length).toBeGreaterThan(0);
    expectStoreOnly(lane, before, "personas");
  });

  test("decisions: record, backfill, list", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const {
      record: { slug },
    } = recordDecision(vault, {
      title: "Index location",
      chosen: "Outside the vault",
      assumption: "Sync clients must not copy a binary index",
      reviewDate: "2027-01-01",
      agent: "@t",
      now: NOW,
    });
    backfillOutcome(vault, { slug, outcome: "held", now: NOW });
    expect(showDecision(vault, slug)?.outcome).toBe("held");
    expect(listDecisions(vault).map((d) => d.slug)).toEqual([slug]);
    expectStoreOnly(lane, before, "decisions", "obligations");
  });

  test("open decisions: park, list, resolve into a decision", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const rec = openDecision(vault, {
      title: "Importer",
      question: "Do we keep the legacy importer?",
      options: ["keep", "drop"],
      agent: "@t",
      now: NOW,
    });
    expect(listOpenDecisions(vault).records.map((r) => r.id)).toEqual([rec.id]);
    resolveOpenDecision(vault, rec.id, { choice: "drop", actor: "@t", now: NOW });
    expect(listOpenDecisions(vault).records.map((r) => r.status)).toEqual(["resolved"]);
    expect(listDecisions(vault)).toHaveLength(1);
    expectStoreOnly(lane, before, "decisions", "obligations");
  });

  test("design notes: committed into the decisions lane", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const alt = (name: string, recommended: boolean) => ({
      name,
      approach: `Store it with ${name}.`,
      tradeoffs: `${name} trades write cost for read latency.`,
      recommended,
    });
    commitDesignNote(
      vault,
      "index storage",
      { title: "Where the index lives", alternatives: [alt("a", true), alt("b", false)] },
      { agent: "@t", now: NOW },
    );
    expectStoreOnly(lane, before, "decisions");
    if (mode !== "legacy") expect(lane.laneRecords().length).toBe(1);
  });

  test("triggers: create, deduplicate, dismiss", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const candidate = {
      kind: "contradiction" as const,
      urgency: "high" as const,
      reason: "pref-a contradicts pref-b",
      suggestedAction: "Retire one",
      sourceArtifacts: ["[[pref-a]]", "[[pref-b]]"],
      contextSnippets: ["pref-a: do X", "pref-b: never do X"],
      cooldownKey: "contradiction:pref-a:pref-b",
    };
    const { created } = createTriggers(vault, [candidate], { now: NOW });
    expect(createTriggers(vault, [candidate], { now: NOW }).created).toHaveLength(0);
    transitionTrigger(vault, created[0]!.id, "dismiss", { now: NOW });
    expect(listTriggers(vault, { now: NOW }).map((t) => t.status)).toEqual(["dismissed"]);
    expectStoreOnly(lane, before, "triggers");
  });

  test("gap tasks: promoted once from recurring recall gaps", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    for (let i = 0; i < 3; i++) {
      emitRecallTelemetry(vault, {
        host: "test",
        channel: RECALL_CHANNEL.cli,
        mode: "search",
        status: "empty",
        durationMs: 0,
        resultCount: 0,
        gaps: ["alpha topic"],
        createdAt: `2026-11-0${i + 1}T09:00:00.000Z`,
      });
    }
    // Telemetry is a ledger (another package); only the gap-task lane is measured here.
    const before = lane.vaultHash();
    expect(promoteGapsToTasks(vault, { threshold: 2, now: NOW }).created).toHaveLength(1);
    expect(promoteGapsToTasks(vault, { threshold: 2, now: NOW }).created).toHaveLength(0);
    expect(listGapTasks(vault).map((t) => t.topic)).toEqual(["alpha topic"]);
    expectStoreOnly(lane, before, "gap-tasks");
  });

  test("gap tasks: a recalled task is closed, and pruned once past its retention", async () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    for (let i = 0; i < 3; i++) {
      emitRecallTelemetry(vault, {
        host: "test",
        channel: RECALL_CHANNEL.cli,
        mode: "search",
        status: "empty",
        durationMs: 0,
        resultCount: 0,
        gaps: ["alpha topic"],
        createdAt: `2026-11-0${i + 1}T09:00:00.000Z`,
      });
    }
    const before = lane.vaultHash();
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // A recall that covers the topic: an ordinary note the membership rule admits.
    const recalled: GapRecallRetriever = async () =>
      ({
        candidates: [
          {
            path: "notes/x.md",
            title: "X",
            score: 0.9,
            searchType: "hybrid",
            startLine: 1,
            endLine: 2,
          },
        ],
        total: 1,
        idfWeightedCoverage: 0.92,
      }) satisfies RecallResultSet;
    const closed = await autoCloseRecalledGaps(vault, recalled, { confidenceFloor: 0.5, now: NOW });
    expect(closed.closed).toEqual([gapTaskKey("alpha topic")]);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_CLOSED }).map((t) => t.topic)).toEqual([
      "alpha topic",
    ]);
    const later = new Date(NOW.getTime() + GAP_TASK_CLOSED_RETENTION_MS + 1);
    expect(promoteGapsToTasks(vault, { threshold: 99, now: later }).pruned).toEqual([
      gapTaskKey("alpha topic"),
    ]);
    expect(listGapTasks(vault)).toEqual([]);
    expectStoreOnly(lane, before, "gap-tasks");
  });

  test("captures: stage two, archive one, read both", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const prov = (s: string) => ({
      source: "telegram",
      sender: "100",
      capturedAt: `2026-11-07T12:00:${s}Z`,
    });
    const a = writeCaptureNote(vault, { body: "First idea.", provenance: prov("01") });
    const b = writeCaptureNote(vault, { body: "Second idea.", provenance: prov("02") });
    expect(listStagedCaptures(vault).map((c) => c.id)).toEqual([a.id, b.id]);
    archiveCapture(vault, a.id);
    expect(readCaptureNote(vault, a.id)?.staged).toBe(false);
    expect(readCaptureNote(vault, b.id)?.body).toBe("Second idea.");
    expect(listAllCaptures(vault)).toHaveLength(2);
    expectStoreOnly(lane, before, "captures");
  });

  test("entities: upsert, relate, archive, list; nicknames read from the lane", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const ada = upsertEntity(vault, {
      category: "people",
      name: "Ada",
      aliases: ["A.L."],
      agent: "@t",
      now: NOW,
    });
    expect(ada.created).toBe(true);
    expect(
      upsertEntity(vault, { category: "people", name: "Ada", agent: "@t", now: NOW }).created,
    ).toBe(false);
    upsertEntity(vault, { category: "projects", name: "Engine", agent: "@t", now: NOW });
    const related = relateEntities(vault, {
      from: { category: "people", query: "Ada" },
      relation: "related",
      to: { category: "projects", query: "Engine" },
      now: NOW,
    });
    expect(related.relations).toEqual([{ relation: "related", target: "ent-projects-engine" }]);
    expect(getEntity(vault, { category: "people", query: "A.L." })?.name).toBe("Ada");
    archiveEntity(vault, { category: "projects", query: "Engine" }, { now: NOW });
    expect(listEntities(vault).map((e) => [e.name, e.status])).toEqual([
      ["Ada", "active"],
      ["Engine", "archived"],
    ]);
    if (mode !== "legacy") {
      writeLaneText(
        vault,
        join(vault, "Brain", "entities", "person-nicknames.json"),
        '{"Bob": ["Robert"]}\n',
      );
    }
    expect(resolvePersonNicknameMap(vault)).toBeDefined();
    expectStoreOnly(lane, before, "entities");
  });

  test("attention flows: the default flow is created once and listed", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    expect(listAttentionFlows(vault).map((f) => f.id)).toEqual(["open-loops"]);
    expect(listAttentionFlows(vault).map((f) => f.id)).toEqual(["open-loops"]);
    expectStoreOnly(lane, before, "attention");
    if (mode !== "legacy") expect(lane.laneRecords()).toHaveLength(1);
  });

  test("link graph: hallway dismissals and co-occurrence suggestions", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    expect(dismissHallwayKey(vault, "people", "ada")).toBe(true);
    expect(dismissHallwayKey(vault, "people", "ada")).toBe(false);
    expect(readDismissedHallwayKeys(vault).size).toBe(1);
    writeCoOccurrenceSuggestions(
      vault,
      { schema: CO_OCCURRENCE_SCHEMA_VERSION, vaultHash: "h", documentCount: 2, suggestions: [] },
      { generatedAt: NOW.toISOString() },
    );
    expect(readCoOccurrenceSuggestions(vault)?.documentCount).toBe(2);
    expectStoreOnly(lane, before, "link-graph", "proposals");
  });

  test("dream bundles: stage, list, discard", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const bundle = stageDream(vault, { now: NOW });
    expect(listDreamBundles(vault).map((b) => [b.runId, b.status])).toEqual([
      [bundle.runId, "staged"],
    ]);
    expect(discardDreamBundle(vault, bundle.runId)).toBe(true);
    expect(listDreamBundles(vault)).toEqual([]);
    expectStoreOnly(lane, before, "dream");
  });

  test("research reports: a cited report page in the reports lane", () => {
    // A report cites the user's notes, so it needs a vault (the notes are
    // files in every mode); the report page itself is a lane page.
    if (mode === "no-vault") return;
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles", "a.md"), "# A\n\nSlashing.\n");
    const before = lane.vaultHash();
    const input = {
      title: "Restaking risk",
      sources: ["Articles/a.md"],
      findings: [{ statement: "Slashing compounds", sources: ["Articles/a.md"] }],
    };
    expect(writeResearchReport(vault, input, { agent: "@t", now: NOW }).created).toBe(true);
    expect(writeResearchReport(vault, input, { agent: "@t", now: NOW }).created).toBe(false);
    const res = writeResearchReport(vault, input, { agent: "@t", now: NOW });
    expect(readLanePage(vault, join(vault, res.reportPath))?.body).toContain("Slashing compounds");
    expectStoreOnly(lane, before, "reports");
  });

  test("source archives: put once, read verified, count, discard", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const { hash, bytes } = putSourceArchive(vault, "The redacted source.\n");
    putSourceArchive(vault, "The redacted source.\n");
    expect(readSourceArchiveEntry(vault, hash)?.state).toBe("verified");
    expect(sourceArchiveStats(vault)).toEqual({ entries: 1, totalBytes: bytes });
    expect(discardSourceArchive(vault, hash)).toBe(true);
    expect(readSourceArchiveEntry(vault, hash)).toBeNull();
    expectStoreOnly(lane, before, "source-archive");
    if (mode !== "legacy") {
      // The migration's blob lane: private wherever this machine holds it.
      expect(lane.laneRecords("shared")).toHaveLength(0);
    }
  });

  test("review queue: stage an ingest page, list it, apply it into the sources lane", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    const staged = stageForReview(
      vault,
      "ingest",
      "Brain/sources/src-paper.md",
      () => "---\nkind: brain-source\n---\nPaper.\n",
    );
    expect(listPendingLane(vault, "ingest").entries.map((e) => e.id)).toEqual([staged.pendingId]);
    applyPendingLane(vault, staged.pendingId);
    expect(listPendingLane(vault, "ingest").entries).toEqual([]);
    expect(readLanePage(vault, join(vault, "Brain", "sources", "src-paper.md"))?.body).toContain(
      "Paper.",
    );
    expectStoreOnly(lane, before, "pending", "sources");
  });

  test("source cleanup: a summary page derived from one source is planned and removed", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const before = lane.vaultHash();
    writeLaneText(
      vault,
      join(vault, "Brain", "sources", "src-a.md"),
      "---\nkind: brain-source\nsource_path: notes/a.md\n---\nSummary.\n",
    );
    const plan = deleteBySource(vault, "notes/a.md");
    expect(plan.derived.map((e) => e.path)).toEqual(["Brain/sources/src-a.md"]);
    const done = deleteBySource(vault, "notes/a.md", { confirm: true, now: NOW });
    expect(done.deleted).toEqual(["Brain/sources/src-a.md"]);
    expect(lanePageExists(vault, join(vault, "Brain", "sources", "src-a.md"))).toBe(false);
    expectStoreOnly(lane, before, "sources");
  });

  test("source cleanup: a signal derived from one source is planned and forgotten", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    writeSignal(vault, {
      topic: "tabs",
      signal: "positive",
      agent: "@t",
      principle: "Use tabs",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "tabs",
      source: ["[[notes/a.md]]"],
    });
    const plan = deleteBySource(vault, "notes/a.md");
    expect(plan.derived.map((e) => e.kind)).toEqual(["signal"]);
    const done = deleteBySource(vault, "notes/a.md", { confirm: true, now: NOW });
    expect(done.deleted).toHaveLength(1);
    expect(deleteBySource(vault, "notes/a.md").derived).toEqual([]);
    if (mode === "legacy") return;
    // Forgotten, not retired: no reader shows the signal or its text.
    expect(storeSignalRecords(vault, "all").records).toEqual([]);
    expect(JSON.stringify(storeRecordPages(vault, { signalStates: "all" }))).not.toContain(
      "Use tabs",
    );
    const tombstones = (["shared", "private"] as const)
      .flatMap((partition) => readPartition(join(lane!.env.storeRoot, partition)))
      .flatMap((shard) => shard.all)
      .filter((r) => r.kind === "signal-removed");
    expect(tombstones).toHaveLength(1);
  });

  test("intentions: set twice, show, list, retire to history", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const { vault } = lane;
    setIntention(vault, { scope: "work", text: "Ship the store", agent: "@t", now: NOW });
    const second = setIntention(vault, {
      scope: "work",
      text: "Ship it today",
      agent: "@t",
      now: NOW,
    });
    expect(second.version).toBe(2);
    expect(showIntention(vault, "work")?.history).toHaveLength(1);
    expect(listIntentions(vault).map((c) => c.scope)).toEqual(["work"]);
    moveIntentionToHistory(vault, { scope: "work", now: NOW });
    expect(listIntentions(vault)).toEqual([]);
    expectStoreOnly(lane, before, "intentions");
  });

  test("idea discovery reads lane notes and inbox signals in every mode", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    writeLaneText(
      vault,
      join(vault, "Brain", "research", "otters.md"),
      "# Otters\n\nNobody links here.\n",
    );
    writeSignal(vault, {
      topic: "otter-care",
      signal: "positive",
      agent: "@t",
      principle: "Feed otters",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "otter-care",
    });
    const ideas = discoverIdeas(vault, {
      now: new Date(Date.now() + 86_400_000),
      cap: 10,
      agingSignalDays: 0,
    });
    const kinds = ideas.map((i) => [i.kind, i.sourceArtifacts[0]]);
    expect(kinds).toContainEqual(["orphan_research", "Brain/research/otters.md"]);
    expect(ideas.some((i) => i.kind === "idea_direction" && i.title === "otter-care")).toBe(true);
  });
});
