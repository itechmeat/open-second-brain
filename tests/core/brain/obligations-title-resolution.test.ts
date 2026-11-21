/**
 * A title names only the obligation that stores that title.
 *
 * Obligation pages were once written under the Latin-only slug and are
 * never renamed, so a lookup by title also tries the old slug. It used to
 * take any page whose stored title keyed like the value, so a title that
 * only keyed alike (other punctuation, other case) completed or removed
 * another obligation. Now a title reaches only a page that stores exactly
 * that title (up to whitespace runs and Unicode form); a slug `list`
 * issued still names its own page; and the caller's reach is asked before
 * a page is read, so a withheld old page answers like an absent one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addObligation,
  completeObligation,
  existingObligationSlug,
  listObligations,
  ObligationError,
  obligationSlotPlan,
  removeObligation,
  resolveObligationTarget,
  showObligation,
} from "../../../src/core/brain/obligations.ts";
import { slugify, titleSlug } from "../../../src/core/vault.ts";

const NOW = new Date("2026-06-18T09:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-obligation-title-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function add(title: string, extra: { readable?: (rel: string) => boolean } = {}) {
  return addObligation(vault, { title, cadence: "weekly", agent: "t", now: NOW, ...extra });
}

function storeUnderOldSlug(title: string, oldSlug = slugify(title)): void {
  const page = add(title);
  const dir = join(vault, "Brain", "obligations");
  renameSync(join(dir, `${page.slug}.md`), join(dir, `${oldSlug}.md`));
}

/** Show, done and remove agree on whether `value` names a page. */
function reaches(value: string): boolean {
  const shown = showObligation(vault, value) !== null;
  let done = true;
  try {
    completeObligation(vault, { slug: value, date: "2026-06-19" });
  } catch (err) {
    if (!(err instanceof ObligationError)) throw err;
    done = false;
  }
  expect(done).toBe(shown);
  return shown;
}

describe("a title that only keys like a stored one reaches nothing", () => {
  test("ASCII: other punctuation", () => {
    add("Water the plants");
    expect(reaches("Water, the plants")).toBe(false);
    expect(() => removeObligation(vault, "Water, the plants")).toThrow(ObligationError);
    expect(reaches("Water the plants")).toBe(true);
    expect(showObligation(vault, "water-the-plants")?.title).toBe("Water the plants");
  });

  test("Cyrillic: a page under its old slug and a title in other case", () => {
    storeUnderOldSlug("Проверка release checklist", "release-checklist");
    expect(reaches("проверка release checklist")).toBe(false);
    expect(reaches("Проверка release checklist")).toBe(true);
    expect(showObligation(vault, "release-checklist")?.title).toBe("Проверка release checklist");
  });

  test("CJK: a page under its new slug and a title with other punctuation", () => {
    const page = add("浇 花");
    expect(titleSlug("浇,花")).toBe(page.slug);
    expect(reaches("浇,花")).toBe(false);
    expect(reaches("浇 花")).toBe(true);
  });

  test("a CJK page an older release named by its hashed fallback is found by its title", () => {
    storeUnderOldSlug("浇花");
    expect(slugify("浇花")).toMatch(/^unnamed-/u);
    expect(reaches("浇花")).toBe(true);
  });
});

describe("adding next to a page that only keys alike", () => {
  test("a Cyrillic title in other case is its own obligation", () => {
    storeUnderOldSlug("Проверка release checklist", "release-checklist");
    expect(existingObligationSlug(vault, "проверка release checklist")).toBeNull();
    expect(add("проверка release checklist").slug).toBe("проверка-release-checklist");
    expect(listObligations(vault, { now: NOW })).toHaveLength(2);
  });

  test("a taken slot is still refused, whatever title it holds", () => {
    add("Water the plants");
    expect(existingObligationSlug(vault, "Water, the plants")).toBe("water-the-plants");
    expect(() => add("Water, the plants")).toThrow(/obligation already exists: water-the-plants /);
  });
});

