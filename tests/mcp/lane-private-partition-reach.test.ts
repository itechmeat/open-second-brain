/**
 * A lane entry the store holds in its `private` partition is withheld from
 * a caller below local reach, even when its frontmatter reserves nothing.
 *
 * On a switched machine a lane page is a store record, and the store
 * decides its partition once, at write time: an entry whose text carries a
 * `<private>` region lands in `private` (`isPrivateEntry`), and its
 * frontmatter need not carry a `visibility:` field at all. The reader
 * below local reach asks the entry's frontmatter alone
 * (`readableAtContextReach` -> `storeLaneReadable`), so it may hand such
 * an entry to a remote caller.
 *
 * The machine under test is a switched one (`makeLaneEnv("store")`): its
 * lane pages live in the store, in both partitions. Every case names the
 * partition the store holds the entry in - read from the store itself -
 * before the reader is asked about it, so a case that fails says the
 * entry was private and was handed over anyway.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addObligation, type ObligationPage } from "../../src/core/brain/obligations.ts";
import { addPledge, type PledgePage } from "../../src/core/brain/pledges.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { formatFrontmatter, parseFrontmatterText } from "../../src/core/vault.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const HIDDEN_PLEDGE_TITLE = "Synthetic hidden pledge";
const HIDDEN_OBLIGATION_TITLE = "Synthetic hidden obligation";
const SHARED_PLEDGE_TITLE = "Synthetic shared pledge";
const SHARED_OBLIGATION_TITLE = "Synthetic shared obligation";
const RESERVED_PLEDGE_TITLE = "Synthetic reserved pledge";
const RESERVED_OBLIGATION_TITLE = "Synthetic reserved obligation";
/** The text of the `<private>` region the hidden entries carry in their notes. */
const REGION_BODY = "synthetic region body";
const SOURCE_REL = "Notes/plan.md";
const SOURCE_TEXT = "# Plan\n\nShip the widget by Friday.\n";
const EVIDENCE = ["Ship the widget by Friday."];
const AGENT = "tester";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

interface Fixture {
  readonly lane: LaneEnv;
  readonly vault: string;
  readonly configPath: string;
  /** The pledge whose notes hold a `<private>` region; no `visibility:` field. */
  readonly hiddenPledge: PledgePage;
  /** The obligation whose notes hold a `<private>` region; no `visibility:` field. */
  readonly hiddenObligation: ObligationPage;
  readonly sharedPledge: PledgePage;
  readonly sharedObligation: ObligationPage;
  /** The entries that reserve themselves in their frontmatter. */
  readonly reservedPledge: PledgePage;
  readonly reservedObligation: ObligationPage;
}

function fixture(): Fixture {
  lane = makeLaneEnv("store");
  const { vault } = lane;
  // The pledge cites a page of the user's own vault: a note outside
  // `Brain/`, which stays a file on a switched machine.
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");

  const hiddenPledge = addPledge(vault, {
    title: HIDDEN_PLEDGE_TITLE,
    due: "2026-12-01",
    source: SOURCE_REL,
    evidence: EVIDENCE,
    agent: AGENT,
    notes: `<private>${REGION_BODY}</private>`,
  });
  const hiddenObligation = addObligation(vault, {
    title: HIDDEN_OBLIGATION_TITLE,
    cadence: "weekly",
    agent: AGENT,
    notes: `<private>${REGION_BODY}</private>`,
  });
  const sharedPledge = addPledge(vault, {
    title: SHARED_PLEDGE_TITLE,
    due: "2026-12-02",
    source: SOURCE_REL,
    evidence: EVIDENCE,
    agent: AGENT,
  });
  const sharedObligation = addObligation(vault, {
    title: SHARED_OBLIGATION_TITLE,
    cadence: "weekly",
    agent: AGENT,
  });
  const reservedPledge = addPledge(vault, {
    title: RESERVED_PLEDGE_TITLE,
    due: "2026-12-03",
    source: SOURCE_REL,
    evidence: EVIDENCE,
    agent: AGENT,
  });
  const reservedObligation = addObligation(vault, {
    title: RESERVED_OBLIGATION_TITLE,
    cadence: "weekly",
    agent: AGENT,
  });
  // The reserved controls reserve themselves in their frontmatter, the
  // rule the reader below local reach applies today.
  reserve(vault, reservedPledge.path);
  reserve(vault, reservedObligation.path);
  return {
    lane,
    vault,
    configPath: lane.env.configPath,
    hiddenPledge,
    hiddenObligation,
    sharedPledge,
    sharedObligation,
    reservedPledge,
    reservedObligation,
  };
}

