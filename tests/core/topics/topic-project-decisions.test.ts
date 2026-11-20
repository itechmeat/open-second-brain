/**
 * The decisions of a project join the project's topic like its notes and
 * signals (spec `topics` "Automatic grouping during dream"): a decision
 * event's text is the decision's title with the option chosen, so a
 * decision whose choice alone ("one markdown page") shares no subject word
 * with the notes still groups with them when the topic is made, and is
 * routed to that topic by a later pass. Found on a linked project with a
 * non-Latin hyphenated name, which also names the topic whole.
 */
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { removeStoreSignal } from "../../../src/core/brain/signal-state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import * as storeEntities from "../../../src/core/store/read/store-entities.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import type { MCPServer } from "../../../src/mcp/server.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { topicCandidates } from "../../../src/core/topics/candidates.ts";
import { VIEW_TARGET_ENV } from "../../../src/core/view/constants.ts";
import { isToolErrorCode } from "../../../src/mcp/tool-error-codes.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import type { Fleet, Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const PROJECT = "тема-три";
const NOTE = "Тема-три release checklist";

let fleet: Fleet | null = null;
let savedView: string | undefined;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
  if (savedView === undefined) delete process.env[VIEW_TARGET_ENV];
  else process.env[VIEW_TARGET_ENV] = savedView;
});

function out(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ text?: string }> };
  return JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

interface Project {
  readonly a: Machine;
  readonly one: MCPServer;
  readonly two: MCPServer;
}

/** A switched machine with a view folder and two sessions in the linked directory `тема-три`. */
function project(): Project {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  savedView = process.env[VIEW_TARGET_ENV];
  process.env[VIEW_TARGET_ENV] = join(fleet.parent, "view");
  const dir = join(fleet.parent, "projects", PROJECT);
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  return { a, one: serverIn(a, dir), two: serverIn(a, dir) };
}

/** Five notes in two sessions, one after the other so each session keeps its order. */
async function notes(p: Project): Promise<void> {
  await callTool(p.one, "brain_note", { text: `${NOTE} covers the build steps`, agent: "one" });
  await callTool(p.one, "brain_note", { text: `${NOTE} names the owner`, agent: "one" });
  await callTool(p.two, "brain_note", { text: `${NOTE} lists the smoke checks`, agent: "two" });
  await callTool(p.two, "brain_note", { text: `${NOTE} links the dashboards`, agent: "two" });
  await callTool(p.two, "brain_note", { text: `${NOTE} ends with the sign-off`, agent: "two" });
}

async function recordPageFormat(p: Project): Promise<void> {
  await callTool(p.one, "brain_decision", {
    action: "record",
    title: "Тема-три release page format",
    chosen: "one markdown page",
    assumption: "One page is enough for a release",
    review_date: "2027-01-01",
    agent: "one",
  });
}

async function resolveCadence(p: Project): Promise<void> {
  const opened = out(
    await callTool(p.two, "brain_decision", {
      action: "open",
      title: "Тема-три release cadence",
      question: "How often is the checklist reviewed?",
      options: ["per release", "weekly"],
      agent: "two",
    }),
  );
  await callTool(p.two, "brain_decision", {
    action: "resolve",
    id: String(opened["id"]),
    choice: "per release",
    agent: "two",
  });
}

function decisionEvents(a: Machine): StoreRecord[] {
  return a
    .records()
    .filter(
      (r) =>
        r.kind === "log-event" &&
        (r.body["event_type"] === "decision-record" ||
          r.body["event_type"] === "decision-resolved"),
    );
}

function heldIds(topic: string): string[] {
  const held = runTopicAction({ action: "show", topic, held: true })["records"] as
    | Array<Record<string, unknown>>
    | undefined;
  return (held ?? []).map((h) => String(h["id"]));
}

/**
 * Drop the shared partition's blobs and quarantine the last line of the
 * shard at `path`, as a line whose blob has not arrived (no gap).
 */
function quarantineLastLine(a: Machine, path: string): void {
  const shared = partitionDir(a.storeRoot, "shared");
  rmSync(join(shared, "blobs"), { recursive: true, force: true });
  // A byte offset: the shard holds non-Latin text, so a string index is not one.
  const bytes = readFileSync(path);
  const offset = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
  addQuarantine(a.storeRoot, {
    partition: "shared",
    shard: relative(shared, path).split("\\").join("/"),
    offset,
    sha256: lineSha256At(path, offset, shared)!,
    kind: "blob-pending",
    reason: "test",
  });
}

