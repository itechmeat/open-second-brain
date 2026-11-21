/**
 * What a writer does when the slot it would take is not plainly free: a
 * page a caller may not read, a record whose exact title is the slot, a
 * review obligation the slot belongs to. The rules:
 *
 * 1. Nothing withheld from the caller changes the answer it gets.
 * 2. A collision that is not the same record is refused before anything
 *    is written, never answered as an existing record.
 * 3. The same record posted again is that record, never refused.
 * 4. No slot is written that a listed slug and an exact title would then
 *    name twice.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  openDecision,
  resolveOpenDecision,
} from "../../../../src/core/brain/decisions/open-store.ts";
import {
  ensureReviewObligation,
  recordDecision,
} from "../../../../src/core/brain/decisions/record.ts";
import {
  addObligation,
  resolveObligationTarget,
  showObligation,
} from "../../../../src/core/brain/obligations.ts";
import { intakePledges } from "../../../../src/core/brain/pledge-intake.ts";
import { addPledge, pledgeSlugCandidates, showPledge } from "../../../../src/core/brain/pledges.ts";
import { slugify, titleSlug } from "../../../../src/core/vault.ts";
import { dropVault, makeVault, NOW } from "./lanes.ts";

const SOURCE = "notes/meeting.md";
const QUOTE = "Ada asked for a written recap";

let vault: string;

beforeEach(() => {
  vault = makeVault();
});

afterEach(() => {
  dropVault(vault);
});

function pledge(title: string, due: string): string {
  return addPledge(vault, { title, due, source: SOURCE, evidence: [QUOTE], agent: "t", now: NOW })
    .slug;
}

function movePledge(from: string, to: string): void {
  const dir = join(vault, "Brain", "pledges");
  renameSync(join(dir, `${from}.md`), join(dir, `${to}.md`));
}

describe("decisions: resolving a parked question", () => {
  test("a withheld page at the title's slug is never read for the record's reference", () => {
    const open = openDecision(vault, {
      title: "Pick DB",
      question: "Which database?",
      options: ["sqlite", "postgres"],
      agent: "t",
      now: NOW,
    });
    // A page at the slug that cites the record, as a crashed attempt's own would.
    recordDecision(vault, {
      title: "Pick DB",
      chosen: "sqlite",
      assumption: "It holds.",
      reviewDate: "2026-10-01",
      agent: "t",
      now: NOW,
      notes: `From [[${open.id}]].`,
    });
    const withheld = "Brain/decisions/decision-pick-db.md";
    const res = resolveOpenDecision(vault, open.id, {
      choice: "sqlite",
      now: NOW,
      readable: (rel) => rel !== withheld,
    });
    // Treated as another record's page: the mint moves to a derived title.
    expect(res.decision).not.toBe("decision-pick-db");
  });
});

function decide(title: string) {
  return recordDecision(vault, {
    title,
    chosen: "one page",
    assumption: "It holds.",
    reviewDate: "2026-10-01",
    agent: "t",
    now: NOW,
  });
}

/** The obligation a title reaches, by its stored title (null for none). */
function obligationTitle(value: string): string | null {
  try {
    return showObligation(vault, resolveObligationTarget(vault, value))?.title ?? null;
  } catch {
    return null;
  }
}

