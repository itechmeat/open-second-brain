/**
 * A title names only the decision that stores that title.
 *
 * Decision pages were once written under the Latin-only slug and are never
 * renamed, so a lookup by title also tries the old slug. It used to take
 * any page whose stored title keyed like the value, so a title that only
 * keyed alike (other punctuation, other case, other whitespace) reached
 * another record, and an old candidate that is a reserved device name
 * (`con`) threw inside the decision path instead of counting as absent.
 * Now a title reaches only a page that stores exactly that title (up to
 * whitespace runs and Unicode form), at its slug or at its old slug; a
 * slug `list` issued still names its own page; and the caller's reach is
 * asked before a page is read, so a withheld old page answers like an
 * absent one. The same rules hold for the review obligation a decision
 * opens and for the page resolving a parked question mints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DecisionError,
  backfillOutcome,
  compareDecisions,
  listDecisions,
  recordDecision,
  showDecision,
  updateRating,
} from "../../../../src/core/brain/decisions/record.ts";
import {
  openDecision,
  resolveOpenDecision,
} from "../../../../src/core/brain/decisions/open-store.ts";
import { listObligations } from "../../../../src/core/brain/obligations.ts";
import { slugify, titleSlug } from "../../../../src/core/vault.ts";

const NOW = new Date("2026-07-18T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-decision-title-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function record(title: string) {
  return recordDecision(vault, {
    title,
    chosen: `${title} chosen`,
    assumption: "It holds.",
    reviewDate: "2026-10-01",
    agent: "tester",
    now: NOW,
  });
}

function decisionsDir(): string {
  return join(vault, "Brain", "decisions");
}

/** Record `title`, then move its page to the name an older release gave it. */
function storeUnderOldSlug(title: string, oldSlug = slugify(title)): void {
  const res = record(title);
  renameSync(
    join(decisionsDir(), `decision-${res.record.slug}.md`),
    join(decisionsDir(), `decision-${oldSlug}.md`),
  );
  // The older release filed the decision's review obligation under the
  // Latin-only slug of its title as well.
  const obligations = join(vault, "Brain", "obligations");
  const review = `Review decision: ${title}`;
  renameSync(
    join(obligations, `${res.reviewObligationSlug}.md`),
    join(obligations, `${slugify(review)}.md`),
  );
}

/** Every lookup a title drives: show, compare, outcome and rating. */
function reaches(value: string): boolean {
  const shown = showDecision(vault, value) !== null;
  const compared = compareDecisions(vault, [value]).length > 0;
  let wrote = true;
  try {
    backfillOutcome(vault, { slug: value, outcome: "kept", agent: "tester" });
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    wrote = false;
  }
  let rated = true;
  try {
    updateRating(vault, { slug: value, rating: 3, agent: "tester" });
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    rated = false;
  }
  expect([compared, wrote, rated]).toEqual([shown, shown, shown]);
  return shown;
}

describe("a title that only keys like a stored one reaches nothing", () => {
  test("ASCII: other punctuation", () => {
    record("Ship the parser to Ada");
    expect(reaches("Ship the parser, to Ada")).toBe(false);
    expect(reaches("Ship the parser to Ada")).toBe(true);
    // The slug `list` issued still names the page.
    expect(showDecision(vault, "ship-the-parser-to-ada")?.title).toBe("Ship the parser to Ada");
  });

  test("Cyrillic: a page under its old slug and a title in other case", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    expect(reaches("проект release checklist format")).toBe(false);
    expect(reaches("Проект release checklist format")).toBe(true);
    expect(showDecision(vault, "release-checklist-format")?.title).toBe(
      "Проект release checklist format",
    );
  });

  test("CJK: a page under its new slug and a title with other punctuation", () => {
    const res = record("发布 清单");
    expect(res.record.slug).toBe("发布-清单");
    expect(titleSlug("发布,清单")).toBe(res.record.slug);
    expect(reaches("发布,清单")).toBe(false);
    expect(reaches("发布 清单")).toBe(true);
    expect(showDecision(vault, "发布-清单")?.title).toBe("发布 清单");
  });

  test("a refusal names the value's own slug, never the page it missed", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    expect(() =>
      backfillOutcome(vault, {
        slug: "проект release checklist format",
        outcome: "x",
        agent: "tester",
      }),
    ).toThrow("no decision: проект-release-checklist-format");
  });

  test("a whitespace run and a decomposed form are the same title", () => {
    record("Выбор й формата");
    expect(showDecision(vault, "Выбор  й формата")?.title).toBe("Выбор й формата");
  });
});