/** The caller's reach: every page but the one an older release stored as release-checklist.md. */
function withheld(rel: string): boolean {
  return !rel.endsWith("/release-checklist.md");
}

describe("reach is asked before any page is read", () => {
  test("a withheld old page resolves like an absent one", () => {
    storeUnderOldSlug("Проверка release checklist", "release-checklist");
    const target = resolveObligationTarget(vault, "Проверка release checklist", withheld);
    expect(target.stem).toBe("проверка-release-checklist");
  });

  test("adding a title whose only page is withheld writes a new page, as over an absent one", () => {
    storeUnderOldSlug("Проверка release checklist", "release-checklist");
    expect(add("Проверка release checklist", { readable: withheld }).slug).toBe(
      "проверка-release-checklist",
    );
  });
});

describe("resolved targets stay bound to the record and reach that passed resolution", () => {
  test("show and done refuse a replacement at the resolved stem", () => {
    const original = add("Review the migration");
    const target = resolveObligationTarget(vault, original.title);
    const replacement = join(vault, "Brain", "obligations", `${original.slug}.md`);
    renameSync(replacement, `${replacement}.old`);
    add("Review, the migration");

    expect(showObligation(vault, target)).toBeNull();
    expect(() => completeObligation(vault, { slug: target, date: "2026-06-19" })).toThrow(
      ObligationError,
    );
    expect(readFileSync(replacement, "utf8")).toContain('title: "Review, the migration"');
  });

  test("remove refuses a replacement at the resolved stem", () => {
    const original = add("Review the deployment");
    const target = resolveObligationTarget(vault, original.title);
    const replacement = obligationPathFor(original.slug);
    renameSync(replacement, `${replacement}.old`);
    add("Review, the deployment");

    expect(() => removeObligation(vault, target)).toThrow(ObligationError);
    expect(readFileSync(replacement, "utf8")).toContain('title: "Review, the deployment"');
  });

  test("a target cannot be used after its page becomes withheld", () => {
    const page = add("Read the release notes");
    let canRead = true;
    const target = resolveObligationTarget(vault, page.title, () => canRead);
    expect(showObligation(vault, target)?.title).toBe(page.title);
    canRead = false;
    expect(showObligation(vault, target)).toBeNull();
  });
});

function obligationPathFor(slug: string): string {
  return join(vault, "Brain", "obligations", `${slug}.md`);
}

describe("review suffixes honor exact-title reservations", () => {
  test("the planner and create guard skip a suffix reserved under its legacy slug", () => {
    add("Отчёт!");
    const first = obligationSlotPlan(vault, "Отчёт")!;
    const reservation = add(first.slug);
    const oldSlug = slugify(first.slug);
    renameSync(reservation.path, join(vault, "Brain", "obligations", `${oldSlug}.md`));

    const next = obligationSlotPlan(vault, "Отчёт")!;
    expect(next.slug).not.toBe(first.slug);
    expect(() =>
      addObligation(vault, {
        title: "Отчёт",
        cadence: "weekly",
        agent: "t",
        now: NOW,
        slot: first.slug,
      }),
    ).toThrow(/slot is not free/u);
  });
});

describe("a page whose cadence cannot be read", () => {
  test("is left out of show and done, and still archived by its slug or its title", () => {
    const dir = join(vault, "Brain", "obligations");
    for (const title of ["Feed the cat", "Кормить кота"]) {
      const page = add(title);
      writeFileSync(
        page.path,
        readFileSync(page.path, "utf8").replace("cadence: weekly", "cadence: sometimes"),
      );
      expect(showObligation(vault, title)).toBeNull();
      expect(() => completeObligation(vault, { slug: title })).toThrow(ObligationError);
    }
    expect(removeObligation(vault, "feed-the-cat").archivePath).toBe(
      join(dir, "archive", "feed-the-cat.md"),
    );
    expect(removeObligation(vault, "Кормить кота").slug).toBe("кормить-кота");
  });
});
