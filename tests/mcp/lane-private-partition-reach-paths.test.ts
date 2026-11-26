/**
 * Private-partition lane entries are withheld below local reach by the
 * readers outside the first table of the change `lane-private-partition-
 * reach`: readers that bind no reach check of their own, the trigger
 * queue's own pages, references to store-held ids, the open-decision
 * duplicate refusal, the dead-ends reader, and the intention `set` verb.
 *
 * The machine under test keeps its lane pages in the store
 * (`makeLaneEnv("store")`). Every case writes a hidden entry with the
 * lane's real writer (its text holds a `<private>` region, its
 * frontmatter has no `visibility:` field), confirms from the store that
 * it is in the `private` partition, then asks the reader as a caller
 * below local reach (no reach minted). A local caller is the control that
 * sees the hidden entry; a shared entry of the same lane is the control a
 * remote caller sees.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { openDecision } from "../../src/core/brain/decisions/open-store.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { setIntention } from "../../src/core/brain/intentions.ts";
import { createTriggers, readTriggers } from "../../src/core/brain/triggers/store.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const REGION = "<private>synthetic region body</private>";
const AGENT = "tester";
const NOW = new Date("2026-11-20T10:00:00Z");

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-paths-");
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, "Notes", "plan.md"), "# Plan\n\nShip the widget.\n", "utf8");
  return lane;
}

function server(e: LaneEnv, reach?: TransportReach): MCPServer {
  const config = { vault: e.vault, configPath: e.env.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

/** The whole answer serialized, or the refusal message. */
async function call(s: MCPServer, tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    return JSON.stringify(await s.callTool(tool, args));
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

/** The lane page at a vault-relative path is held in the store's private partition. */
function heldPrivate(e: LaneEnv, rel: string): boolean {
  return laneEntryInPrivate(e.vault, join(e.vault, rel));
}

/** Which of `marks` an answer carries. */
function carried(answer: string, marks: Readonly<Record<string, string>>): string[] {
  return Object.entries(marks)
    .filter(([, mark]) => answer.includes(mark))
    .map(([field]) => field);
}

// ----- Path 1: readers that bind no reach check -----------------------------------

describe("path 1: readers with no reach check of their own", () => {
  test("brain_entity get and list withhold a private-partition entity", async () => {
    const e = env();
    const hidden = upsertEntity(e.vault, {
      category: "people",
      name: "Zqentityhidden Person",
      agent: AGENT,
      now: NOW,
      body: `zqentitybody hidden notes\n\n${REGION}\n`,
    });
    const shared = upsertEntity(e.vault, {
      category: "people",
      name: "Zqentityshared Person",
      agent: AGENT,
      now: NOW,
      body: "zqentitysharedbody shared notes\n",
    });
    const hiddenRel = relative(e.vault, hidden.entity.path);
    expect(heldPrivate(e, hiddenRel)).toBe(true);
    expect(heldPrivate(e, relative(e.vault, shared.entity.path))).toBe(false);
    const marks = { name: "Zqentityhidden", body: "zqentitybody", path: hiddenRel };

    const local = server(e, TRANSPORT_REACH.local);
    const localList = await call(local, "brain_entity", { view: "list" });
    expect(carried(localList, marks)).toContain("name");

    const remote = server(e);
    const list = await call(remote, "brain_entity", { view: "list" });
    const hiddenQuery = "Zqentityhidden Person";
    const absentQuery = "Zqnothere Person";
    const get = await call(remote, "brain_entity", { view: "get", query: hiddenQuery });
    const absent = await call(remote, "brain_entity", { view: "get", query: absentQuery });
    // The caller's own query is no mark of the `get` answer: the answer
    // for the hidden name must be the answer for a name that is not there,
    // the query replaced.
    const getMarks = { body: marks.body, path: marks.path };
    expect(list.includes("Zqentityshared")).toBe(true);
    expect({
      list: carried(list, marks),
      get: carried(get, getMarks),
      get_like_absent:
        get.replaceAll(hiddenQuery, "<query>") === absent.replaceAll(absentQuery, "<query>"),
    }).toEqual({ list: [], get: [], get_like_absent: true });
  });

  test("brain_procedural_graph show and hints withhold a private-partition procedure", async () => {
    const e = env();
    const hiddenRel = "Brain/procedures/zqprochidden.md";
    const sharedRel = "Brain/procedures/zqprocshared.md";
    writeLaneText(
      e.vault,
      join(e.vault, hiddenRel),
      `---\ntitle: Zqproctitlehidden\n---\n\nzqprocbody steps\n\n${REGION}\n`,
    );
    writeLaneText(
      e.vault,
      join(e.vault, sharedRel),
      "---\ntitle: Zqproctitleshared\n---\n\nshared steps\n",
    );
    expect(heldPrivate(e, hiddenRel)).toBe(true);
    expect(heldPrivate(e, sharedRel)).toBe(false);
    const local = server(e, TRANSPORT_REACH.local);
    await call(local, "brain_procedural_memory", { operation: "reconcile" });
    await call(local, "brain_procedural_graph", { operation: "rebuild" });
    const marks = { slug: "zqprochidden", title: "Zqproctitlehidden", body: "zqprocbody" };
    expect(
      carried(await call(local, "brain_procedural_graph", { operation: "show" }), marks),
    ).not.toEqual([]);

    const remote = server(e);
    const show = await call(remote, "brain_procedural_graph", { operation: "show" });
    const hints = await call(remote, "brain_procedural_graph", { operation: "hints" });
    expect(show.includes("zqprocshared")).toBe(true);
    expect({ show: carried(show, marks), hints: carried(hints, marks) }).toEqual({
      show: [],
      hints: [],
    });
  });

  test("brain_write_session list and status withhold a private-partition session", async () => {
    const e = env();
    const local = server(e, TRANSPORT_REACH.local);
    const opened = JSON.parse(
      await call(local, "brain_write_session", {
        op: "open",
        kind: "artifact",
        target: "Brain/reports/zqsessiontarget.md",
        prompt: `zqsessionprompt draft it\n\n${REGION}`,
      }),
    ) as Record<string, unknown>;
    expect(JSON.stringify(opened)).not.toContain('"error"');
    // The session the open wrote, read back from the store's lane records.
    const entry = e
      .laneRecords()
      .map((r) => r.body)
      .find((body) => body["lane"] === "write-session");
    const entryName = String(entry?.["entry"] ?? "");
    // The session id is the entry name without its folder and extension.
    const id = entryName.replace(/^.*\//, "").replace(/\.json$/, "");
    expect(id).not.toBe("");
    const rel = `Brain/.sessions/${entryName}`;
    const text = readLaneText(e.vault, join(e.vault, rel));
    expect(text).not.toBeNull();
    expect(heldPrivate(e, rel)).toBe(true);
    const marks = { id, target: "zqsessiontarget", prompt: "zqsessionprompt" };
    expect(carried(await call(local, "brain_write_session", { op: "list" }), marks)).toContain(
      "target",
    );
    const localStatus = await call(local, "brain_write_session", { op: "status", session_id: id });
    expect(localStatus).not.toContain("unknown write-session");

    const remote = server(e);
    const list = await call(remote, "brain_write_session", { op: "list" });
    const status = await call(remote, "brain_write_session", { op: "status", session_id: id });
    const absent = await call(remote, "brain_write_session", {
      op: "status",
      session_id: id.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
    });
    const marksButId = { target: marks.target, prompt: marks.prompt };
    expect({
      list: carried(list, marks),
      status: carried(status, marksButId),
      // Status of the hidden id answers as for an id that is not there.
      status_like_absent: status.replace(id, "<id>").includes("unknown write-session"),
    }).toEqual({ list: [], status: [], status_like_absent: true });
    expect(absent.includes("unknown write-session")).toBe(true);
  });
});

// ----- Path 2: the trigger queue's own pages ---------------------------------------

function trigger(e: LaneEnv, key: string, reason: string, snippet: string) {
  const { created } = createTriggers(
    e.vault,
    [
      {
        kind: "contradiction",
        urgency: "medium",
        reason,
        suggestedAction: "review it",
        sourceArtifacts: ["Notes/plan.md"],
        contextSnippets: [snippet],
        cooldownKey: key,
      },
    ],
    { now: NOW },
  );
  if (created.length !== 1) throw new Error(`fixture: trigger ${key} not created`);
  return created[0]!;
}

describe("path 2: brain_trigger and the trigger's own lane page", () => {
  test("list, history and the transition verbs withhold a private-partition trigger", async () => {
    const e = env();
    const hidden = trigger(e, "contradiction:zqtrighidden", "zqtrigreason hidden", REGION);
    const shared = trigger(e, "contradiction:zqtrigshared", "zqtrigsharedreason", "plain");
    const hiddenRel = relative(e.vault, hidden.path);
    expect(heldPrivate(e, hiddenRel)).toBe(true);
    expect(heldPrivate(e, relative(e.vault, shared.path))).toBe(false);
    const marks = { id: hidden.id, key: "zqtrighidden", reason: "zqtrigreason" };

    const local = server(e, TRANSPORT_REACH.local);
    expect(carried(await call(local, "brain_trigger", { operation: "list" }), marks)).toContain(
      "id",
    );

    const remote = server(e);
    const list = await call(remote, "brain_trigger", { operation: "list" });
    expect(list.includes("zqtrigsharedreason")).toBe(true);
    const ack = await call(remote, "brain_trigger", { operation: "acknowledge", id: hidden.id });
    const absentAck = await call(remote, "brain_trigger", {
      operation: "acknowledge",
      id: "trg-absent-0000",
    });
    const after = readTriggers(e.vault, { now: NOW }).records.find((r) => r.id === hidden.id);
    // History lists terminal triggers: dismiss the hidden one at local reach first.
    await call(local, "brain_trigger", { operation: "dismiss", id: hidden.id });
    const history = await call(remote, "brain_trigger", { operation: "history" });
    expect({
      list: carried(list, marks),
      history: carried(history, marks),
      ack: carried(ack, { key: marks.key, reason: marks.reason }),
      ack_like_absent:
        ack.replace(hidden.id, "<id>") === absentAck.replace("trg-absent-0000", "<id>"),
      status_after_remote_ack: after?.status,
    }).toEqual({
      list: [],
      history: [],
      ack: [],
      ack_like_absent: true,
      status_after_remote_ack: "pending",
    });
  });
});

// ----- Path 3: a reference to a store-held decision ---------------------------------

describe("path 3: references to a store-held private-partition decision", () => {
  test("brain_decision history withholds receipts naming a private-partition decision", async () => {
    const e = env();
    const local = server(e, TRANSPORT_REACH.local);
    const recorded = JSON.parse(
      await call(local, "brain_decision", {
        action: "record",
        title: "Zqdechidden choice",
        chosen: "zqdecchosen path",
        assumption: "it holds",
        review_date: "2026-12-01",
        notes: `zqdecnotes\n\n${REGION}`,
      }),
    ) as Record<string, unknown>;
    const structured = (recorded["structuredContent"] ?? recorded) as Record<string, unknown>;
    const slug = String(structured["slug"] ?? "");
    const decisionId = String(structured["id"] ?? "");
    expect(slug).not.toBe("");
    await call(local, "brain_decision", { action: "rate", slug, rating: 4, rationale: "fine" });
    await call(local, "brain_decision", { action: "outcome", slug, outcome: "it worked" });
    const rel = `Brain/decisions/${decisionId}.md`;
    expect(heldPrivate(e, rel)).toBe(true);
    const marks = {
      slug,
      id: decisionId,
      title: "Zqdechidden",
      chosen: "zqdecchosen",
      notes: "zqdecnotes",
    };
    const localHistory = await call(local, "brain_decision", { action: "history" });

    const remote = server(e);
    const history = await call(remote, "brain_decision", { action: "history" });
    const timeline = await call(remote, "brain_analytics", { view: "timeline" });
    expect({
      local_history_names_it: carried(localHistory, marks).length > 0,
      history: carried(history, marks),
      timeline: carried(timeline, marks),
    }).toEqual({ local_history_names_it: true, history: [], timeline: [] });
  });
});

// ----- Path 4: the open-decision duplicate refusal ----------------------------------

describe("path 4: brain_decision open and a private-partition open decision", () => {
  test("a duplicate open refuses without naming the private-partition decision", async () => {
    const e = env();
    const question = "Which zqopenquestion route do we take?";
    const hidden = openDecision(e.vault, {
      title: "Zqopenhidden route",
      question,
      options: ["left", "right"],
      context: `zqopencontext\n\n${REGION}`,
      agent: AGENT,
      now: NOW,
    });
    const hiddenRel = relative(e.vault, hidden.path);
    expect(heldPrivate(e, hiddenRel)).toBe(true);
    const remote = server(e);
    const before = readLaneText(e.vault, hidden.path);
    const answer = await call(remote, "brain_decision", {
      action: "open",
      title: "Another title",
      question,
      options: ["left", "right"],
    });
    const marks = { id: hidden.id, slug: hidden.slug, path: hiddenRel, title: "Zqopenhidden" };
    expect({
      named: carried(answer, marks),
      hidden_unchanged: readLaneText(e.vault, hidden.path) === before,
    }).toEqual({ named: [], hidden_unchanged: true });
  });
});

// ----- Path 5: brain_dead_ends ------------------------------------------------------

describe("path 5: brain_dead_ends", () => {
  test("list withholds a private-partition dead end", async () => {
    const e = env();
    const local = server(e, TRANSPORT_REACH.local);
    await call(local, "brain_dead_ends", {
      operation: "record",
      approach: "zqdeadhidden approach",
      reason: "zqdeadreason failed",
      context: `zqdeadcontext\n\n${REGION}`,
    });
    await call(local, "brain_dead_ends", {
      operation: "record",
      approach: "zqdeadshared approach",
      reason: "it failed too",
    });
    const records = e.laneRecords("private").filter((r) => r.body["lane"] === "dead-ends");
    expect(records.length).toBe(1);
    const marks = { approach: "zqdeadhidden", reason: "zqdeadreason", context: "zqdeadcontext" };
    expect(carried(await call(local, "brain_dead_ends", { operation: "list" }), marks)).toContain(
      "approach",
    );
    const remote = server(e);
    const list = await call(remote, "brain_dead_ends", { operation: "list" });
    expect(list.includes("zqdeadshared")).toBe(true);
    expect(carried(list, marks)).toEqual([]);
  });
});

// ----- Deviation 1: brain_intention set on a withheld chain --------------------------

describe("brain_intention set on a withheld chain", () => {
  test("refuses with the fixed answer and changes nothing", async () => {
    const e = env();
    const hiddenScope = "zqscopehidden";
    setIntention(e.vault, { scope: hiddenScope, text: `zqintenttext\n\n${REGION}`, agent: AGENT });
    const rel = `Brain/intentions/${hiddenScope}.md`;
    expect(heldPrivate(e, rel)).toBe(true);
    const before = readLaneText(e.vault, join(e.vault, rel));
    const remote = server(e);
    const onHidden = await call(remote, "brain_intention", {
      operation: "set",
      scope: hiddenScope,
      text: "another text",
    });
    // Private-partition lane entries are withheld below local reach: a
    // create-style write onto a key the private partition holds is refused
    // with the fixed answer before anything is written, the answer carries
    // nothing of the entry, and the chain is unchanged.
    expect({
      refused: onHidden.includes('"error"'),
      fixed: onHidden.includes("this entry cannot be written at this reach"),
      named: carried(onHidden, { text: "zqintenttext" }),
      unchanged: readLaneText(e.vault, join(e.vault, rel)) === before,
    }).toEqual({ refused: true, fixed: true, named: [], unchanged: true });
  });
});
