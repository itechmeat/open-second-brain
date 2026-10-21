/**
 * The pledge extraction intake (`intakePledges`): the validate-everything-
 * before-write, idempotent path that turns an agent-posted typed pledge
 * extraction into `Brain/pledges/` pages. The kernel never calls a model:
 * it validates the whole payload (structure, source readability, quote
 * containment) before any write, anchors counterparty names server-side
 * against canonical-scope entities through the shared anchoring kernel,
 * and reports the names it could not anchor instead of storing fake edges.
 *
 * Salvage note: this suite was recovered from an interrupted spawn and then
 * extended. Beyond the plan's pinned acceptance cases it covers the empty
 * intake, a mixed batch (one duplicate beside one create), partial anchoring
 * (one anchored name beside one unanchored one), a repeated slug inside one
 * batch, the bytes of the `promised_to` frontmatter, and the fields a
 * re-anchor must preserve.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPledges,
  pledgeExists,
  PledgeError,
  showPledge,
} from "../../../src/core/brain/pledges.ts";
import {
  intakePledges,
  MAX_INTAKE_COUNTERPARTIES,
  MAX_INTAKE_COUNTERPARTY_NAME_LENGTH,
  MAX_INTAKE_PLEDGES,
  PledgeIntakeError,
  type PledgeIntakeItem,
} from "../../../src/core/brain/pledge-intake.ts";
import { archiveEntity, upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";

const NOW = new Date("2026-06-19T12:00:00Z");
const AGENT = "intake-agent";

const SOURCE_REL = "notes/team-meeting.md";
const SOURCE_TEXT = [
  "We synced on the rollout plan.",
  "",
  "- Ada asked for a written recap of the migration steps.",
  "- The storage budget review moves to next quarter.",
].join("\n");

const QUOTE = "Ada asked for a written recap of the migration steps";
const QUOTE_TWO = "The storage budget review moves to next quarter";

/** A reach predicate that refuses exactly the cited source page. */
const REFUSE_SOURCE = (rel: string) => rel !== SOURCE_REL;

