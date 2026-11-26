/**
 * Private-partition lane entries are withheld below local reach: the lane
 * fold a caller below local reach reads, the writes such a caller makes,
 * the persisted projections, the references to store-held entries and the
 * write-side judge (change `lane-private-partition-reach`, design D3 to
 * D7 and D10).
 *
 * The machine under test keeps its lane pages in the store. Every hidden
 * entry is written by its lane's real writer with a `<private>` region in
 * its text and no `visibility:` field, so the store holds it in `private`
 * by partition alone. A server with no reach minted is a caller below
 * local reach; a server at the local reach is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { openDecision } from "../../src/core/brain/decisions/open-store.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import {
  resolveMemoryTarget,
  writeMemoryPatches,
} from "../../src/core/brain/lifecycle/memory-target.ts";
import { addObligation } from "../../src/core/brain/obligations.ts";
import { createPledgePage } from "../../src/core/brain/pledges.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { foldIncomplete } from "../../src/core/store/lane-entry-store.ts";
import { laneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  moveLanePage,
  readLaneText,
  removeLanePage,
  removeLaneTree,
  writeLanePage,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { listShards } from "../../src/core/store/shard-list.ts";
import {
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
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

function env(mode: LaneMode = "store"): LaneEnv {
  lane = makeLaneEnv(mode, "osb-lane-writes-");
  return lane;
}

const SOURCE = "Notes/source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";

/** A pledge written by the pledge writer; `hidden` puts a `<private>` region in its notes. */
function pledge(e: LaneEnv, title: string, hidden: boolean) {
  return createPledgePage(e.vault, {
    title,
    due: "2026-12-01",
    source: SOURCE,
    sourceText: SOURCE_TEXT,
    evidence: ["We will ship the report."],
    visibility: [],
    agent: AGENT,
    ...(hidden ? { notes: `zqpledgenotes ${REGION}` } : {}),
  });
}

/** The fixed answer of a lane write refused below local reach. */
const WITHHELD = "this entry cannot be written at this reach";
const WITHHELD_ERROR = `LaneEntryWithheldError: ${WITHHELD}`;
const NOW = new Date("2026-11-20T10:00:00Z");

/** `<name>: <message>` of what `fn` throws, or `none`. */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** Run `fn` as a caller below local reach. */
function below<T>(fn: () => T): T {
  return withPrivateWithheld(true, fn);
}

/** An absent key of the same shape: `key` with its last character changed. */
function flip(key: string): string {
  return key.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
}

/** The `brain_pledge add` arguments of a pledge titled `title`. */
function pledgeAdd(title: string): Record<string, unknown> {
  return {
    operation: "add",
    title,
    due: "2026-12-01",
    source: SOURCE,
    evidence: ["We will ship the report."],
  };
}

/** The pledge source page in the vault, for `brain_pledge add`. */
function sourcePage(e: LaneEnv): void {
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), SOURCE_TEXT, "utf8");
}

/**
 * Make the fold of every partition incomplete: after a fold has read them,
 * the `private` partition's `events` shards are gone.
 */
function dropPrivateEvents(e: LaneEnv): void {
  laneStoreFold();
  for (const shard of listShards(join(e.env.storeRoot, "private"), { stream: "events" })) {
    rmSync(shard.path, { force: true });
  }
  expect(foldIncomplete()).toBe(true);
}

/** An obligation written by the obligation writer; `hidden` puts a `<private>` region in its notes. */
function obligation(e: LaneEnv, title: string, hidden: boolean) {
  return addObligation(e.vault, {
    title,
    cadence: "weekly",
    agent: AGENT,
    ...(hidden ? { notes: `zqobligationnotes ${REGION}` } : {}),
  });
}

