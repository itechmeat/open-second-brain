/**
 * The one-off pledge page family (`Brain/pledges/`): a promise made in
 * prose, with a due date, a cited source page and evidence quotes verified
 * against that source at write time. Mirrors the recurring-obligation
 * family's CRUD discipline; the acceptance cases below are the ones the
 * wave plan pins for A1.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPledge,
  fulfillPledge,
  listPledges,
  noPledgeError,
  pledgeExists,
  removePledge,
  showPledge,
  PledgeError,
} from "../../../src/core/brain/pledges.ts";

const NOW = new Date("2026-06-19T12:00:00Z");

const SOURCE_REL = "notes/team-meeting.md";
const SOURCE_TEXT = [
  "We synced on the rollout plan.",
  "",
  "- Ada asked for a written recap of the migration steps.",
  "- The storage budget review moves to next quarter.",
  "",
  "Grace will review the incident timeline before Friday.",
].join("\n");

/** Every pledge in this suite cites this source page, so containment is real. */
function cite(evidence: string[]): Parameters<typeof addPledge>[1] {
  return {
    title: "Recap pledge",
    due: "2026-06-25",
    source: SOURCE_REL,
    evidence,
    agent: "test-agent",
    now: NOW,
  };
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledges-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("addPledge creates a page under Brain/pledges and reads back round-trip", () => {
  const page = addPledge(vault, {
    title: "Send Ada the migration recap",
    due: "2026-06-25",
    source: SOURCE_REL,
    evidence: ["Ada asked for a written recap of the migration steps"],
    text: "Send the written migration recap to Ada.",
    notes: "She asked twice.",
    counterparties: ["ent-people-ada"],
    agent: "test-agent",
    now: NOW,
  });
  expect(page.slug).toBe("send-ada-the-migration-recap");
  expect(page.path.endsWith(join("Brain", "pledges", "send-ada-the-migration-recap.md"))).toBe(
    true,
  );
  const raw = readFileSync(page.path, "utf8");
  for (const key of [
    "title:",
    "created_at:",
    "due:",
    "source:",
    "evidence:",
    "promised_to:",
    "fulfilled:",
    "agent:",
  ]) {
    expect(raw).toContain(key);
  }
  expect(raw).toContain("due: 2026-06-25");
  expect(pledgeExists(vault, page.slug)).toBe(true);

  const shown = showPledge(vault, { slug: page.slug });
  expect(shown).not.toBeNull();
  expect(shown!.title).toBe("Send Ada the migration recap");
  expect(shown!.due).toBe("2026-06-25");
  expect(shown!.source).toBe(SOURCE_REL);
  expect(shown!.evidence).toEqual(["Ada asked for a written recap of the migration steps"]);
  expect(shown!.counterparties).toEqual(["ent-people-ada"]);
  expect(shown!.fulfilled).toBeNull();
  expect(shown!.text).toBe("Send the written migration recap to Ada.");
  expect(shown!.notes).toBe("She asked twice.");
  expect(shown!.agent).toBe("test-agent");
  expect(shown!.createdAt).toBe("2026-06-19T12:00:00Z");
});

test("addPledge accepts a [[wikilink]] source reference and stores the vault path", () => {
  const page = addPledge(vault, cite(["Grace will review the incident timeline"]));
  expect(page.source).toBe(SOURCE_REL);
  const linked = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Linked source pledge",
    source: `[[${SOURCE_REL}]]`,
  });
  expect(linked.source).toBe(SOURCE_REL);
});

test("addPledge refuses a taken slug with a named error", () => {
  addPledge(vault, cite(["Grace will review the incident timeline"]));
  expect(() => addPledge(vault, cite(["Grace will review the incident timeline"]))).toThrow(
    /pledge already exists: recap-pledge/,
  );
  expect(() => addPledge(vault, cite(["Grace will review the incident timeline"]))).toThrow(
    PledgeError,
  );
});

test("addPledge refuses a non-ISO due date", () => {
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "2026-13-40",
    }),
  ).toThrow(/not a valid calendar date/);
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "next Friday",
    }),
  ).toThrow(PledgeError);
});

test("addPledge refuses an empty evidence list", () => {
  expect(() => addPledge(vault, { ...cite([]) })).toThrow(/evidence/);
  expect(() => addPledge(vault, { ...cite(["   "]) })).toThrow(/evidence/);
});

test("addPledge refuses a quote absent from the source page", () => {
  expect(() => addPledge(vault, { ...cite(["The board approved unlimited headcount"]) })).toThrow(
    /does not occur in the source page/,
  );
  expect(() => addPledge(vault, { ...cite(["The board approved unlimited headcount"]) })).toThrow(
    PledgeError,
  );
});

test("addPledge refuses a source page the vault does not hold", () => {
  expect(() =>
    addPledge(vault, {
      title: "Ghost source",
      due: "2026-06-25",
      source: "notes/absent.md",
      evidence: ["anything"],
      agent: "a",
      now: NOW,
    }),
  ).toThrow(/source page not found/);
});

test("evidence containment forgives presentation, never wording", () => {
  // The shared comparator strips Markdown emphasis and line markers, so a
  // quote over a list item or emphasis passes; wording and word boundaries
  // never bend ("view" must not verify inside "review").
  const page = addPledge(vault, cite(["budget review moves to next quarter"]));
  expect(page.evidence).toEqual(["budget review moves to next quarter"]);
  expect(() => addPledge(vault, { ...cite(["view moves to next quarter"]) })).toThrow(PledgeError);
});