describe("recording next to a page that only keys alike", () => {
  test("a Cyrillic title in other case gets its own page beside the old one", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    const res = record("проект release checklist format");
    expect(res.record.slug).toBe("проект-release-checklist-format");
    expect(listDecisions(vault)).toHaveLength(2);
  });

  test("its review obligation is its own, not the old page's", () => {
    const title = "Проект release checklist format";
    storeUnderOldSlug(title, "release-checklist-format");
    const [review] = listObligations(vault);
    const dir = join(vault, "Brain", "obligations");
    renameSync(join(dir, `${review!.slug}.md`), join(dir, `${slugify(review!.title)}.md`));
    const res = record("проект release checklist format");
    expect(res.obligationCreated).toBe(true);
    expect(listObligations(vault)).toHaveLength(2);
  });
});

describe("an old slug that is a reserved device name", () => {
  // An older release slugged "CON" to `con`, which the decision path
  // refuses, so no such page can exist: the candidate counts as absent.
  test("show, outcome, rating and compare answer as for an absent page", () => {
    expect(showDecision(vault, "CON")).toBeNull();
    expect(compareDecisions(vault, ["CON", "con"])).toEqual([]);
    expect(() => backfillOutcome(vault, { slug: "CON", outcome: "x", agent: "t" })).toThrow(
      `no decision: ${titleSlug("CON")}`,
    );
    expect(() => updateRating(vault, { slug: "CON", rating: 2, agent: "t" })).toThrow(
      DecisionError,
    );
  });

  test("a decision titled CON is recorded, shown and updated by its title", () => {
    const res = record("CON");
    expect(res.record.slug).toBe(titleSlug("CON"));
    expect(showDecision(vault, "CON")?.slug).toBe(res.record.slug);
    expect(backfillOutcome(vault, { slug: "CON", outcome: "kept", agent: "t" }).outcome).toBe(
      "kept",
    );
    expect(() => record("CON")).toThrow(/decision already exists/);
  });
});

describe("reach is asked before any page is read", () => {
  test("a withheld old page answers like an absent one and is never read", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    const asked: string[] = [];
    const readable = (rel: string): boolean => {
      asked.push(rel);
      return !rel.endsWith("decision-release-checklist-format.md");
    };
    const title = "Проект release checklist format";
    expect(showDecision(vault, title, { readable })).toBeNull();
    expect(asked).toContain("Brain/decisions/decision-release-checklist-format.md");
    expect(() =>
      backfillOutcome(vault, { slug: title, outcome: "x", agent: "t", readable }),
    ).toThrow(`no decision: ${titleSlug(title)}`);
  });

  test("recording a title whose only page is withheld writes a new page, as over an absent one", () => {
    const title = "Проект release checklist format";
    storeUnderOldSlug(title, "release-checklist-format");
    const [review] = listObligations(vault);
    const dir = join(vault, "Brain", "obligations");
    renameSync(join(dir, `${review!.slug}.md`), join(dir, `${slugify(review!.title)}.md`));
    const withheld = new Set([
      "Brain/decisions/decision-release-checklist-format.md",
      "Brain/obligations/review-decision-release-checklist-format.md",
    ]);
    const readable = (rel: string): boolean => !withheld.has(rel);
    const res = recordDecision(vault, {
      title,
      chosen: "x",
      assumption: "y",
      reviewDate: "2026-10-01",
      agent: "t",
      now: NOW,
      readable,
    });
    expect(res.record.slug).toBe(titleSlug(title));
    expect(res.obligationCreated).toBe(true);
    expect(res.reviewObligationSlug).toBe(titleSlug(`Review decision: ${title}`));
  });
});

describe("resolving a parked question mints its own page", () => {
  test("an old page whose title only keys alike does not push the mint to a derived title", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    const open = openDecision(vault, {
      title: "проект release checklist format",
      question: "Which format?",
      options: ["one page", "two pages"],
      agent: "t",
      now: NOW,
    });
    const res = resolveOpenDecision(vault, open.id, { choice: "one page", now: NOW });
    expect(res.decision).toBe("decision-проект-release-checklist-format");
  });

  test("a question titled CON resolves", () => {
    const open = openDecision(vault, {
      title: "CON",
      question: "Console or not?",
      options: ["yes", "no"],
      agent: "t",
      now: NOW,
    });
    const res = resolveOpenDecision(vault, open.id, { choice: "yes", now: NOW });
    expect(res.decision).toBe(`decision-${titleSlug("CON")}`);
    expect(readdirSync(decisionsDir()).filter((n) => n.startsWith("decision-"))).toEqual([
      `decision-${titleSlug("CON")}.md`,
    ]);
  });
});