function decisionLines(page: string): string[] {
  const at = page.indexOf("## Decisions");
  if (at < 0) return [];
  const rest = page.slice(at).split("\n").slice(2);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith("- "));
}

test("a topic made from a project's notes holds the project's decisions, each line naming its decision", async () => {
  const p = project();
  await notes(p);
  await recordPageFormat(p);
  await resolveCadence(p);
  const events = decisionEvents(p.a);
  // The recorded decision, the minted one and the resolution, all of the project.
  expect(events).toHaveLength(3);
  expect(
    events.every((e) => (e.body["body"] as Record<string, unknown>)["project"] === PROJECT),
  ).toBe(true);

  const report = dream(p.a.vault).topics?.report;
  if (report?.status !== "planned") throw new Error(`not planned: ${report?.status}`);
  expect(report.created).toHaveLength(1);
  const topic = report.created[0]!.topic;
  expect(report.created[0]!.members).toBe(8);
  // The project's name stays whole in the drafted title.
  expect(report.created[0]!.title).toBe("Тема-три release checklist");
  const held = heldIds(topic);
  for (const e of events) expect(held).toContain(e.id);

  const page = String(runTopicAction({ action: "show", topic })["page"]);
  expect(decisionLines(page).toSorted()).toEqual(
    [
      "- Тема-три release cadence: per release (resolved open decision)",
      "- Тема-три release page format: one markdown page",
    ].toSorted(),
  );
});

test("a decision recorded after the topic was made is routed to it by the next pass", async () => {
  const p = project();
  await notes(p);
  const first = dream(p.a.vault).topics?.report;
  if (first?.status !== "planned") throw new Error(`not planned: ${first?.status}`);
  expect(first.created).toHaveLength(1);
  const topic = first.created[0]!.topic;

  await recordPageFormat(p);
  await resolveCadence(p);
  const second = dream(p.a.vault).topics?.report;
  if (second?.status !== "planned") throw new Error(`not planned: ${second?.status}`);
  expect(second.created).toHaveLength(0);
  expect(second.routed.map((r) => r.record).toSorted()).toEqual(
    decisionEvents(p.a)
      .map((e) => e.id)
      .toSorted(),
  );
  expect(second.routed.every((r) => r.topic === topic)).toBe(true);
  expect(decisionLines(String(runTopicAction({ action: "show", topic })["page"]))).toHaveLength(2);
});

test("a decision of another project is never routed to this project's topic", async () => {
  const p = project();
  await notes(p);
  const first = dream(p.a.vault).topics?.report;
  if (first?.status !== "planned") throw new Error(`not planned: ${first?.status}`);
  const other = join(fleet!.parent, "projects", "проект");
  mkdirSync(other, { recursive: true });
  writeVaultPointer(other, p.a.vault);
  await callTool(serverIn(p.a, other), "brain_decision", {
    action: "record",
    title: "Тема-три release page format",
    chosen: "one markdown page",
    assumption: "One page is enough for a release",
    review_date: "2027-01-01",
    agent: "three",
  });
  const second = dream(p.a.vault).topics?.report;
  if (second?.status !== "planned") throw new Error(`not planned: ${second?.status}`);
  expect(second.routed).toHaveLength(0);
});

test("a decision event written before events carried a title reads its title from the page slug", async () => {
  const p = project();
  await recordPageFormat(p);
  const [event] = decisionEvents(p.a);
  const { title: _title, ...payload } = event!.body["body"] as Record<string, unknown>;
  const older: StoreRecord = { ...event!, body: { ...event!.body, body: payload } };
  expect(topicCandidates([older], new Set()).map((c) => c.text)).toEqual([
    "тема три release page format: one markdown page",
  ]);
  expect(topicCandidates([event!], new Set()).map((c) => c.text)).toEqual([
    "Тема-три release page format: one markdown page",
  ]);
});