describe("private-partition lane entries are withheld below local reach", () => {
  // With no vault the write-side judge counts every page a row names as
  // private, so a pledge (which cites a source page) is never shared
  // there: that mode uses the obligation lane, which cites no page.
  const lanes = [
    { mode: "store", tool: "brain_pledge", write: pledge },
    { mode: "no-vault", tool: "brain_obligation", write: obligation },
  ] as const;
  for (const { mode, tool, write } of lanes) {
    test(`a local list after a remote list sees the private-partition entry (${mode})`, async () => {
      const e = env(mode);
      const hidden = write(e, "Zqentryhidden report", true);
      const shared = write(e, "Zqentryshared report", false);
      expect(laneEntryInPrivate(e.vault, hidden.path)).toBe(true);
      expect(laneEntryInPrivate(e.vault, shared.path)).toBe(false);
      const remote = server(e);
      const local = server(e, TRANSPORT_REACH.local);
      const first = await call(remote, tool, { operation: "list" });
      const localList = await call(local, tool, { operation: "list" });
      const second = await call(remote, tool, { operation: "list" });
      expect({
        first_hidden: first.includes(hidden.slug),
        first_shared: first.includes(shared.slug),
        local_hidden: localList.includes(hidden.slug),
        second_hidden: second.includes(hidden.slug),
        second_shared: second.includes(shared.slug),
      }).toEqual({
        first_hidden: false,
        first_shared: true,
        local_hidden: true,
        second_hidden: false,
        second_shared: true,
      });
    });
  }

  test("the caller's fold and the whole fold are cached apart", () => {
    const e = env();
    pledge(e, "Zqpledgehidden report", true);
    pledge(e, "Zqpledgeshared report", false);
    const narrowA = withPrivateWithheld(true, () => laneStoreFold());
    const narrowB = withPrivateWithheld(true, () => laneStoreFold());
    const wholeA = laneStoreFold();
    const wholeB = laneStoreFold();
    expect({
      narrow_reused: narrowA === narrowB,
      whole_reused: wholeA === wholeB,
      apart: narrowA !== wholeA,
      fingerprints_apart: narrowA.fingerprint !== wholeA.fingerprint,
      narrow_private_keys: narrowA.privateKeys.size,
      whole_private_keys: wholeA.privateKeys.size,
    }).toEqual({
      narrow_reused: true,
      whole_reused: true,
      apart: true,
      fingerprints_apart: true,
      narrow_private_keys: 0,
      whole_private_keys: 1,
    });
  });

  test("recording over a private-partition decision is refused with the fixed answer", async () => {
    const e = env();
    const args = {
      action: "record",
      title: "Zqdecwrite choice",
      assumption: "it holds",
      review_date: "2026-12-01",
    };
    const recorded = await callJson(localServer(e), "brain_decision", {
      ...args,
      chosen: "zqdecchosen path",
      notes: `zqdecnotes\n\n${REGION}`,
    });
    const id = String(recorded["id"] ?? "");
    expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${id}.md`))).toBe(true);
    const before = e.laneRecords().length;
    const answer = await call(server(e), "brain_decision", { ...args, chosen: "another path" });
    expect({
      fixed: answer.includes(WITHHELD),
      named: carried(answer, { chosen: "zqdecchosen", notes: "zqdecnotes" }),
      records: e.laneRecords().length,
    }).toEqual({ fixed: true, named: [], records: before });
  });

  test("a write below local reach while the fold may miss a record is refused", async () => {
    const e = env();
    sourcePage(e);
    pledge(e, "Zqpledgehidden report", true);
    dropPrivateEvents(e);
    const before = e.laneRecords().length;
    const remote = await call(server(e), "brain_pledge", pledgeAdd("Zqpledgeremote report"));
    const afterRemote = e.laneRecords().length;
    const local = await call(localServer(e), "brain_pledge", pledgeAdd("Zqpledgelocal report"));
    expect({
      remote_fixed: remote.includes(WITHHELD),
      remote_records: afterRemote,
      local_refused: local.includes('"error"'),
      local_wrote: e.laneRecords().length > afterRemote,
    }).toEqual({
      remote_fixed: true,
      remote_records: before,
      local_refused: false,
      local_wrote: true,
    });
  });

  test("a removal below local reach while the fold may miss a record is refused", async () => {
    const e = env();
    pledge(e, "Zqpledgehidden report", true);
    const shared = pledge(e, "Zqpledgeshared report", false);
    dropPrivateEvents(e);
    const before = e.laneRecords().length;
    // The tool binds the shared rule, which withholds every store lane
    // entry below local reach while the fold is incomplete, so it answers
    // as for an absent pledge before any write; the removal primitives
    // refuse with the fixed answer whoever calls them.
    const absentSlug = `${shared.slug}-absent`;
    const remote = server(e);
    const onShared = await call(remote, "brain_pledge", { operation: "remove", slug: shared.slug });
    const onAbsent = await call(remote, "brain_pledge", { operation: "remove", slug: absentSlug });
    expect({
      tool_like_absent:
        onShared.replaceAll(shared.slug, "<slug>") === onAbsent.replaceAll(absentSlug, "<slug>"),
      page: thrown(() => below(() => removeLanePage(e.vault, shared.path))),
      tree: thrown(() => below(() => removeLaneTree(e.vault, dirname(shared.path)))),
      records: e.laneRecords().length,
    }).toEqual({
      tool_like_absent: true,
      page: WITHHELD_ERROR,
      tree: WITHHELD_ERROR,
      records: before,
    });
  });

  test("fulfil, done and resolve of a private-partition entry answer as for an absent one", async () => {
    const e = env();
    const p = pledge(e, "Zqpledgefulfil report", true);
    const o = obligation(e, "Zqobligationdone check", true);
    const d = openDecision(e.vault, {
      title: "Zqopenresolve route",
      question: "Which zqresolve route do we take?",
      options: ["left", "right"],
      context: `zqopencontext\n\n${REGION}`,
      agent: AGENT,
      now: NOW,
    });
    const paths = [p.path, o.path, d.path];
    expect(paths.map((path) => laneEntryInPrivate(e.vault, path))).toEqual([true, true, true]);
    const before = paths.map((path) => readLaneText(e.vault, path));
    const verbs = [
      {
        tool: "brain_pledge",
        key: p.slug,
        args: (k: string) => ({ operation: "fulfill", slug: k }),
      },
      {
        tool: "brain_obligation",
        key: o.slug,
        args: (k: string) => ({ operation: "done", slug: k }),
      },
      {
        tool: "brain_decision",
        key: d.id,
        args: (k: string) => ({ action: "resolve", id: k, choice: "left" }),
      },
    ];
    const remote = server(e);
    const likeAbsent: Record<string, boolean> = {};
    for (const verb of verbs) {
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onHidden = await call(remote, verb.tool, verb.args(verb.key));
      const absentKey = flip(verb.key);
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const onAbsent = await call(remote, verb.tool, verb.args(absentKey));
      likeAbsent[verb.tool] =
        onHidden.replaceAll(verb.key, "<key>") === onAbsent.replaceAll(absentKey, "<key>");
    }
    expect({
      like_absent: likeAbsent,
      unchanged: paths.map((path, i) => readLaneText(e.vault, path) === before[i]),
    }).toEqual({
      like_absent: { brain_pledge: true, brain_obligation: true, brain_decision: true },
      unchanged: [true, true, true],
    });
  });

  test("the write primitives below local reach leave private-partition entries untouched", () => {
    const e = env();
    const dir = join(e.vault, "Brain", "procedures");
    const hidden = join(dir, "zqprimhidden.md");
    const shared = join(dir, "zqprimshared.md");
    writeLaneText(e.vault, hidden, `---\ntitle: Zqprimhidden\n---\n\nsteps\n\n${REGION}\n`);
    writeLaneText(e.vault, shared, "---\ntitle: Zqprimshared\n---\n\nshared steps\n");
    expect(laneEntryInPrivate(e.vault, hidden)).toBe(true);
    const before = readLaneText(e.vault, hidden);
    const kept = () =>
      readLaneText(e.vault, hidden) === before && laneEntryInPrivate(e.vault, hidden);
    const outcome: Record<string, unknown> = {};
    outcome["remove"] = below(() => removeLanePage(e.vault, hidden));
    outcome["remove_kept"] = kept();
    outcome["move_from"] = thrown(() =>
      below(() => moveLanePage(e.vault, hidden, join(dir, "zqprimmoved.md"))),
    );
    outcome["move_from_kept"] = kept();
    outcome["move_onto"] = thrown(() => below(() => moveLanePage(e.vault, shared, hidden)));
    outcome["move_onto_kept"] = kept();
    outcome["write_onto"] = thrown(() => below(() => writeLaneText(e.vault, hidden, "replaced\n")));
    outcome["write_onto_kept"] = kept();
    // A folder with a private member is refused whole, before any removal.
    outcome["tree"] = thrown(() => below(() => removeLaneTree(e.vault, dir)));
    outcome["tree_kept"] = kept();
    outcome["tree_removed_shared"] = readLaneText(e.vault, shared) === null;
    expect(outcome).toEqual({
      remove: false,
      remove_kept: true,
      move_from: `Error: no lane page to move: ${hidden}`,
      move_from_kept: true,
      move_onto: WITHHELD_ERROR,
      move_onto_kept: true,
      write_onto: WITHHELD_ERROR,
      write_onto_kept: true,
      tree: WITHHELD_ERROR,
      tree_kept: true,
      tree_removed_shared: false,
    });
  });

  test("the write primitives below local reach leave a raised entry's stale shared value untouched", () => {
    const e = env();
    const dir = join(e.vault, "Brain", "procedures");
    const stale = join(dir, "zqprimstale.md");
    const hidden = join(dir, "zqprimdirect.md");
    writeLaneText(e.vault, stale, "---\ntitle: Zqprimstale\n---\n\nshared steps\n");
    writeLaneText(e.vault, hidden, `---\ntitle: Zqprimdirect\n---\n\nsteps\n\n${REGION}\n`);
    // The raise arrived without the tombstone of the shared value.
    const record = sharedLaneRecord(e, "procedures", "zqprimstale");
    raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
    const raised = readLaneText(e.vault, stale);
    const keptRaised = () => readLaneText(e.vault, stale) === raised;
    const page = (title: string) => () =>
      writeLanePage(e.vault, stale, { title }, "replaced\n", { overwrite: true });
    expect({
      overwrite_stale: thrown(() => below(page("Zqprimover"))),
      overwrite_stale_kept: keptRaised(),
      overwrite_hidden: thrown(() =>
        below(() =>
          writeLanePage(e.vault, hidden, { title: "Zqprimover" }, "x\n", { overwrite: true }),
        ),
      ),
      remove_stale: below(() => removeLanePage(e.vault, stale)),
      move_stale: thrown(() => below(() => moveLanePage(e.vault, stale, join(dir, "zqprimto.md")))),
      kept: keptRaised() && laneEntryInPrivate(e.vault, stale),
    }).toEqual({
      overwrite_stale: WITHHELD_ERROR,
      overwrite_stale_kept: true,
      overwrite_hidden: WITHHELD_ERROR,
      remove_stale: false,
      move_stale: `Error: no lane page to move: ${stale}`,
      kept: true,
    });
  });

  test("the memory patch writer below local reach refuses a private-partition target", () => {
    const e = env();
    const hidden = pledge(e, "Zqpatchhidden report", true);
    expect(laneEntryInPrivate(e.vault, hidden.path)).toBe(true);
    const target = resolveMemoryTarget(e.vault, relative(e.vault, hidden.path));
    const before = e.laneRecords().length;
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        writeMemoryPatches(e.vault, [{ target, patch: { status: "zqpatched" } }], () => {}),
      ),
    );
    expect({ outcome, records: e.laneRecords().length }).toEqual({
      outcome: WITHHELD_ERROR,
      records: before,
    });
  });

  test("a decision whose review obligation is withheld is refused before anything is written", async () => {
    const e = env();
    const title = "Zqdecreview choice";
    const review = obligation(e, `Review decision: ${title}`, true);
    expect(laneEntryInPrivate(e.vault, review.path)).toBe(true);
    const before = e.laneRecords().length;
    const answer = await call(server(e), "brain_decision", {
      action: "record",
      title,
      chosen: "a path",
      assumption: "it holds",
      review_date: "2026-12-01",
    });
    const decisions = e.laneRecords().filter((r) => r.body["lane"] === "decisions");
    expect({
      fixed: answer.includes(WITHHELD),
      records: e.laneRecords().length,
      decision_pages: decisions.length,
    }).toEqual({ fixed: true, records: before, decision_pages: 0 });
  });

  test("an entity write below local reach that would land in private is refused before anything is written", () => {
    const e = env();
    const write = (body: string) =>
      withPrivateWithheld(true, () =>
        upsertEntity(e.vault, {
          category: "people",
          name: "Zqentitywrite Person",
          agent: AGENT,
          now: NOW,
          body,
        }),
      );
    const before = e.laneRecords().length;
    const hidden = thrown(() => write(`zqentitybody notes\n\n${REGION}\n`));
    const afterHidden = e.laneRecords().length;
    let created = false;
    const plain = thrown(() => {
      created = write("plain notes\n").created;
    });
    expect({ hidden, records: afterHidden, plain, created }).toEqual({
      hidden: WITHHELD_ERROR,
      records: before,
      plain: "none",
      created: true,
    });
  });
});
