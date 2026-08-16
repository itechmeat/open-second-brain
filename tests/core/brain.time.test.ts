/**
 * Brain time helpers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { isoSecond, relativeAge } from "../../src/core/brain/time.ts";
import { lexCode } from "../helpers/source-lexer.ts";

const now = new Date("2026-05-29T12:00:00Z");

const SRC = resolve(import.meta.dir, "..", "..", "src");

/** Every `.ts` module under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** A `function <name>(` declaration, read off the code view only. */
function declarationSites(name: string): string[] {
  const probe = new RegExp(String.raw`\bfunction\s+${name}\s*\(`);
  return sourceFiles(SRC)
    .filter((path) => probe.test(lexCode(readFileSync(path, "utf8"))))
    .map((path) => relative(SRC, path))
    .toSorted();
}

describe("relativeAge", () => {
  test("formats recent gaps with compact labels", () => {
    expect(relativeAge("2026-05-29T11:59:30Z", now)).toBe("just now");
    expect(relativeAge("2026-05-29T11:57:00Z", now)).toBe("3m ago");
    expect(relativeAge("2026-05-29T09:00:00Z", now)).toBe("3h ago");
    expect(relativeAge("2026-05-24T12:00:00Z", now)).toBe("5d ago");
    expect(relativeAge("2026-05-08T12:00:00Z", now)).toBe("3w ago");
    expect(relativeAge("2026-02-28T12:00:00Z", now)).toBe("3mo ago");
  });

  test("does not report 0 years before the first full year", () => {
    expect(relativeAge("2025-06-03T12:00:00Z", now)).toBe("12mo ago");
    expect(relativeAge("2025-05-29T12:00:00Z", now)).toBe("1y ago");
  });

  test("omits invalid timestamps and clamps future timestamps", () => {
    expect(relativeAge("not-a-date", now)).toBe("");
    expect(relativeAge("2026-05-29T12:01:00Z", now)).toBe("just now");
  });
});

describe("isoSecond", () => {
  test("renders whole-second UTC and defaults to the current instant", () => {
    expect(isoSecond(new Date("2026-05-29T12:00:00.789Z"))).toBe("2026-05-29T12:00:00Z");
    expect(isoSecond()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  /**
   * a-label-is-not-a-boundary, U12: the secret-custody store carried its
   * own character-identical copy of this function. Two copies of a
   * timestamp format is how two timestamp formats begin - the copy took
   * no default argument, so it was already the narrower of the two - and
   * a duplicate is invisible in review at the site that has it. This
   * module owns the format, so this is where "and nowhere else" is
   * asserted; the population is read off `src/`, not remembered.
   */
  test("is the tree's only definition", () => {
    expect(declarationSites("isoSecond")).toEqual([join("core", "brain", "time.ts")]);
  });
});
