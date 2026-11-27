/**
 * Private-partition lane entries are withheld below local reach: the
 * persisted projections, the references to store-held entries, the
 * write-side judge and the error wording (change
 * `lane-private-partition-reach`, design D1 and D5 to D8).
 *
 * The machine under test keeps its lane pages in the store. Every hidden
 * entry is written by its lane's real writer with a `<private>` region in
 * its text and no `visibility:` field, so the store holds it in `private`
 * by partition alone. A server with no reach minted is a caller below
 * local reach; a server at the local reach is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { dismissTension, persistTension } from "../../src/core/brain/tensions.ts";
import {
  claimSourceIsPrivate,
  logRefsNamePrivatePage,
  withoutReferenceJudging,
} from "../../src/core/store/reference-privacy.ts";
import { foldIncomplete } from "../../src/core/store/lane-entry-store.ts";
import { laneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import { listShards } from "../../src/core/store/shard-list.ts";
import { makeLaneEnv, type LaneEnv, type LaneMode } from "../core/lanes/fixtures/lane-env.ts";
import {
  call,
  callJson,
  carried,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-20T10:00:00Z");

function env(mode: LaneMode = "store"): LaneEnv {
  lane = makeLaneEnv(mode, "osb-lane-refs-");
  return lane;
}

// ----- Persisted projections (design D5) --------------------------------------------

const PROC_HIDDEN = "Brain/procedures/zqprochidden.md";
const PROC_SHARED = "Brain/procedures/zqprocshared.md";
const PROC_MARKS = {
  slug: "zqprochidden",
  title: "Zqproctitlehidden",
  body: "zqprocbody",
  trigger: "zqtrighidden",
  tag: "zqtaghidden",
};

/** A procedure page with its own trigger and tag; `region` makes it private. */
function procedurePage(name: string, region: string): string {
  return (
    `---\ntriggers:\n  - zqtrig${name}\ntags:\n  - zqtag${name}\n---\n\n` +
    `# Zqproctitle${name}\n\nzqprocbody${name === "hidden" ? "" : name} steps\n\n${region}\n`
  );
}

/** One hidden and one shared procedure, written through the lane writer. */
function seedProcedures(e: LaneEnv): void {
  writeLaneText(e.vault, join(e.vault, PROC_HIDDEN), procedurePage("hidden", REGION));
  writeLaneText(e.vault, join(e.vault, PROC_SHARED), procedurePage("shared", ""));
  expect(laneEntryInPrivate(e.vault, join(e.vault, PROC_HIDDEN))).toBe(true);
  expect(laneEntryInPrivate(e.vault, join(e.vault, PROC_SHARED))).toBe(false);
}

interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}
interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