describe("decisions: the review obligation", () => {
  test("a slot another obligation claims takes a distinct slot, never the holder", () => {
    const claimer = "review-decision-项目-release";
    const page = addObligation(vault, { title: claimer, cadence: "weekly", agent: "t", now: NOW });
    const dir = join(vault, "Brain", "obligations");
    renameSync(join(dir, `${page.slug}.md`), join(dir, `${slugify(claimer)}.md`));
    const res = decide("项目 release");
    const slot = titleSlug("Review decision: 项目 release");
    expect(res.obligationCreated).toBe(true);
    expect(res.reviewObligationSlug).toMatch(new RegExp(`^${slot}-[0-9a-f]{6}$`, "u"));
    expect(obligationTitle("Review decision: 项目 release")).toBe("Review decision: 项目 release");
    expect(obligationTitle(res.reviewObligationSlug)).toBe("Review decision: 项目 release");
    expect(obligationTitle(claimer)).toBe(claimer);
  });

  test("an orphan obligation of a keying-alike title never blocks the record and is never reused", () => {
    // An older release recorded "Merge queue v2"; its decision page is gone.
    const orphan = addObligation(vault, {
      title: "Review decision: Merge queue v2",
      cadence: "weekly",
      agent: "t",
      now: NOW,
    });
    const res = decide("merge queue v2");
    expect(res.obligationCreated).toBe(true);
    expect(res.reviewObligationSlug).not.toBe(orphan.slug);
    expect(res.reviewObligationSlug.startsWith(`${orphan.slug}-`)).toBe(true);
    expect(obligationTitle("Review decision: merge queue v2")).toBe(
      "Review decision: merge queue v2",
    );
    expect(obligationTitle("Review decision: Merge queue v2")).toBe(
      "Review decision: Merge queue v2",
    );
    expect(obligationTitle(orphan.slug)).toBe("Review decision: Merge queue v2");
  });

  test("the obligation that stores exactly the review title is reused", () => {
    const left = addObligation(vault, {
      title: "Review decision: Merge queue v2",
      cadence: "weekly",
      agent: "t",
      now: NOW,
    });
    const res = decide("Merge queue v2");
    expect(res.obligationCreated).toBe(false);
    expect(res.reviewObligationSlug).toBe(left.slug);
  });

  test("an obligation that stores the review title but cannot be read is never reused", () => {
    const left = addObligation(vault, {
      title: "Review decision: Merge queue v2",
      cadence: "weekly",
      agent: "t",
      now: NOW,
    });
    // Its cadence is damaged by hand or by a peer: list, show and done
    // leave it out, so a review filed against it would never come due.
    writeFileSync(
      left.path,
      readFileSync(left.path, "utf8").replace(/^cadence: .*$/mu, "cadence: fortnightly-ish"),
    );
    expect(showObligation(vault, left.slug)).toBeNull();
    expect(() => decide("Merge queue v2")).toThrow("cannot be read");
    // Refused before anything is written: no decision page, no second review.
    expect(existsSync(join(vault, "Brain", "decisions", "decision-merge-queue-v2.md"))).toBe(false);
    expect(
      readdirSync(join(vault, "Brain", "obligations")).filter((n) => n.endsWith(".md")),
    ).toEqual([`${left.slug}.md`]);
  });

  test("a second record of the same review title in a distinct slot reuses that slot", () => {
    addObligation(vault, {
      title: "Review decision: Merge queue v2",
      cadence: "weekly",
      agent: "t",
      now: NOW,
    });
    const first = ensureReviewObligation(vault, {
      title: "merge queue v2",
      reviewDate: "2026-10-01",
      agent: "t",
      now: NOW,
    });
    const again = ensureReviewObligation(vault, {
      title: "merge queue v2",
      reviewDate: "2026-10-01",
      agent: "t",
      now: NOW,
    });
    expect(again).toEqual({ slug: first.slug, created: false });
  });
});

describe("pledges: intake of a promise stored under its old slug", () => {
  test("is a duplicate even while a keying-alike pledge holds the new slug", () => {
    // Another device wrote the keying-alike pledge at the new slug while
    // this one still filed the first under its old hashed slug.
    const first = "远程办公提高长期效率";
    movePledge(pledge(`${first}!`, "2026-08-10"), "parked");
    movePledge(pledge(first, "2026-08-10"), slugify(first));
    movePledge("parked", first);
    const res = intakePledges(
      vault,
      { source: SOURCE, pledges: [{ title: first, due: "2026-08-10", evidence: [QUOTE] }] },
      { agent: "t", now: NOW },
    );
    expect(res.created).toEqual([]);
    expect(res.duplicates).toEqual([slugify(first)]);
  });
});

describe("pledges: an identity-suffixed slot that is another pledge's exact title", () => {
  test("is not written", () => {
    const title = "Проект release!";
    const due = "2026-08-12";
    pledge("Проект release", "2026-08-10");
    const suffixed = pledgeSlugCandidates(title, due, SOURCE)[1]!;
    const older = pledge(suffixed, "2026-08-11");
    movePledge(older, slugify(suffixed));
    let written: string | null = null;
    try {
      written = pledge(title, due);
    } catch {
      written = null;
    }
    expect(written).not.toBe(suffixed);
    expect(showPledge(vault, { slug: suffixed })?.title).toBe(suffixed);
    expect(readdirSync(join(vault, "Brain", "pledges")).includes(`${suffixed}.md`)).toBe(false);
  });
});