function item(overrides: Partial<PledgeIntakeItem> = {}): PledgeIntakeItem {
  return {
    title: "Send Ada the migration recap",
    due: "2026-06-25",
    evidence: [QUOTE],
    ...overrides,
  };
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledge-intake-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function intake(
  pledges: ReadonlyArray<PledgeIntakeItem>,
  opts: { readable?: (rel: string) => boolean } = {},
) {
  return intakePledges(
    vault,
    { source: SOURCE_REL, pledges },
    {
      agent: AGENT,
      now: NOW,
      ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    },
  );
}

function registerAda(): string {
  return upsertEntity(vault, {
    category: "people",
    name: "Ada Lovelace",
    aliases: ["Ada"],
    agent: AGENT,
    now: NOW,
  }).entity.id;
}

/**
 * Hand-mark a stored entity page `visibility: private`, as an operator edit
 * would, and return its vault-relative path (the reach predicate's key).
 */
function markEntityPrivate(id: string): string {
  const rel = `Brain/entities/people/${id}.md`;
  const abs = join(vault, rel);
  const raw = readFileSync(abs, "utf8");
  writeFileSync(abs, raw.replace(/^---\n/u, "---\nvisibility: private\n"), "utf8");
  return rel;
}

test("a valid intake creates every pledge and reports the created slugs", () => {
  const result = intake([
    item(),
    item({ title: "Chase the budget review", evidence: [QUOTE_TWO], due: "2026-07-01" }),
  ]);
  expect(result.created).toEqual(["send-ada-the-migration-recap", "chase-the-budget-review"]);
  expect(result.duplicates).toEqual([]);
  expect(result.reanchored).toEqual([]);
  expect(result.unanchoredCounterparties).toEqual([]);
  expect(pledgeExists(vault, "send-ada-the-migration-recap")).toBe(true);
  const page = showPledge(vault, { slug: "chase-the-budget-review" });
  expect(page!.due).toBe("2026-07-01");
  expect(page!.source).toBe(SOURCE_REL);
  expect(page!.evidence).toEqual([QUOTE_TWO]);
  expect(page!.agent).toBe(AGENT);
});

test("the created page carries the promise text and evidence in its frontmatter bytes", () => {
  intake([item({ text: "Send the written migration recap to Ada." })]);
  const page = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  expect(page!.text).toBe("Send the written migration recap to Ada.");
  const raw = readFileSync(page!.path, "utf8");
  expect(raw).toContain("due: 2026-06-25");
  expect(raw).toContain(`source: ${SOURCE_REL}`);
  expect(raw).toContain("evidence: [Ada asked for a written recap of the migration steps]");
});

test("an empty intake is a no-op that reports nothing", () => {
  const result = intake([]);
  expect(result.created).toEqual([]);
  expect(result.duplicates).toEqual([]);
  expect(result.reanchored).toEqual([]);
  expect(result.unanchoredCounterparties).toEqual([]);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("one invalid item writes no page (validate before write, no partials)", () => {
  expect(() => intake([item(), item({ title: "Broken due", due: "not-a-date" })])).toThrow(
    PledgeIntakeError,
  );
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("a quote absent from the source refuses the whole intake before any write", () => {
  expect(() =>
    intake([
      item(),
      item({ title: "Fabricated quote", evidence: ["The board approved everything"] }),
    ]),
  ).toThrow(/does not occur in the source page/);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("an intake citing no evidence at all refuses before any write", () => {
  expect(() => intake([item({ evidence: [] })])).toThrow(/evidence/);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("a readable predicate that refuses the source page refuses the whole intake", () => {
  expect(() => intake([item()], { readable: REFUSE_SOURCE })).toThrow(PledgeIntakeError);
  expect(() => intake([item()], { readable: REFUSE_SOURCE })).toThrow(
    /readable at the caller's reach|withheld/,
  );
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("a withheld pledge page reads as absent and the create arm refuses the taken slug", () => {
  intake([item()]);
  const stored = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  const before = readFileSync(stored!.path, "utf8");
  // The source stays readable; only the stored pledge page is withheld, so
  // the intake must not classify the withheld page as a duplicate or a
  // re-anchor target, and must not compare or rewrite its bytes.
  const refusePledge = (rel: string) => rel !== "Brain/pledges/send-ada-the-migration-recap.md";
  expect(() => intake([item()], { readable: refusePledge })).toThrow(PledgeError);
  expect(() => intake([item()], { readable: refusePledge })).toThrow(/pledge already exists/);
  expect(readFileSync(stored!.path, "utf8")).toBe(before);
  expect(listPledges(vault, { now: NOW })).toHaveLength(1);
});

test("a re-post of the same payload is a duplicate no-op reporting the slug", () => {
  intake([item()]);
  const again = intake([item({ title: "Send Ada  the migration recap" })]);
  expect(again.created).toEqual([]);
  expect(again.duplicates).toEqual(["send-ada-the-migration-recap"]);
  expect(listPledges(vault, { now: NOW })).toHaveLength(1);
});

test("a mixed batch reports the duplicate beside the create", () => {
  intake([item()]);
  const again = intake([
    item(),
    item({ title: "Chase the budget review", evidence: [QUOTE_TWO], due: "2026-07-01" }),
  ]);
  expect(again.created).toEqual(["chase-the-budget-review"]);
  expect(again.duplicates).toEqual(["send-ada-the-migration-recap"]);
  expect(listPledges(vault, { now: NOW })).toHaveLength(2);
});

test("the same identity with a changed payload throws the named mismatch and changes nothing", () => {
  intake([item()]);
  let message = "";
  try {
    intake([item({ evidence: [QUOTE, QUOTE_TWO] })]);
  } catch (err) {
    expect(err).toBeInstanceOf(PledgeIntakeError);
    message = (err as Error).message;
  }
  expect(message).toMatch(/mismatch/);
  expect(message).toMatch(/send-ada-the-migration-recap/);
  const page = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  expect(page!.evidence).toEqual([QUOTE]);
  expect(listPledges(vault, { now: NOW })).toHaveLength(1);
});

test("a slug held by a different pledge refuses the intake before any write", () => {
  intake([item({ title: "Recap pledge" })]);
  // Same slug, different identity (different due): a create here would
  // either overwrite the page or die on the taken-slug refusal mid-batch,
  // so the whole intake is refused up front.
  expect(() =>
    intake([item({ title: "Recap pledge", due: "2026-08-01", evidence: [QUOTE_TWO] })]),
  ).toThrow(PledgeIntakeError);
  expect(showPledge(vault, { slug: "recap-pledge" })!.due).toBe("2026-06-25");
});

test("a repeated slug inside one batch refuses before any write", () => {
  expect(() => intake([item(), item()])).toThrow(/within one batch/);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("counterparty names anchor server-side to promised_to entity ids", () => {
  const adaId = registerAda();
  const result = intake([item({ counterparties: ["Ada Lovelace"] })]);
  expect(result.created).toEqual(["send-ada-the-migration-recap"]);
  expect(result.duplicates).toEqual([]);
  expect(result.unanchoredCounterparties).toEqual([]);
  const page = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  expect(page!.counterparties).toEqual([adaId]);
  const raw = readFileSync(page!.path, "utf8");
  expect(raw).toContain("promised_to:");
  expect(raw).toContain(`promised_to: [${adaId}]`);
});

test("an alias anchors the same entity as the display name", () => {
  const adaId = registerAda();
  const result = intake([item({ counterparties: ["Ada"] })]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([
    adaId,
  ]);
  expect(result.unanchoredCounterparties).toEqual([]);
});

test("an unanchored name is reported and stored nowhere", () => {
  const result = intake([item({ counterparties: ["Grace Hopper"] })]);
  expect(result.unanchoredCounterparties).toEqual(["Grace Hopper"]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([]);
});

test("a name that partly anchors stores the anchored id and reports only the rest", () => {
  const adaId = registerAda();
  const result = intake([item({ counterparties: ["Ada Lovelace", "Grace Hopper"] })]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([
    adaId,
  ]);
  expect(result.unanchoredCounterparties).toEqual(["Grace Hopper"]);
});

test("a name two canonical entities claim anchors nowhere and is reported", () => {
  const first = registerAda();
  const second = upsertEntity(vault, {
    category: "concept",
    name: "Ada Lovelace",
    agent: AGENT,
    now: NOW,
  }).entity.id;
  expect(second).not.toBe(first);
  const result = intake([item({ counterparties: ["Ada Lovelace"] })]);
  expect(result.unanchoredCounterparties).toEqual(["Ada Lovelace"]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([]);
});

test("a private entity is reported as unanchored and never stored as an edge", () => {
  const adaId = registerAda();
  const entityRel = markEntityPrivate(adaId);
  const result = intake([item({ counterparties: ["Ada Lovelace"] })], {
    readable: (rel) => rel !== entityRel,
  });
  // A record the caller cannot read is absent: same report as a name that
  // matches nothing, and no canonical id is disclosed into the pledge.
  expect(result.unanchoredCounterparties).toEqual(["Ada Lovelace"]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([]);
});

test("a private entity does not block a readable entity naming the same counterparty", () => {
  const privateId = registerAda();
  const privateRel = markEntityPrivate(privateId);
  const visibleId = upsertEntity(vault, {
    category: "concept",
    name: "Ada Lovelace",
    agent: AGENT,
    now: NOW,
  }).entity.id;
  const result = intake([item({ counterparties: ["Ada Lovelace"] })], {
    readable: (rel) => rel !== privateRel,
  });
  expect(result.unanchoredCounterparties).toEqual([]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([
    visibleId,
  ]);
});

test("re-posting after the entity registers adds the edge (re-anchor arm)", () => {
  const first = intake([item({ counterparties: ["Ada Lovelace"], text: "Send the recap." })]);
  expect(first.unanchoredCounterparties).toEqual(["Ada Lovelace"]);
  const before = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  // A frontmatter key an operator added by hand (and the visibility stamp a
  // private pledge carries), plus a note the intake has no field for: a
  // re-anchor must preserve all of them and change only `promised_to`.
  const handEdited = readFileSync(before!.path, "utf8")
    .replace(/^---\n/u, "---\nvisibility: private\noperator_note: keep me\n")
    .replace(/\n*$/u, "\n");
  writeFileSync(before!.path, `${handEdited}\n## Notes\n\nDue Friday.\n`, "utf8");
  const adaId = registerAda();
  const again = intake([item({ counterparties: ["Ada Lovelace"], text: "Send the recap." })]);
  expect(again.created).toEqual([]);
  expect(again.duplicates).toEqual([]);
  expect(again.reanchored).toEqual(["send-ada-the-migration-recap"]);
  expect(again.unanchoredCounterparties).toEqual([]);
  const after = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  expect(after!.counterparties).toEqual([adaId]);
  // The re-anchor rewrites the edge, not the pledge: every other stored
  // field survives byte-for-byte as the parse sees it.
  expect(after!.text).toBe(before!.text);
  expect(after!.notes).toBe("Due Friday.");
  expect(after!.createdAt).toBe(before!.createdAt);
  expect(after!.due).toBe(before!.due);
  expect(after!.evidence).toEqual(before!.evidence);
  expect(after!.fulfilled).toBeNull();
  const [afterMeta] = parseFrontmatter(after!.path);
  expect(afterMeta["visibility"]).toBe("private");
  expect(afterMeta["operator_note"]).toBe("keep me");
  expect(afterMeta["promised_to"]).toEqual([adaId]);
  // A third identical post is now a plain duplicate: the edge is present.
  const third = intake([item({ counterparties: ["Ada Lovelace"], text: "Send the recap." })]);
  expect(third.reanchored).toEqual([]);
  expect(third.duplicates).toEqual(["send-ada-the-migration-recap"]);
  expect(third.unanchoredCounterparties).toEqual([]);
});

test("an entity leaving canonical scope never deletes a stored edge", () => {
  const adaId = registerAda();
  intake([item({ counterparties: ["Ada Lovelace"] })]);
  const stored = showPledge(vault, { slug: "send-ada-the-migration-recap" });
  const before = readFileSync(stored!.path, "utf8");
  archiveEntity(vault, { query: "Ada Lovelace", category: "people" }, { now: NOW });
  const again = intake([item({ counterparties: ["Ada Lovelace"] })]);
  // The edge was valid when it was computed: an entity that left canonical
  // scope is reported instead of silently dropping it.
  expect(again.reanchored).toEqual([]);
  expect(again.duplicates).toEqual([]);
  expect(again.staleEdges).toEqual(["send-ada-the-migration-recap"]);
  expect(showPledge(vault, { slug: "send-ada-the-migration-recap" })!.counterparties).toEqual([
    adaId,
  ]);
  expect(readFileSync(stored!.path, "utf8")).toBe(before);
  // The same post is still a no-write report while the entity stays out of
  // scope; once it is canonical again the identical post is a duplicate.
  const third = intake([item({ counterparties: ["Ada Lovelace"] })]);
  expect(third.staleEdges).toEqual(["send-ada-the-migration-recap"]);
  expect(readFileSync(stored!.path, "utf8")).toBe(before);
  archiveEntity(vault, { query: "Ada Lovelace", category: "people" }, { now: NOW, restore: true });
  const fourth = intake([item({ counterparties: ["Ada Lovelace"] })]);
  expect(fourth.duplicates).toEqual(["send-ada-the-migration-recap"]);
  expect(fourth.staleEdges).toEqual([]);
});

test("a batch over the intake cap refuses whole before any read", () => {
  const overCap = Array.from({ length: MAX_INTAKE_PLEDGES + 1 }, (_value, index) =>
    item({ title: `Pledge number ${index}` }),
  );
  expect(() => intake(overCap)).toThrow(PledgeIntakeError);
  expect(() => intake(overCap)).toThrow(/at most/);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("more counterparties than the per-item cap refuses the intake", () => {
  const names = Array.from(
    { length: MAX_INTAKE_COUNTERPARTIES + 1 },
    (_value, index) => `Person ${index}`,
  );
  expect(() => intake([item({ counterparties: names })])).toThrow(PledgeIntakeError);
  expect(() => intake([item({ counterparties: names })])).toThrow(/counterparty/i);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});

test("a counterparty name over the title-length limit refuses the intake", () => {
  const longName = "a".repeat(MAX_INTAKE_COUNTERPARTY_NAME_LENGTH + 1);
  expect(() => intake([item({ counterparties: [longName] })])).toThrow(PledgeIntakeError);
  expect(() => intake([item({ counterparties: [longName] })])).toThrow(/counterparty/i);
  expect(listPledges(vault, { now: NOW })).toEqual([]);
});