describe("private-partition lane entries are withheld below local reach", () => {
  test("a rebuild below local reach keeps the whole projection", async () => {
    const e = env();
    seedProcedures(e);
    const local = localServer(e);
    await call(local, "brain_procedural_memory", { operation: "reconcile" });
    await call(local, "brain_procedural_graph", { operation: "rebuild" });
    const localNodes = (
      (await callJson(local, "brain_procedural_graph", { operation: "show" }))["nodes"] as unknown[]
    ).length;
    const remote = server(e);
    const rebuilt = await callJson(remote, "brain_procedural_graph", { operation: "rebuild" });
    const show = await callJson(remote, "brain_procedural_graph", { operation: "show" });
    const hints = await callJson(remote, "brain_procedural_graph", { operation: "hints" });
    const counts = rebuilt as { graph?: { nodes?: number }; hints?: { entries?: number } };
    const localShow = await call(local, "brain_procedural_graph", { operation: "show" });
    expect({
      // The answer counts what the caller may see, as `show` and `hints` do.
      nodes_as_shown: counts.graph?.nodes === (show["nodes"] as unknown[]).length,
      entries_as_shown: counts.hints?.entries === (hints["entries"] as unknown[]).length,
      fewer_than_local: (counts.graph?.nodes ?? localNodes) < localNodes,
      // The stored projection is whole: a local caller still sees the entry.
      local_show_hidden: localShow.includes(PROC_MARKS.slug),
    }).toEqual({
      nodes_as_shown: true,
      entries_as_shown: true,
      fewer_than_local: true,
      local_show_hidden: true,
    });
  });

  test("the graph keeps the shared procedure's entity nodes and drops the withheld one's", async () => {
    const e = env();
    seedProcedures(e);
    const local = localServer(e);
    await call(local, "brain_procedural_memory", { operation: "reconcile" });
    await call(local, "brain_procedural_graph", { operation: "rebuild" });
    const remote = server(e);
    const show = await callJson(remote, "brain_procedural_graph", { operation: "show" });
    const hints = await callJson(remote, "brain_procedural_graph", { operation: "hints" });
    const nodes = (show["nodes"] ?? []) as GraphNode[];
    const edges = (show["edges"] ?? []) as GraphEdge[];
    const ids = new Set(nodes.map((n) => n.id));
    const nonEntity = new Set(nodes.filter((n) => n.kind !== "entity").map((n) => n.id));
    const nodeTitled = (title: string) => nodes.find((n) => n.title === title)?.id;
    const sharedTrigger = nodeTitled("Trigger: zqtrigshared");
    const sharedTag = nodeTitled("Tag: zqtagshared");
    const entries = (hints["entries"] ?? []) as Array<{ readonly node_id: string }>;
    expect({
      shared_trigger_edge: edges.some(
        (x) => x.kind === "trigger_matches" && x.to === sharedTrigger,
      ),
      shared_tag_edge: edges.some((x) => x.kind === "tag_matches" && x.to === sharedTag),
      show_names: carried(JSON.stringify(show), PROC_MARKS),
      hints_name: carried(JSON.stringify(hints), PROC_MARKS),
      dangling_edges: edges.filter((x) => !ids.has(x.from) || !ids.has(x.to)).length,
      hints_on_kept_nodes: entries.every((h) => nonEntity.has(h.node_id)),
      hint_entries: entries.length,
    }).toEqual({
      shared_trigger_edge: true,
      shared_tag_edge: true,
      show_names: [],
      hints_name: [],
      dangling_edges: 0,
      hints_on_kept_nodes: true,
      hint_entries: 1,
    });
  });

  test("a private-partition procedure does not hide the shared ones", async () => {
    const e = env();
    seedProcedures(e);
    const local = localServer(e);
    await call(local, "brain_procedural_memory", { operation: "reconcile" });
    const remote = server(e);
    const list = async (s: typeof local) =>
      JSON.stringify(await callJson(s, "brain_procedural_memory", { operation: "list" }));
    const remoteList = await list(remote);
    const localList = await list(local);
    await call(remote, "brain_procedural_memory", { operation: "reconcile" });
    const afterRemoteReconcile = await list(local);
    const names = (answer: string) => ({
      hidden: answer.includes("zqprochidden"),
      shared: answer.includes("zqprocshared"),
    });
    expect({
      remote: names(remoteList),
      local: names(localList),
      local_after_remote_reconcile: names(afterRemoteReconcile),
    }).toEqual({
      remote: { hidden: false, shared: true },
      local: { hidden: true, shared: true },
      local_after_remote_reconcile: { hidden: true, shared: true },
    });
  });
});

// ----- References and the write-side judge (design D6, D7) --------------------------

/** Record a decision at local reach, rate it and give it an outcome; `hidden` makes it private. */
async function ratedDecision(e: LaneEnv, title: string, hidden: boolean) {
  const local = localServer(e);
  const recorded = await callJson(local, "brain_decision", {
    action: "record",
    title,
    chosen: "zqdecchosen path",
    assumption: "it holds",
    review_date: "2026-12-01",
    ...(hidden ? { notes: `zqdecnotes\n\n${REGION}` } : {}),
  });
  const slug = String(recorded["slug"] ?? "");
  const id = String(recorded["id"] ?? "");
  expect(slug).not.toBe("");
  await call(local, "brain_decision", { action: "rate", slug, rating: 4, rationale: "fine" });
  await call(local, "brain_decision", { action: "outcome", slug, outcome: "it worked" });
  const path = join(e.vault, "Brain", "decisions", `${id}.md`);
  expect(laneEntryInPrivate(e.vault, path)).toBe(hidden);
  return { slug, id };
}

/** The decision-receipt rows of one partition that name `slug`. */
function receiptRows(e: LaneEnv, partition: "shared" | "private", slug: string): number {
  const read = readStreamRecords(e.env.storeRoot, partition, {
    stream: "ledgers",
    ledger: "decision-receipts",
  });
  return read.records.filter((r) => JSON.stringify(r.body).includes(slug)).length;
}