/** Add `visibility: private` to the frontmatter of the lane page at `path`. */
function reserve(vault: string, path: string): void {
  const text = readLaneText(vault, path);
  if (text === null) throw new Error(`fixture: no lane page at ${path}`);
  const [meta, body] = parseFrontmatterText(text);
  writeLaneText(vault, path, formatFrontmatter({ ...meta, visibility: "private" }, body));
}

/** A server at the reach given, or with no reach minted at all (a remote caller). */
function server(f: Fixture, reach?: TransportReach): MCPServer {
  const config = { vault: f.vault, configPath: f.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

/** The tool's structured answer, or the message it refused with. */
async function call(
  s: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const result = await s.callTool(tool, args);
    return (result["structuredContent"] ?? result) as Record<string, unknown>;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The pledge rows of a `brain_pledge` list answer. */
function pledgeRows(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  return (answer["pledges"] ?? []) as Array<Record<string, unknown>>;
}

/** The obligation rows of a `brain_obligation` list answer. */
function obligationRows(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  return (answer["obligations"] ?? []) as Array<Record<string, unknown>>;
}

describe("a lane entry in the store's private partition", () => {
  test("the store holds the entries whose notes carry a <private> region in private", () => {
    const f = fixture();
    // The partition the store holds each entry in, read from the store.
    expect(laneEntryInPrivate(f.vault, f.hiddenPledge.path)).toBe(true);
    expect(laneEntryInPrivate(f.vault, f.hiddenObligation.path)).toBe(true);
    // The shared entries are not in private, so the fold is whole and the
    // two verdicts above are the partition, not a fail-closed default.
    expect(laneEntryInPrivate(f.vault, f.sharedPledge.path)).toBe(false);
    expect(laneEntryInPrivate(f.vault, f.sharedObligation.path)).toBe(false);
    // The private partition holds the hidden entries' records.
    const privateEntries = f.lane
      .laneRecords("private")
      .map((r) => `${String(r.body["lane"])}/${String(r.body["entry"])}`);
    expect(privateEntries).toContain(`pledges/${f.hiddenPledge.slug}`);
    expect(privateEntries).toContain(`obligations/${f.hiddenObligation.slug}`);
    // The shared partition holds the ordinary entries' records.
    const sharedEntries = f.lane
      .laneRecords("shared")
      .map((r) => `${String(r.body["lane"])}/${String(r.body["entry"])}`);
    expect(sharedEntries).toContain(`pledges/${f.sharedPledge.slug}`);
    expect(sharedEntries).toContain(`obligations/${f.sharedObligation.slug}`);
  });

  test("the hidden pledge is absent from every answer a remote caller gets", async () => {
    const f = fixture();
    const remote = server(f);
    const listed = await call(remote, "brain_pledge", { operation: "list" });
    const rows = pledgeRows(listed);
    const shown = await call(remote, "brain_pledge", {
      operation: "show",
      slug: f.hiddenPledge.slug,
    });
    // Every way the entry could cross, in one answer: its identity (its
    // slug), its title, its body (the notes it holds), the count of the
    // rows, and the presence the show operation answers.
    expect({
      listed_slug: rows.map((row) => row["slug"]).includes(f.hiddenPledge.slug),
      listed_title: JSON.stringify(listed).includes(HIDDEN_PLEDGE_TITLE),
      listed_body: JSON.stringify(listed).includes(REGION_BODY),
      listed_count: rows.length,
      shown_present: shown["present"],
      shown_title: JSON.stringify(shown).includes(HIDDEN_PLEDGE_TITLE),
      shown_body: JSON.stringify(shown).includes(REGION_BODY),
    }).toEqual({
      listed_slug: false,
      listed_title: false,
      listed_body: false,
      listed_count: 1,
      shown_present: false,
      shown_title: false,
      shown_body: false,
    });
  });

  test("the hidden obligation is absent from every answer a remote caller gets", async () => {
    const f = fixture();
    const remote = server(f);
    const listed = await call(remote, "brain_obligation", { operation: "list" });
    const rows = obligationRows(listed);
    const shown = await call(remote, "brain_obligation", {
      operation: "show",
      slug: f.hiddenObligation.slug,
    });
    expect({
      listed_slug: rows.map((row) => row["slug"]).includes(f.hiddenObligation.slug),
      listed_title: JSON.stringify(listed).includes(HIDDEN_OBLIGATION_TITLE),
      listed_body: JSON.stringify(listed).includes(REGION_BODY),
      listed_count: rows.length,
      shown_present: shown["present"],
      shown_title: JSON.stringify(shown).includes(HIDDEN_OBLIGATION_TITLE),
      shown_body: JSON.stringify(shown).includes(REGION_BODY),
    }).toEqual({
      listed_slug: false,
      listed_title: false,
      listed_body: false,
      listed_count: 1,
      shown_present: false,
      shown_title: false,
      shown_body: false,
    });
  });

  test("the hidden entries are absent from the today brief a remote caller gets", async () => {
    const f = fixture();
    const remote = server(f);
    const brief = await call(remote, "brain_brief", { view: "today" });
    const pledges = (brief["pledges"] as { items?: Array<Record<string, unknown>> })?.items ?? [];
    const obligations =
      (brief["obligations"] as { items?: Array<Record<string, unknown>> })?.items ?? [];
    const totals = brief["totals"] as Record<string, unknown>;
    const text = JSON.stringify(brief);
    expect({
      pledge_slug: pledges.map((row) => row["slug"]).includes(f.hiddenPledge.slug),
      obligation_slug: obligations.map((row) => row["slug"]).includes(f.hiddenObligation.slug),
      pledge_title: text.includes(HIDDEN_PLEDGE_TITLE),
      obligation_title: text.includes(HIDDEN_OBLIGATION_TITLE),
      body: text.includes(REGION_BODY),
      pledges_total: totals["pledgesTotal"],
      obligations_total: totals["obligationsTotal"],
    }).toEqual({
      pledge_slug: false,
      obligation_slug: false,
      pledge_title: false,
      obligation_title: false,
      body: false,
      pledges_total: 1,
      obligations_total: 1,
    });
  });
});

describe("the controls that must pass today", () => {
  test("a local caller sees the hidden entries", async () => {
    const f = fixture();
    const local = server(f, TRANSPORT_REACH.local);
    const listed = await call(local, "brain_pledge", { operation: "list" });
    expect(pledgeRows(listed).map((row) => row["slug"])).toContain(f.hiddenPledge.slug);
    expect(JSON.stringify(listed)).toContain(HIDDEN_PLEDGE_TITLE);
    const obligations = await call(local, "brain_obligation", { operation: "list" });
    expect(obligationRows(obligations).map((row) => row["slug"])).toContain(
      f.hiddenObligation.slug,
    );
    expect(JSON.stringify(obligations)).toContain(HIDDEN_OBLIGATION_TITLE);
    const shown = await call(local, "brain_pledge", {
      operation: "show",
      slug: f.hiddenPledge.slug,
    });
    expect(shown["present"]).toBe(true);
  });

  test("a remote caller sees an ordinary shared entry", async () => {
    const f = fixture();
    const remote = server(f);
    const listed = await call(remote, "brain_pledge", { operation: "list" });
    expect(pledgeRows(listed).map((row) => row["slug"])).toContain(f.sharedPledge.slug);
    expect(JSON.stringify(listed)).toContain(SHARED_PLEDGE_TITLE);
    const shown = await call(remote, "brain_pledge", {
      operation: "show",
      slug: f.sharedPledge.slug,
    });
    expect(shown["present"]).toBe(true);
    const obligations = await call(remote, "brain_obligation", { operation: "list" });
    expect(obligationRows(obligations).map((row) => row["slug"])).toContain(
      f.sharedObligation.slug,
    );
    expect(JSON.stringify(obligations)).toContain(SHARED_OBLIGATION_TITLE);
  });

  test("a remote caller does not see an entry that reserves itself in its frontmatter", async () => {
    const f = fixture();
    // The reserved entries carry `visibility: private` in their frontmatter.
    const remote = server(f);
    const listed = await call(remote, "brain_pledge", { operation: "list" });
    expect(pledgeRows(listed).map((row) => row["slug"])).not.toContain(f.reservedPledge.slug);
    expect(JSON.stringify(listed)).not.toContain(RESERVED_PLEDGE_TITLE);
    const obligations = await call(remote, "brain_obligation", { operation: "list" });
    expect(obligationRows(obligations).map((row) => row["slug"])).not.toContain(
      f.reservedObligation.slug,
    );
    expect(JSON.stringify(obligations)).not.toContain(RESERVED_OBLIGATION_TITLE);
    // The operator's own shell still sees them.
    const local = server(f, TRANSPORT_REACH.local);
    const localPledges = await call(local, "brain_pledge", { operation: "list" });
    expect(pledgeRows(localPledges).map((row) => row["slug"])).toContain(f.reservedPledge.slug);
    const localObligations = await call(local, "brain_obligation", { operation: "list" });
    expect(obligationRows(localObligations).map((row) => row["slug"])).toContain(
      f.reservedObligation.slug,
    );
  });
});