test("addPledge refuses an empty title", () => {
  expect(() =>
    addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "   " }),
  ).toThrow(/title must not be empty/);
});

test("fulfillPledge stamps the fulfillment date and refuses a second stamp", () => {
  addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const done = fulfillPledge(vault, { slug: "recap-pledge", date: "2026-06-20" });
  expect(done.fulfilled).toBe("2026-06-20");
  expect(showPledge(vault, { slug: "recap-pledge" })!.fulfilled).toBe("2026-06-20");
  expect(() => fulfillPledge(vault, { slug: "recap-pledge" })).toThrow(/already fulfilled/);
});

test("fulfillPledge defaults the date to the injected now and shares the no-pledge refusal", () => {
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Timeline pass",
  });
  const done = fulfillPledge(vault, { slug: "timeline-pass", now: NOW });
  expect(done.fulfilled).toBe("2026-06-19");
  expect(() => fulfillPledge(vault, { slug: "ghost" })).toThrow(noPledgeError("ghost"));
  expect(() => showPledgeForAbsentRefusal()).toThrow(/no pledge: ghost/);
});

// The no-pledge refusal is one named error shared by every slug-addressed
// operation; this helper keeps that assertion next to the error import.
function showPledgeForAbsentRefusal(): unknown {
  return removePledge(vault, { slug: "ghost" });
}

test("listPledges sorts by due then slug with overdue and daysUntilDue boundaries", () => {
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Beta yesterday",
    due: "2026-06-18",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Alpha yesterday",
    due: "2026-06-18",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Today item",
    due: "2026-06-19",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Tomorrow item",
    due: "2026-06-20",
  });

  const items = listPledges(vault, { now: NOW });
  expect(items.map((i) => i.slug)).toEqual([
    "alpha-yesterday",
    "beta-yesterday",
    "today-item",
    "tomorrow-item",
  ]);
  expect(items[0]!.overdue).toBe(true);
  expect(items[0]!.daysUntilDue).toBe(-1);
  expect(items[1]!.overdue).toBe(true);
  expect(items[2]!.overdue).toBe(false);
  expect(items[2]!.daysUntilDue).toBe(0);
  expect(items[3]!.daysUntilDue).toBe(1);
  expect(items[0]!.title).toBe("Alpha yesterday");
  expect(items[0]!.source).toBe(SOURCE_REL);
});

test("listPledges hides fulfilled pledges unless includeFulfilled", () => {
  addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "Done deal" });
  addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "Still open" });
  fulfillPledge(vault, { slug: "done-deal", date: "2026-06-19" });
  expect(listPledges(vault, { now: NOW }).map((i) => i.slug)).toEqual(["still-open"]);
  const withDone = listPledges(vault, { now: NOW, includeFulfilled: true });
  expect(withDone.map((i) => i.slug).toSorted()).toEqual(["done-deal", "still-open"]);
  expect(withDone.find((i) => i.slug === "done-deal")!.fulfilled).toBe("2026-06-19");
});

test("a hand-edited frontmatter date soft-parses instead of crashing the family", () => {
  const page = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const edited = readFileSync(page.path, "utf8").replace(`due: ${page.due}`, "due: not-a-date");
  writeFileSync(page.path, edited, "utf8");
  const shown = showPledge(vault, { slug: page.slug });
  expect(shown!.due).toBe("");
  const items = listPledges(vault, { now: NOW });
  expect(items).toHaveLength(1);
  expect(items[0]!.due).toBe("");
  expect(items[0]!.daysUntilDue).toBe(0);
  expect(items[0]!.overdue).toBe(false);
});

test("removePledge archives the page and a recreated slug archives with a collision suffix", () => {
  const first = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const removed = removePledge(vault, { slug: first.slug });
  expect(existsSync(first.path)).toBe(false);
  expect(existsSync(removed.archivePath)).toBe(true);
  expect(removed.slug).toBe(first.slug);
  expect(removed.archivePath.endsWith(join("Brain", "pledges", "archive", "recap-pledge.md"))).toBe(
    true,
  );
  expect(showPledge(vault, { slug: first.slug })).toBeNull();
  expect(pledgeExists(vault, first.slug)).toBe(false);

  const second = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  expect(second.slug).toBe(first.slug);
  const again = removePledge(vault, { slug: second.slug });
  expect(existsSync(again.archivePath)).toBe(true);
  expect(again.archivePath.endsWith(join("recap-pledge-2.md"))).toBe(true);
});

test("removePledge throws the shared no-pledge refusal for an unknown slug", () => {
  expect(() => removePledge(vault, { slug: "ghost" })).toThrow(noPledgeError("ghost"));
});

test("a withheld pledge page answers show as null and drops from list", () => {
  const page = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const rel = `Brain/pledges/${page.slug}.md`;
  expect(showPledge(vault, { slug: page.slug, readable: (r) => r !== rel })).toBeNull();
  expect(showPledge(vault, { slug: page.slug, readable: () => true })).not.toBeNull();
  expect(showPledge(vault, { slug: page.slug })).not.toBeNull();
  expect(listPledges(vault, { now: NOW, readable: (r) => r !== rel })).toEqual([]);
  const kept = listPledges(vault, { now: NOW, readable: () => true });
  expect(kept).toHaveLength(1);
  expect(kept[0]!.slug).toBe(page.slug);
});

test("listPledges answers an empty list for a vault without the pledges directory", () => {
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});