describe("private-partition lane entries are withheld below local reach: references", () => {
  test("receipts naming a private-partition decision land in private", async () => {
    const e = env();
    const { slug } = await ratedDecision(e, "Zqdecreceipt choice", true);
    expect({
      private_rows: receiptRows(e, "private", slug) > 0,
      shared_rows: receiptRows(e, "shared", slug),
    }).toEqual({ private_rows: true, shared_rows: 0 });
  });

  test("receipts naming a shared decision stay visible", async () => {
    const e = env();
    const { slug } = await ratedDecision(e, "Zqdecplain choice", false);
    const history = await call(server(e), "brain_decision", { action: "history" });
    expect(history.includes(slug)).toBe(true);
  });

  test("history withholds receipts naming a private-partition decision with no vault", async () => {
    const e = env("no-vault");
    const { slug, id } = await ratedDecision(e, "Zqdechidden choice", true);
    const marks = { slug, id, title: "Zqdechidden", chosen: "zqdecchosen", notes: "zqdecnotes" };
    const localHistory = await call(localServer(e), "brain_decision", { action: "history" });
    const remote = server(e);
    const history = await call(remote, "brain_decision", { action: "history" });
    const timeline = await call(remote, "brain_analytics", { view: "timeline" });
    expect({
      local_history_names_it: carried(localHistory, marks).length > 0,
      history: carried(history, marks),
      timeline: carried(timeline, marks),
    }).toEqual({ local_history_names_it: true, history: [], timeline: [] });
  });

  test("the judge counts a store-held private entry named by an extensionless path or an entity id", async () => {
    const e = env();
    const hidden = await ratedDecision(e, "Zqdecjudged choice", true);
    const shared = await ratedDecision(e, "Zqdecopen choice", false);
    const entity = (name: string, body: string) =>
      upsertEntity(e.vault, { category: "people", name, agent: AGENT, now: NOW, body }).entity;
    const hiddenEntity = entity("Zqjudgehidden Person", `notes\n\n${REGION}\n`);
    const sharedEntity = entity("Zqjudgeshared Person", "notes\n");
    expect(laneEntryInPrivate(e.vault, hiddenEntity.path)).toBe(true);
    expect(laneEntryInPrivate(e.vault, sharedEntity.path)).toBe(false);
    const extensionless = (id: string) => `Brain/decisions/${id}`;
    expect({
      claim_hidden: claimSourceIsPrivate(e.vault, extensionless(hidden.id)),
      claim_shared: claimSourceIsPrivate(e.vault, extensionless(shared.id)),
      entity_hidden: logRefsNamePrivatePage(e.vault, [hiddenEntity.id]),
      entity_shared: logRefsNamePrivatePage(e.vault, [sharedEntity.id]),
    }).toEqual({
      claim_hidden: true,
      claim_shared: false,
      entity_hidden: true,
      entity_shared: false,
    });
  });
});

// ----- Error wording (design D8) ----------------------------------------------------

