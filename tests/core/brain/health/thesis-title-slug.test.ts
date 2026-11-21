/**
 * Thesis slugs keep letters of any script, and a thesis an older release
 * stored under its Latin-only slug stays the same record.
 *
 * Before, `slugify` dropped every non-Latin letter, so "Удалёнка повышает
 * velocity" and "Офис повышает velocity" were both `velocity` and the
 * second was refused as "thesis already exists"; a statement with no Latin
 * letter was `unnamed-<hash>`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeThesis,
  recordThesis,
  recordThesisSupport,
  showThesis,
  ThesisError,
  updateThesis,
} from "../../../../src/core/brain/health/thesis.ts";
import { slugify } from "../../../../src/core/vault.ts";

const NOW = new Date("2026-07-08T12:00:00Z");
const CYRILLIC = "Удалёнка повышает velocity";
const CJK = "远程办公提高长期效率";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-thesis-slug-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function record(statement: string) {
  return recordThesis(vault, { statement, agent: "tester", now: NOW });
}

function thesesDir(): string {
  return join(vault, "Brain", "theses");
}

/** Record `statement`, then move its page to the name an older release gave it. */
function storeUnderOldSlug(statement: string): string {
  const page = record(statement);
  const old = slugify(statement);
  renameSync(page.path, join(thesesDir(), `thesis-${old}.md`));
  return old;
}

describe("thesis slugs of non-Latin statements", () => {
  test("a Cyrillic or CJK statement keeps its words", () => {
    expect(record(CYRILLIC).slug).toBe("удалёнка-повышает-velocity");
    expect(record(CJK).slug).toBe("远程办公提高长期效率");
  });

  test("two statements that differ only in Cyrillic words can both be recorded", () => {
    record("Удалёнка повышает velocity");
    expect(record("Офис повышает velocity").slug).toBe("офис-повышает-velocity");
  });
});

describe("a thesis stored under its old Latin-only slug", () => {
  for (const statement of [CYRILLIC, CJK]) {
    test(`its statement finds it on show, update, support and close (${statement})`, () => {
      const old = storeUnderOldSlug(statement);
      expect(showThesis(vault, statement)?.slug).toBe(old);
      expect(showThesis(vault, old)?.statement).toBe(statement);
      expect(updateThesis(vault, { slug: statement, notes: "n", now: NOW }).slug).toBe(old);
      expect(recordThesisSupport(vault, statement, { now: NOW }).slug).toBe(old);
      expect(closeThesis(vault, statement).status).toBe("closed");
      expect(readdirSync(thesesDir())).toEqual([`thesis-${old}.md`]);
    });

    test(`recording the same statement again is refused (${statement})`, () => {
      const old = storeUnderOldSlug(statement);
      expect(() => record(statement)).toThrow(new RegExp(`thesis already exists: ${old}`, "u"));
      expect(readdirSync(thesesDir())).toEqual([`thesis-${old}.md`]);
    });
  }

  test("another statement that shared the old slug does not reach the page", () => {
    storeUnderOldSlug(CYRILLIC);
    expect(showThesis(vault, "Офис повышает velocity")).toBeNull();
    expect(() => closeThesis(vault, "Офис повышает velocity")).toThrow(ThesisError);
    expect(record("Офис повышает velocity").slug).toBe("офис-повышает-velocity");
  });
});

describe("a statement names only the thesis that stores it", () => {
  test("a statement whose old slug is a bare device name is recorded", () => {
    // Its old slug `con` is no name a thesis page can have, so it counts
    // as absent instead of failing the path check.
    const page = record("远程办公 CON");
    expect(page.slug).toBe("远程办公-con");
    expect(showThesis(vault, "远程办公 CON")?.slug).toBe("远程办公-con");
    expect(() => record("远程办公 CON")).toThrow("thesis already exists: 远程办公-con");
  });

  test("a statement that only keys like a stored one reaches nothing", () => {
    record("Remote work raises velocity");
    const variant = "Remote work, raises velocity";
    expect(showThesis(vault, variant)).toBeNull();
    expect(() => closeThesis(vault, variant)).toThrow("no thesis: remote-work-raises-velocity");
    expect(() => updateThesis(vault, { slug: variant, notes: "x" })).toThrow(ThesisError);
    expect(showThesis(vault, "remote-work-raises-velocity")?.status).toBe("active");
    // Its slug is held, so recording it stays refused, as before.
    expect(() => record(variant)).toThrow("thesis already exists: remote-work-raises-velocity");
  });
});
