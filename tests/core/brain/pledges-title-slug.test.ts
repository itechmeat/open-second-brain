/**
 * Pledge slugs keep letters of any script, and a pledge an older release
 * stored under its Latin-only slug stays the same record.
 *
 * Before, `slugify` dropped every non-Latin letter: "Отправить Аде release
 * notes" was `release-notes`, and a title with no Latin letter was
 * `unnamed-<hash>`. New pages take `titleSlug`; a page already stored
 * under the old slug is found again by its title on show, fulfill and
 * remove, and posting the same promise again is the same record, not a
 * second page.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPledge,
  fulfillPledge,
  PledgeError,
  removePledge,
  showPledge,
} from "../../../src/core/brain/pledges.ts";
import { intakePledges } from "../../../src/core/brain/pledge-intake.ts";
import { slugify } from "../../../src/core/vault.ts";

const NOW = new Date("2026-06-19T12:00:00Z");
const SOURCE_REL = "notes/meeting.md";
const QUOTE = "Ada asked for a written recap";
const CYRILLIC = "Отправить Аде release notes";
const CJK = "给艾达发送迁移总结";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledge-slug-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), `${QUOTE} of the migration steps.\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function add(title: string, due = "2026-06-25") {
  return addPledge(vault, {
    title,
    due,
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: "tester",
    now: NOW,
  });
}

function pledgeDir(): string {
  return join(vault, "Brain", "pledges");
}

/** Add `title`, then move its page to the name an older release gave it. */
function storeUnderOldSlug(title: string): string {
  const page = add(title);
  const old = slugify(title);
  renameSync(page.path, join(pledgeDir(), `${old}.md`));
  return old;
}

function intakeOne(title: string) {
  return intakePledges(
    vault,
    { source: SOURCE_REL, pledges: [{ title, due: "2026-06-25", evidence: [QUOTE] }] },
    { agent: "tester", now: NOW },
  );
}

describe("pledge slugs of non-Latin titles", () => {
  test("a Cyrillic or CJK title keeps its words", () => {
    expect(add(CYRILLIC).slug).toBe("отправить-аде-release-notes");
    expect(add(CJK).slug).toBe("给艾达发送迁移总结");
  });

  test("two titles that differ only in Cyrillic words take two plain slugs", () => {
    expect(add("Отправить Аде release notes").slug).toBe("отправить-аде-release-notes");
    expect(add("Показать Грейс release notes").slug).toBe("показать-грейс-release-notes");
  });
});

describe("a pledge stored under its old Latin-only slug", () => {
  for (const title of [CYRILLIC, CJK]) {
    test(`its title finds it on show, fulfill and remove (${title})`, () => {
      const old = storeUnderOldSlug(title);
      expect(showPledge(vault, { slug: title })?.slug).toBe(old);
      expect(showPledge(vault, { slug: old })?.title).toBe(title);
      expect(fulfillPledge(vault, { slug: title, now: NOW }).slug).toBe(old);
      expect(removePledge(vault, { slug: title }).slug).toBe(old);
      expect(showPledge(vault, { slug: title })).toBeNull();
    });

    test(`adding the same promise again is refused, not a second page (${title})`, () => {
      const old = storeUnderOldSlug(title);
      expect(() => add(title)).toThrow(new RegExp(`pledge already exists: ${old}`, "u"));
      expect(readdirSync(pledgeDir())).toEqual([`${old}.md`]);
    });

    test(`posting the same promise through the intake is a duplicate (${title})`, () => {
      const old = storeUnderOldSlug(title);
      const result = intakeOne(title);
      expect(result.created).toEqual([]);
      expect(result.duplicates).toEqual([old]);
      expect(readdirSync(pledgeDir())).toEqual([`${old}.md`]);
    });
  }

  test("another title that shared the old slug does not reach the page", () => {
    storeUnderOldSlug(CYRILLIC);
    expect(showPledge(vault, { slug: "Показать Грейс release notes" })).toBeNull();
    expect(() => fulfillPledge(vault, { slug: "Показать Грейс release notes" })).toThrow(
      PledgeError,
    );
    expect(add("Показать Грейс release notes").slug).toBe("показать-грейс-release-notes");
  });

  test("the same title with another due date is a new promise under the new slug", () => {
    const old = storeUnderOldSlug(CYRILLIC);
    const second = add(CYRILLIC, "2026-07-01");
    expect(second.slug).toBe("отправить-аде-release-notes");
    expect(readdirSync(pledgeDir()).toSorted()).toEqual(
      [`${old}.md`, "отправить-аде-release-notes.md"].toSorted(),
    );
  });
});