describe("private-partition lane entries are withheld below local reach: error wording", () => {
  test("a private store record id answers as an absent one", async () => {
    const e = env();
    const path = join(e.vault, "Brain", "procedures", "zqrecordhidden.md");
    writeLaneText(e.vault, path, `---\ntitle: Zqrecordhidden\n---\n\nsteps\n\n${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    const record = e
      .laneRecords("private")
      .find((r) => String(r.body["entry"] ?? "").includes("zqrecordhidden"));
    const id = String(record?.id ?? "");
    expect(id).not.toBe("");
    // An unused id of the same shape: the last character changed.
    const unused = id.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const before = readLaneText(e.vault, path);
    const remote = server(e);
    const tombstone = (target: string) =>
      call(remote, "brain_lifecycle", { action: "tombstone", path: target, reason: "test" });
    const onHidden = await tombstone(`store:${id}`);
    const onUnused = await tombstone(`store:${unused}`);
    expect({
      like_absent: onHidden.replaceAll(id, "<id>") === onUnused.replaceAll(unused, "<id>"),
      named: carried(onHidden, { path: "zqrecordhidden", title: "Zqrecordhidden" }),
      unchanged: readLaneText(e.vault, path) === before,
    }).toEqual({ like_absent: true, named: [], unchanged: true });
  });

  test("the gap reporters name no private shard below local reach", async () => {
    const e = env();
    mkdirSync(join(e.vault, "Notes"), { recursive: true });
    writeFileSync(join(e.vault, "Notes", "source.md"), "# Source\n\nA source page.\n", "utf8");
    writeLaneText(
      e.vault,
      join(e.vault, "Brain", "procedures", "zqgaphidden.md"),
      `---\ntitle: Zqgaphidden\n---\n\nsteps\n\n${REGION}\n`,
    );
    // After a fold has read them, the private partition's events shards go.
    laneStoreFold();
    for (const shard of listShards(join(e.env.storeRoot, "private"), { stream: "events" })) {
      rmSync(shard.path, { force: true });
    }
    expect(foldIncomplete()).toBe(true);
    const ask = async (s: ReturnType<typeof server>) => ({
      rules: await call(s, "brain_context", {}),
      forget: await call(s, "brain_delete_by_source", { source_file: "Notes/source.md" }),
    });
    const remote = await ask(server(e));
    const local = await ask(localServer(e));
    // A shard of the private partition, by its `<partition>/<stream>/` name.
    const namesPrivate = (answer: string) => answer.includes("private/events/");
    expect({
      remote_rules: namesPrivate(remote.rules),
      remote_forget: namesPrivate(remote.forget),
      local_rules: namesPrivate(local.rules),
      local_forget: namesPrivate(local.forget),
    }).toEqual({
      remote_rules: false,
      remote_forget: false,
      local_rules: true,
      local_forget: true,
    });
  });
});

// ----- The shared rule (design D1 items 1 to 4) -------------------------------------

describe("private-partition lane entries are withheld below local reach: the shared rule", () => {
  test("a Brain path that names no lane entry does not fail the request", async () => {
    const e = env();
    const remote = server(e);
    const tombstone = (path: string) =>
      call(remote, "brain_lifecycle", { action: "tombstone", path, reason: "test" });
    // A file name no lane keeps, and an absent page a lane would hold.
    const noLane = "Brain/procedures/zqnolane.png";
    const absent = "Brain/procedures/zqabsent.md";
    const onNoLane = await tombstone(noLane);
    const onAbsent = await tombstone(absent);
    const spelled = (answer: string, path: string) =>
      answer.replaceAll(path, "<path>").replaceAll(path.slice("Brain/".length), "<path>");
    expect({
      failed: onNoLane.includes("internal error") || onNoLane.includes("does not map to"),
      like_absent: spelled(onNoLane, noLane) === spelled(onAbsent, absent),
    }).toEqual({ failed: false, like_absent: true });
  });
});

// ----- Derived records (design D12) -------------------------------------------------

/** The records of `stream` in one partition whose body carries `mark`. */
function rowsNaming(
  e: LaneEnv,
  partition: "shared" | "private",
  stream: "log" | "ledgers",
  mark: string,
): number {
  const read = readStreamRecords(e.env.storeRoot, partition, { stream });
  return read.records.filter((r) => JSON.stringify(r.body).includes(mark)).length;
}

/** Persist one tension whose first quote carries a region when `hidden`. */
function tension(e: LaneEnv, k: string, hidden: boolean) {
  return persistTension(
    e.vault,
    {
      aId: `zqten${k}a`,
      bId: `zqten${k}b`,
      subject: `zqten${k}subject`,
      jaccard: 0.5,
      aSign: "positive",
      bSign: "negative",
      aQuote: `zqten${k}quote one${hidden ? ` ${REGION}` : ""}`,
      bQuote: "another quote",
      action: "ask_user",
    },
    { now: NOW },
  ).record;
}

describe("private-partition lane entries are withheld below local reach: derived records", () => {
  test("a decision's review obligation takes the decision's partition", async () => {
    const e = env();
    const local = localServer(e);
    const recorded = await callJson(local, "brain_decision", {
      action: "record",
      title: "Zqdecreview choice",
      chosen: "zqdecreview path",
      assumption: "it holds",
      review_date: "2026-12-01",
      notes: `zqdecreview notes\n\n${REGION}`,
    });
    const obligation = String(
      recorded["review_obligation"] ?? recorded["reviewObligationSlug"] ?? "",
    );
    const placed = () => ({
      private_records: e
        .laneRecords("private")
        .some((r) => JSON.stringify(r.body).includes("Zqdecreview")),
      // The obligation's own record, not only the decision's.
      private_obligation: e
        .laneRecords("private")
        .some(
          (r) =>
            r.body["lane"] === "obligations" &&
            JSON.stringify(r.body).toLowerCase().includes("zqdecreview"),
        ),
      shared_records: e
        .laneRecords("shared")
        .filter((r) => JSON.stringify(r.body).includes("Zqdecreview")).length,
    });
    const created = placed();
    const createdList = await call(server(e), "brain_obligation", { operation: "list" });
    const slug =
      obligation !== ""
        ? obligation
        : String(
            (
              (await callJson(local, "brain_obligation", { operation: "list" }))[
                "obligations"
              ] as Array<Record<string, unknown>>
            )[0]?.["slug"] ?? "",
          );
    await call(local, "brain_obligation", { operation: "done", slug });
    const rewritten = placed();
    const rewrittenList = await call(server(e), "brain_obligation", { operation: "list" });
    expect({
      created,
      created_list: createdList.includes("Zqdecreview"),
      rewritten,
      rewritten_list: rewrittenList.includes("Zqdecreview"),
    }).toEqual({
      created: { private_records: true, private_obligation: true, shared_records: 0 },
      created_list: false,
      rewritten: { private_records: true, private_obligation: true, shared_records: 0 },
      rewritten_list: false,
    });
  });

  test("a tension's log event takes the tension's partition", async () => {
    const e = env();
    const record = tension(e, "hid", true);
    dismissTension(e.vault, record.slug, { now: NOW });
    const marks = { id: record.id, a: "zqtenhida", subject: "zqtenhidsubject" };
    const local = await call(localServer(e), "brain_agent_query", {});
    const remote = await call(server(e), "brain_agent_query", {});
    expect({
      private_events: rowsNaming(e, "private", "log", record.id),
      shared_events: rowsNaming(e, "shared", "log", record.id),
      local_names_it: carried(local, marks).length > 0,
      remote: carried(remote, marks),
    }).toEqual({ private_events: 2, shared_events: 0, local_names_it: true, remote: [] });
  });

  test("a bare id of any lane the store holds is judged by its entry", async () => {
    const e = env();
    const hidden = tension(e, "hid", true);
    const shared = tension(e, "shr", false);
    const session = await callJson(localServer(e), "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: "Brain/reports/zqsesjudged.md",
      prompt: `zqsesjudged draft it\n\n${REGION}`,
    });
    const sessionId = String(session["session_id"] ?? session["id"] ?? "");
    expect(sessionId).not.toBe("");
    // Its terminal audit event names the session by id (design D12).
    await call(localServer(e), "brain_write_session", { op: "abandon", session_id: sessionId });
    withoutReferenceJudging(() =>
      appendLogEvent(e.vault, {
        timestamp: "2026-11-20T10:00:00Z",
        eventType: "tension",
        agent: AGENT,
        body: { tension: hidden.id, action: "noted", subject_a: "zqtenrowsubject", agent: AGENT },
      }),
    );
    const marks = { subject: "zqtenrowsubject" };
    const local = await call(localServer(e), "brain_agent_query", {});
    const remote = await call(server(e), "brain_agent_query", {});
    expect({
      hidden_id: logRefsNamePrivatePage(e.vault, [hidden.id]),
      hidden_link: logRefsNamePrivatePage(e.vault, [`[[${hidden.id}]]`]),
      shared_id: logRefsNamePrivatePage(e.vault, [shared.id]),
      session_id: logRefsNamePrivatePage(e.vault, [sessionId]),
      session_event: [
        rowsNaming(e, "private", "log", sessionId),
        rowsNaming(e, "shared", "log", sessionId),
      ],
      row_in_shared: rowsNaming(e, "shared", "log", "zqtenrowsubject"),
      local_shows_row: carried(local, marks).length > 0,
      remote_shows_row: carried(remote, marks),
    }).toEqual({
      hidden_id: true,
      hidden_link: true,
      shared_id: false,
      session_id: true,
      session_event: [1, 0],
      row_in_shared: 1,
      local_shows_row: true,
      remote_shows_row: [],
    });
  });
});
