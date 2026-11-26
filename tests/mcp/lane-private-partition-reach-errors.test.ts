/**
 * Private-partition lane entries are withheld below local reach: the
 * answers of refused and degraded paths (change
 * `lane-private-partition-reach`, the review round). A refusal names
 * nothing the caller may not read, a gap reporter names no `private`
 * body, and a stored projection row that cannot be judged is dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { proceduralGraphPath, proceduralMemoryIndexPath } from "../../src/core/brain/paths.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { SIGNAL_KIND } from "../../src/core/store/constants.ts";
import { LANE_ENTRY_REMOVE_KIND } from "../../src/core/store/lane-records.ts";
import { moveLanePage, readLaneText, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE as WITHHELD } from "../../src/core/store/lane-reach-guard.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  call,
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";
import {
  dropPrivateEvents,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-errors-");
  return lane;
}

describe("private-partition lane entries are withheld below local reach: refusals", () => {
  test("a lifecycle change outranked by a private human removal gets the fixed answer", async () => {
    const e = env();
    const rel = "Brain/procedures/zqerrheld.md";
    writeLaneText(e.vault, join(e.vault, rel), "---\ntitle: Zqerrheld\n---\n\nsteps\n");
    const record = sharedLaneRecord(e, "procedures", "zqerrheld");
    // A human removal held in `private`, whose shared tombstone this
    // machine has not read: the shared value is stale.
    appendRecord(openStore({ root: e.env.storeRoot, device: "dev-a" }), {
      partition: "private",
      stream: "events",
      kind: LANE_ENTRY_REMOVE_KIND,
      agent: "o2b",
      body: { authority: "human", lane: record["lane"], entry: record["entry"] },
    });
    const absent = "Brain/procedures/zqerrabsent.md";
    const ask = (path: string) =>
      call(server(e), "brain_lifecycle", { action: "tombstone", path, reason: "test" });
    const onHeld = await ask(rel);
    const onAbsent = await ask(absent);
    expect({
      names_holder: onHeld.includes("human"),
      like_absent: onHeld.replaceAll(rel, "<p>") === onAbsent.replaceAll(absent, "<p>"),
    }).toEqual({ names_holder: false, like_absent: true });
  });

  test("a lifecycle refusal does not depend on an earlier private human record", async () => {
    const e = env();
    const store = openStore({ root: e.env.storeRoot, device: "dev-a" });
    const human = (partition: "shared" | "private", body: Record<string, unknown>) =>
      appendRecord(store, {
        partition,
        stream: "events",
        kind: "lane-entry",
        agent: "o2b",
        body: { ...body, authority: "human" },
      });
    const paths: string[] = [];
    for (const name of ["zqhistwith", "zqhistwithout"]) {
      const rel = `Brain/procedures/${name}.md`;
      writeLaneText(e.vault, join(e.vault, rel), `---\ntitle: ${name}\n---\n\nsteps\n`);
      const record = sharedLaneRecord(e, "procedures", name);
      if (name === "zqhistwith") human("private", record);
      human("shared", record);
      paths.push(rel);
    }
    const ask = (path: string) =>
      call(server(e), "brain_lifecycle", { action: "tombstone", path, reason: "test" });
    const [withHistory, without] = [await ask(paths[0]!), await ask(paths[1]!)];
    expect(withHistory.replaceAll(paths[0]!, "<p>").replaceAll("zqhistwith", "<n>")).toBe(
      without.replaceAll(paths[1]!, "<p>").replaceAll("zqhistwithout", "<n>"),
    );
  });

  test("a move of an absent source while the fold is incomplete gets the fixed answer", () => {
    const e = env();
    writeLaneText(
      e.vault,
      join(e.vault, "Brain", "procedures", "zqerrhidden.md"),
      `---\ntitle: Zqerrhidden\n---\n\nsteps\n\n${REGION}\n`,
    );
    dropPrivateEvents(e);
    const from = join(e.vault, "Brain", "procedures", "zqerrgone.md");
    const to = join(e.vault, "Brain", "procedures", "zqerrdest.md");
    let message = "";
    try {
      withPrivateWithheld(true, () => moveLanePage(e.vault, from, to));
    } catch (err) {
      message = (err as Error).message;
    }
    expect({ names_path: message.includes("zqerrgone"), refused: message !== "" }).toEqual({
      names_path: false,
      refused: true,
    });
  });
});

describe("private-partition lane entries are withheld below local reach: gap reporters", () => {
  test("a pending body of the private partition is not reported below local reach", async () => {
    const e = env();
    mkdirSync(join(e.vault, "Notes"), { recursive: true });
    writeFileSync(join(e.vault, "Notes", "source.md"), "# Source\n\nA source page.\n", "utf8");
    // A private memory record whose body is a blob, and the blob is gone.
    appendRecord(openStore({ root: e.env.storeRoot, device: "dev-a" }), {
      partition: "private",
      stream: "events",
      kind: SIGNAL_KIND,
      agent: "o2b",
      body: { authority: "agent", id: "sig-zqerr-pending", text: "x".repeat(300_000) },
    });
    const blobs = join(e.env.storeRoot, "private", "blobs");
    let removed = 0;
    for (const prefix of readdirSync(blobs)) {
      for (const blob of readdirSync(join(blobs, prefix))) {
        rmSync(join(blobs, prefix, blob), { force: true });
        removed += 1;
      }
    }
    expect(removed).toBeGreaterThan(0);
    const forget = (s: ReturnType<typeof server>) =>
      call(s, "brain_delete_by_source", { source_file: "Notes/source.md" });
    const pending = "a store record whose body has not arrived";
    expect({
      remote: (await forget(server(e))).includes(pending),
      local: (await forget(localServer(e))).includes(pending),
    }).toEqual({ remote: false, local: true });
  });
});

describe("private-partition lane entries are withheld below local reach: projection rows", () => {
  test("stored rows that cannot be judged are dropped, not dereferenced", async () => {
    const e = env();
    writeLaneText(
      e.vault,
      join(e.vault, "Brain", "procedures", "zqerrproc.md"),
      "---\ntitle: Zqerrproc\n---\n\nsteps\n",
    );
    const local = localServer(e);
    await call(local, "brain_procedural_memory", { operation: "reconcile" });
    // A stored index row with no `sourcePath`, and a graph with a null node.
    writeLaneText(
      e.vault,
      proceduralMemoryIndexPath(e.vault),
      JSON.stringify({ schema_version: 1, entries: [{ id: "zqerrrow", title: "Zqerrrow" }] }),
    );
    const graphPath = proceduralGraphPath(e.vault);
    mkdirSync(dirname(graphPath), { recursive: true });
    writeFileSync(
      graphPath,
      JSON.stringify({
        schema_version: 1,
        generated_at: "2026-11-20T10:00:00Z",
        nodes: [null, { id: "zqerrnode", kind: "procedure" }],
        edges: [null],
      }),
      "utf8",
    );
    const remote = server(e);
    const list = await call(remote, "brain_procedural_memory", { operation: "list" });
    const show = await call(remote, "brain_procedural_graph", { operation: "show" });
    expect({
      list_failed: list.includes('"error"') || list.includes("internal"),
      list_row: list.includes("zqerrrow"),
      show_failed: show.includes('"error"') || show.includes("internal"),
      show_node: show.includes("zqerrnode"),
    }).toEqual({ list_failed: false, list_row: false, show_failed: false, show_node: false });
  });
});

describe("private-partition lane entries are withheld below local reach: update verbs", () => {
  test("decision and write-session verbs on a withheld entry answer as for an absent one", async () => {
    const e = env();
    const local = localServer(e);
    const recorded = await callJson(local, "brain_decision", {
      action: "record",
      title: "Zqverbdecision choice",
      chosen: "zqverb path",
      assumption: "it holds",
      review_date: "2026-12-01",
      notes: `zqverbnotes\n\n${REGION}`,
    });
    const slug = String(recorded["slug"] ?? "");
    const opened = await callJson(local, "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: "Brain/reports/zqverbsession.md",
      prompt: `zqverbsession ${REGION}`,
    });
    const session = String(opened["session_id"] ?? "");
    expect({ slug: slug !== "", session: session !== "" }).toEqual({ slug: true, session: true });
    const before = e.laneRecords().length;
    const absentSlug = "zqverb-absent-choice";
    const absentSession = session.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const verbs: ReadonlyArray<readonly [string, (id: string) => Record<string, unknown>]> = [
      ["brain_decision", (id) => ({ action: "rate", slug: id, rating: 2, rationale: "no" })],
      ["brain_decision", (id) => ({ action: "outcome", slug: id, outcome: "it failed" })],
      ["brain_write_session", (id) => ({ op: "submit", session_id: id, text: "---\na: 1\n---\n" })],
      ["brain_write_session", (id) => ({ op: "approve", session_id: id })],
      ["brain_write_session", (id) => ({ op: "abandon", session_id: id })],
    ];
    const remote = server(e);
    const unlike: string[] = [];
    for (const [tool, args] of verbs) {
      const decision = tool === "brain_decision";
      const [hidden, absent] = decision ? [slug, absentSlug] : [session, absentSession];
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onHidden = (await call(remote, tool, args(hidden))).replaceAll(hidden, "<id>");
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onAbsent = (await call(remote, tool, args(absent))).replaceAll(absent, "<id>");
      if (onHidden !== onAbsent) unlike.push(`${tool} ${JSON.stringify(args("<id>"))}`);
    }
    const added = e.laneRecords().length - before;
    // The control: at local reach the same verbs find the entries.
    const localLike: string[] = [];
    for (const [tool, args] of verbs) {
      const decision = tool === "brain_decision";
      const [hidden, absent] = decision ? [slug, absentSlug] : [session, absentSession];
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onAbsent = (await call(local, tool, args(absent))).replaceAll(absent, "<id>");
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onHidden = (await call(local, tool, args(hidden))).replaceAll(hidden, "<id>");
      if (onHidden === onAbsent) localLike.push(`${tool} ${JSON.stringify(args("<id>"))}`);
    }
    expect({ unlike, records_added: added, local_like_absent: localLike }).toEqual({
      unlike: [],
      records_added: 0,
      local_like_absent: [],
    });
  });
});

describe("private-partition lane entries are withheld below local reach: write-session targets", () => {
  test("a panel session is not opened on a target held in private", async () => {
    const e = env();
    const target = "Brain/reports/zqpaneltarget.md";
    writeLaneText(e.vault, join(e.vault, target), `---\ntitle: Zqpanel\n---\n\nbody ${REGION}\n`);
    const open = (s: ReturnType<typeof server>) =>
      call(s, "brain_write_session", { op: "open", kind: "panel", topic: "zqpanel topic", target });
    const remote = await open(server(e));
    const local = await open(localServer(e));
    expect({
      remote_refused: remote.includes(WITHHELD),
      remote_names_target: remote.includes("zqpaneltarget"),
      local_opened: local.includes("session"),
    }).toEqual({ remote_refused: true, remote_names_target: false, local_opened: true });
  });

  test("a session is not opened on, nor committed to, a target held in private", async () => {
    const e = env();
    const target = "Brain/reports/zqwstarget.md";
    const remote = server(e);
    // Opened while the target is absent, then the target is written privately.
    const opened = await callJson(remote, "brain_write_session", {
      op: "open",
      kind: "artifact",
      target,
      prompt: "zqws draft it",
    });
    const session = String(opened["session_id"] ?? "");
    expect(session).not.toBe("");
    writeLaneText(
      e.vault,
      join(e.vault, target),
      `---\ntitle: Zqwstarget\n---\n\nbody ${REGION}\n`,
    );
    const before = readLaneText(e.vault, join(e.vault, target));
    const submit = await call(remote, "brain_write_session", {
      op: "submit",
      session_id: session,
      text: "---\ntitle: Replaced\n---\n\nreplaced\n",
    });
    const reopen = await call(remote, "brain_write_session", {
      op: "open",
      kind: "artifact",
      target,
      prompt: "zqws again",
    });
    expect({
      submit_refused: submit.includes(WITHHELD),
      reopen_refused: reopen.includes(WITHHELD),
      names_target: submit.includes("zqwstarget") || reopen.includes("Zqwstarget"),
      unchanged: readLaneText(e.vault, join(e.vault, target)) === before,
    }).toEqual({
      submit_refused: true,
      reopen_refused: true,
      names_target: false,
      unchanged: true,
    });
  });
});