test("assign refuses an id that is not a note, signal or decision event, and says why", async () => {
  const p = project();
  await notes(p);
  await recordPageFormat(p);
  const topic = String(
    runTopicAction({ action: "create", title: "By hand", scope: `project:${PROJECT}` })["topic"],
  );
  const records = p.a.records();
  const lane = records.find((r) => r.kind === "lane-entry")!;
  expect(lane).toBeDefined();
  expect(() => runTopicAction({ action: "assign", topic, record: lane.id })).toThrow(
    new RegExp(
      `record ${lane.id} is a lane-entry record: a topic holds notes, signals and decision events`,
    ),
  );
  const recorded = records.find(
    (r) => r.kind === "log-event" && r.body["event_type"] === "decision-record",
  )!;
  const unknown = "01KA0000000000000000000009";
  expect(() => runTopicAction({ action: "assign", topic, record: unknown })).toThrow(
    /no note, signal or decision event with id 01KA0000000000000000000009 on this machine/,
  );
  // brain_topic refuses the same way, as an invalid-params error naming the reason.
  const viaTool = (await p.one.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "brain_topic", arguments: { action: "assign", topic, record: lane.id } },
  })) as { error?: { message?: string; data?: { code?: unknown } } };
  expect(viaTool.error?.message).toContain(`record ${lane.id} is a lane-entry record`);
  // Its code is a registered one, so it reaches the wire with no warning.
  expect(viaTool.error?.data?.code).toBe("topic_invalid");
  expect(isToolErrorCode(viaTool.error?.data?.code)).toBe(true);
  // Nothing was written for the refused ids; a decision event is held.
  runTopicAction({ action: "assign", topic, record: recorded.id });
  expect(heldIds(topic)).toEqual([recorded.id]);
});

test("assign refuses a signal the product forgot (removed or rejected), and holds a live one", async () => {
  const p = project();
  for (const tag of ["removed", "rejected", "kept"]) {
    // eslint-disable-next-line no-await-in-loop
    await callTool(p.one, "brain_feedback", {
      topic: `release-${tag}`,
      signal: "positive",
      principle: `${NOTE} ${tag}`,
      agent: "one",
    });
  }
  const topic = String(
    runTopicAction({ action: "create", title: "By hand", scope: `project:${PROJECT}` })["topic"],
  );
  const capture = (tag: string): StoreRecord =>
    p.a
      .records()
      .find(
        (r) =>
          r.kind === "signal" &&
          (r.body["frontmatter"] as Record<string, unknown>)["principle"] === `${NOTE} ${tag}`,
      )!;
  expect(removeStoreSignal(p.a.vault, String(capture("removed").body["id"]))).toBe(true);
  appendRecord(p.a.store(), {
    partition: "shared",
    stream: "events",
    kind: "signal-state",
    agent: "t",
    body: { authority: "human", signal: capture("rejected").body["id"], state: "rejected" },
  });
  const removed = capture("removed").id;
  expect(() => runTopicAction({ action: "assign", topic, record: removed })).toThrow(
    new RegExp(`signal ${removed} was removed`),
  );
  const rejected = capture("rejected").id;
  expect(() => runTopicAction({ action: "assign", topic, record: rejected })).toThrow(
    new RegExp(`signal ${rejected} was rejected`),
  );
  runTopicAction({ action: "assign", topic, record: capture("kept").id });
  expect(heldIds(topic)).toEqual([capture("kept").id]);
});

