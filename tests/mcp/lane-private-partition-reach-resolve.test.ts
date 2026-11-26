/**
 * Private-partition lane entries are withheld below local reach: one
 * resolution of a reference to a store-held lane entry (an exact path, an
 * extensionless path, a bare id) for both reference views and both
 * write-side judges, with a vault and without one, an unresolvable
 * reference treated as private while the store cannot say what it names
 * (change `lane-private-partition-reach`, the review round).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { resolveStoreLaneRef } from "../../src/core/brain/artifact-ref-resolve.ts";
import { readerRefView } from "../../src/core/brain/artifact-ref-view.ts";
import { ownerScopeView } from "../../src/core/brain/owner-scope-view.ts";
import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { persistTension } from "../../src/core/brain/tensions.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import {
  claimSourceIsPrivate,
  logRefsNamePrivatePage,
} from "../../src/core/store/reference-privacy.ts";
import { openStore } from "../../src/core/store/store-open.ts";
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
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-20T10:00:00Z");

function env(mode: LaneMode = "store"): LaneEnv {
  lane = makeLaneEnv(mode, "osb-lane-resolve-");
  return lane;
}

/** Record a decision at local reach and rate it; `hidden` makes it private. */
async function ratedDecision(e: LaneEnv, title: string, hidden: boolean) {
  const local = localServer(e);
  const recorded = await callJson(local, "brain_decision", {
    action: "record",
    title,
    chosen: "zqreschosen path",
    assumption: "it holds",
    review_date: "2026-12-01",
    ...(hidden ? { notes: `zqresnotes\n\n${REGION}` } : {}),
  });
  const slug = String(recorded["slug"] ?? "");
  const id = String(recorded["id"] ?? "");
  expect(slug).not.toBe("");
  await call(local, "brain_decision", { action: "rate", slug, rating: 4, rationale: "fine" });
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${id}.md`))).toBe(hidden);
  return { slug, id };
}

/**
 * Copy every private decision-receipt row naming `slug` into `shared`, as
 * a writer before the fix placed it: an earlier shared copy of the row.
 */
function preFixSharedReceipts(e: LaneEnv, slug: string): number {
  const rows = readStreamRecords(e.env.storeRoot, "private", {
    stream: "ledgers",
    ledger: "decision-receipts",
  }).records.filter((r) => JSON.stringify(r.body).includes(slug));
  const store = openStore({ root: e.env.storeRoot, device: "dev-a" });
  for (const row of rows) {
    appendRecord(store, {
      partition: "shared",
      stream: "ledgers",
      ledger: "decision-receipts",
      kind: row.kind,
      agent: "o2b",
      body: row.body,
    });
  }
  return rows.length;
}

describe("private-partition lane entries are withheld below local reach: one resolution", () => {
  for (const mode of ["store", "no-vault"] as const) {
    test(`a pre-fix shared receipt is withheld, with its decision's shard unavailable too (${mode})`, async () => {
      const e = env(mode);
      const { slug, id } = await ratedDecision(e, "Zqresprefix choice", true);
      const shared = await ratedDecision(e, "Zqresopen choice", false);
      expect(preFixSharedReceipts(e, slug)).toBeGreaterThan(0);
      const marks = { slug, id, title: "Zqresprefix" };
      const history = async () => call(server(e), "brain_decision", { action: "history" });
      const healthy = await history();
      dropPrivateEvents(e);
      const degraded = await history();
      const local = await call(localServer(e), "brain_decision", { action: "history" });
      expect({
        healthy: carried(healthy, marks),
        healthy_shared_control: healthy.includes(shared.slug),
        degraded: carried(degraded, marks),
        local_names_it: carried(local, marks).length > 0,
      }).toEqual({ healthy: [], healthy_shared_control: true, degraded: [], local_names_it: true });
    });
  }

  test("the judge resolves a bare lane id with no vault", () => {
    const e = env("no-vault");
    const hidden = persistTension(
      e.vault,
      {
        aId: "zqresa",
        bId: "zqresb",
        subject: "zqressubject",
        jaccard: 0.5,
        aSign: "positive",
        bSign: "negative",
        aQuote: `zqres quote ${REGION}`,
        bQuote: "another quote",
        action: "ask_user",
      },
      { now: NOW },
    ).record;
    const bare = String(hidden.id);
    expect(bare).not.toBe("");
    expect({
      bare: logRefsNamePrivatePage(null, [bare]),
      claim: claimSourceIsPrivate(null, bare),
    }).toEqual({ bare: true, claim: true });
  });

  test("the judge and the views resolve a store-held .json path as written", async () => {
    const e = env();
    const local = localServer(e);
    const opened = await callJson(local, "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: "Brain/reports/zqresjson.md",
      prompt: `zqresjson draft ${REGION}`,
    });
    const sessionId = String(opened["session_id"] ?? "");
    expect(sessionId).not.toBe("");
    const rel = `Brain/.sessions/write/${sessionId}.json`;
    expect(laneEntryInPrivate(e.vault, join(e.vault, rel))).toBe(true);
    expect({
      judge: logRefsNamePrivatePage(e.vault, [rel]),
      claim: claimSourceIsPrivate(e.vault, rel),
      resolved: resolveStoreLaneRef(e.vault, rel),
    }).toEqual({ judge: true, claim: true, resolved: rel });
  });

  test("the claim-source judge resolves a bare lane id through the id index", () => {
    const e = env();
    const hidden = upsertEntity(e.vault, {
      category: "people",
      name: "Zqresclaim Person",
      agent: AGENT,
      now: NOW,
      body: `notes\n\n${REGION}\n`,
    }).entity;
    const open = upsertEntity(e.vault, {
      category: "people",
      name: "Zqresopen Person",
      agent: AGENT,
      now: NOW,
      body: "notes\n",
    }).entity;
    expect({
      hidden: claimSourceIsPrivate(e.vault, hidden.id),
      open: claimSourceIsPrivate(e.vault, open.id),
    }).toEqual({ hidden: true, open: false });
  });

  test("while the fold is incomplete an unresolvable lane reference is private", async () => {
    const e = env();
    const { id } = await ratedDecision(e, "Zqresgone choice", true);
    dropPrivateEvents(e);
    expect({
      bracketed: logRefsNamePrivatePage(e.vault, [`[[${id}]]`]),
      bare: logRefsNamePrivatePage(e.vault, [id]),
      extensionless: claimSourceIsPrivate(e.vault, `Brain/decisions/${id}`),
      vault_note: logRefsNamePrivatePage(e.vault, ["Notes/zqres plain note.txt"]),
    }).toEqual({ bracketed: true, bare: true, extensionless: true, vault_note: false });
  });

  test("an unresolvable reference while the fold is incomplete hides a row only below local reach", async () => {
    const e = env();
    const { id } = await ratedDecision(e, "Zqresowner choice", true);
    dropPrivateEvents(e);
    // An ordinary payload string, and the bare id of a private entry the
    // store cannot place now.
    const refs = ["zqresmanual", id];
    const owner = ownerScopeView(e.vault, AGENT);
    const remote = reachView(e.vault, TRANSPORT_REACH.remote);
    const reader = readerRefView(e.vault, () => true);
    const remoteReader = readerRefView(e.vault, () => true, true);
    expect({
      owner_local: refs.map((ref) => owner.visible(ref)),
      reader_local: refs.map((ref) => reader.visible(ref)),
      remote: refs.map((ref) => remote.visible(ref)),
      remote_reader: refs.map((ref) => remoteReader.visible(ref)),
    }).toEqual({
      owner_local: [true, true],
      reader_local: [true, true],
      remote: [false, false],
      remote_reader: [false, false],
    });
  });

  for (const order of [
    ["theses", "procedures"],
    ["procedures", "theses"],
  ] as const) {
    test(`an id held in two lanes resolves to one entry whatever the write order (${order[0]} first)`, () => {
      const e = env();
      const page = "---\ntitle: Zqrestie\n---\n\nsteps\n";
      for (const folder of order) {
        writeLaneText(e.vault, join(e.vault, "Brain", folder, "zqrestie.md"), page);
      }
      expect(resolveStoreLaneRef(e.vault, "zqrestie")).toBe("Brain/procedures/zqrestie.md");
    });
  }
});