test("assign refuses a record whose body has not arrived, and does not call it absent", async () => {
  const p = project();
  const topic = String(
    runTopicAction({ action: "create", title: "By hand", scope: `project:${PROJECT}` })["topic"],
  );
  // A note too long for one line keeps its body in a blob; the blob has not
  // arrived on this machine, and its line is quarantined (no gap).
  const { record, path } = appendRecord(p.a.store(), {
    partition: "shared",
    stream: "log",
    kind: "log-event",
    agent: "t",
    body: { event_type: "note", text: `${NOTE} ${"x".repeat(20_000)}` },
  });
  quarantineLastLine(p.a, path);
  let message = "";
  try {
    runTopicAction({ action: "assign", topic, record: record.id });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain(`record ${record.id} is on this machine, but its body has not arrived`);
  expect(message).not.toContain("no note, signal or decision event");
  expect(heldIds(topic)).toEqual([]);
});

test("a signal lifecycle record whose blob has not arrived refuses the assign and withholds the held signal", async () => {
  const p = project();
  for (const tag of ["held", "asked"]) {
    // eslint-disable-next-line no-await-in-loop
    await callTool(p.one, "brain_feedback", {
      topic: `release-${tag}`,
      signal: "positive",
      principle: `${NOTE} ${tag}`,
      agent: "one",
    });
  }
  const topic = String(
    runTopicAction({ action: "create", title: "By hand", scope: `project:${PROJECT}` })["topic"],
  );
  const capture = (tag: string): StoreRecord =>
    p.a
      .records()
      .find(
        (r) =>
          r.kind === "signal" &&
          (r.body["frontmatter"] as Record<string, unknown>)["principle"] === `${NOTE} ${tag}`,
      )!;
  runTopicAction({ action: "assign", topic, record: capture("held").id });
  // A removal of the held signal too long for one line keeps its body in a
  // blob; the blob has not arrived and its line is quarantined (no gap),
  // so the signal's id is not readable in it.
  const { path } = appendRecord(p.a.store(), {
    partition: "shared",
    stream: "events",
    kind: "signal-removed",
    agent: "t",
    body: {
      authority: "human",
      signal: capture("held").body["id"],
      reason: "x".repeat(20_000),
    },
  });
  quarantineLastLine(p.a, path);
  const asked = capture("asked").id;
  expect(() => runTopicAction({ action: "assign", topic, record: asked })).toThrow(
    new RegExp(`signal ${asked}: 1 signal lifecycle record\\(s\\) of this machine's store`),
  );
  const shown = runTopicAction({ action: "show", topic, held: true });
  const records = shown["records"] as Array<Record<string, unknown>>;
  expect(records.map((r) => [r["id"], r["withheld"], r["text"]])).toEqual([
    [capture("held").id, "incomplete-read", undefined],
  ]);
  expect(shown["records_withheld"]).toEqual([
    expect.objectContaining({ reason: "incomplete-read", count: 1 }),
  ]);
});

test("a removal whose blob arrives while the assign reads keeps one verdict from one read", async () => {
  const p = project();
  for (const tag of ["held", "asked"]) {
    // eslint-disable-next-line no-await-in-loop
    await callTool(p.one, "brain_feedback", {
      topic: `release-${tag}`,
      signal: "positive",
      principle: `${NOTE} ${tag}`,
      agent: "one",
    });
  }
  const topic = String(
    runTopicAction({ action: "create", title: "By hand", scope: `project:${PROJECT}` })["topic"],
  );
  const capture = (tag: string): StoreRecord =>
    p.a
      .records()
      .find(
        (r) =>
          r.kind === "signal" &&
          (r.body["frontmatter"] as Record<string, unknown>)["principle"] === `${NOTE} ${tag}`,
      )!;
  runTopicAction({ action: "assign", topic, record: capture("held").id });
  const { path } = appendRecord(p.a.store(), {
    partition: "shared",
    stream: "events",
    kind: "signal-removed",
    agent: "t",
    body: {
      authority: "human",
      signal: capture("held").body["id"],
      reason: "x".repeat(20_000),
    },
  });
  const blobs = join(partitionDir(p.a.storeRoot, "shared"), "blobs");
  const kept = join(p.a.storeRoot, "..", "blobs-in-transit");
  cpSync(blobs, kept, { recursive: true });
  quarantineLastLine(p.a, path);
  // The removal's blob arrives right after the entity read returns: a
  // read that folded without the removal must still say it was pending.
  const read = storeEntities.readEntitiesOf;
  let delivered = false;
  const spy = spyOn(storeEntities, "readEntitiesOf").mockImplementation((store, options) => {
    const entities = read(store, options);
    if (!delivered) {
      delivered = true;
      cpSync(kept, blobs, { recursive: true });
    }
    return entities;
  });
  const asked = capture("asked").id;
  try {
    expect(() => runTopicAction({ action: "assign", topic, record: asked })).toThrow(
      new RegExp(`signal ${asked}: 1 signal lifecycle record\\(s\\) of this machine's store`),
    );
  } finally {
    spy.mockRestore();
    rmSync(kept, { recursive: true, force: true });
  }
  expect(delivered).toBe(true);
  // Once the removal is folded, the held signal is forgotten and the
  // other one is assigned as usual.
  expect(heldIds(topic)).toEqual([]);
  runTopicAction({ action: "assign", topic, record: asked });
  expect(heldIds(topic)).toEqual([asked]);
});

test("assign refuses when the brain store cannot be read to check the record", () => {
  const p = project();
  const saved = process.env[STORE_ROOT_ENV];
  process.env[STORE_ROOT_ENV] = join(p.a.storeRoot, "..", "no-store-here");
  try {
    expect(() =>
      runTopicAction({
        action: "assign",
        topic: "01KA0000000000000000000001",
        record: "01KA0000000000000000000009",
      }),
    ).toThrow(
      /assign: the brain store could not be read to check record 01KA0000000000000000000009/,
    );
  } finally {
    if (saved === undefined) delete process.env[STORE_ROOT_ENV];
    else process.env[STORE_ROOT_ENV] = saved;
  }
});
