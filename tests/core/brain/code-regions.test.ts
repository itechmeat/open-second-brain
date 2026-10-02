/**
 * The code regions every link and mention reader masks out
 * (`codeRegions` / `maskCodeRegions` in src/core/brain/wikilink.ts).
 *
 * The scanner replaced a regular expression with the same meaning. The
 * expression is kept here as the reference, and the scanner must agree with
 * it on every input; it must also stay linear where the expression did not
 * (unclosed fence runs of strictly decreasing length).
 */

import { describe, expect, test } from "bun:test";

import { codeRegions, maskCodeRegions } from "../../../src/core/brain/wikilink.ts";
import { normalizeWikilinks } from "../../../src/core/brain/link-graph/format-wikilink.ts";
import { extractWikilinks } from "../../../src/core/vault.ts";
import { LINEAR_CEILING_MS } from "../../helpers/linear-time.ts";

/**
 * The reference the scanner is held to: the former definition, with an
 * inline span that closes only on a backtick run of its own length (the
 * CommonMark rule), so no mark of an unclosed run opens a span.
 */
const REFERENCE_RE =
  /(?<!`)(`{3,})(?!`)[\s\S]*?(?<!`)\1`*(?!`)|(?<!~)(~{3,})(?!~)[\s\S]*?(?<!~)\2~*(?!~)|(?<!`)(`{1,2})(?!`)[\s\S]*?(?<!`)\3(?!`)/g;

const ALPHABET = "`~x\n[]";
const RANDOM_CASES = 5000;
const RANDOM_MAX_LENGTH = 40;
const SEED = 0x9e3779b9;

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceRegions(text: string): Array<[number, number]> {
  return [...text.matchAll(REFERENCE_RE)].map((m) => [m.index, m.index + m[0].length]);
}

/** Runs of `ch` of strictly decreasing length from `longest` down to 3, one per line. */
function decreasingRuns(ch: string, longest: number): string {
  const runs: string[] = [];
  for (let len = longest; len >= 3; len--) runs.push(ch.repeat(len));
  return runs.join("\nx\n");
}

/** About 4 MiB: the largest run length whose decreasing series fits. */
const DECREASING_LONGEST = 2_896;

describe("codeRegions", () => {
  test("agrees with the reference expression on random short inputs", () => {
    const next = prng(SEED);
    for (let n = 0; n < RANDOM_CASES; n++) {
      const length = Math.floor(next() * RANDOM_MAX_LENGTH);
      let text = "";
      for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
      expect({ text, regions: codeRegions(text) }).toEqual({
        text,
        regions: referenceRegions(text),
      });
      expect(maskCodeRegions(text, (s) => "#".repeat(s.length))).toBe(
        text.replace(REFERENCE_RE, (s) => "#".repeat(s.length)),
      );
    }
  });

  test.each([
    ["a longer closer ends the fence", "```\n[[in]]\n`````\n[[out]]"],
    ["a shorter run inside a longer fence stays masked", "````\n```\n[[in]]\n````\n[[out]]"],
    ["a tilde fence closes on a longer tilde run", "~~~~\n[[a]]\n~~~\n[[b]]\n~~~~ [[out]]"],
    ["an unclosed fence is not a region", "~~~\n[[kept]]"],
    ["no mark of an unclosed run opens an inline span", "```x`[[out]]"],
    ["a double-backtick span closes on a double run", "``a `b` [[in]]``[[out]]"],
    ["strikethrough is not a fence", "~~strike~~ [[out]]"],
  ])("%s", (_name, text) => {
    expect(codeRegions(text)).toEqual(referenceRegions(text));
  });

  test("an unclosed backtick run leaves the links after it unmasked", () => {
    const text = "Intro ```\nsee [[Alpha]]\nthen `x`";
    const single = text.indexOf("`x`");
    expect(codeRegions(text)).toEqual([[single, single + 3]]);
    expect(extractWikilinks(text)).toEqual(["Alpha"]);
  });

  test.each([
    ["tilde", "~"],
    ["backtick", "`"],
  ])("stays linear on unclosed %s runs of decreasing length", (_name, ch) => {
    const content = `${decreasingRuns(ch, DECREASING_LONGEST)}\n[[after]]`;
    let started = performance.now();
    const links = extractWikilinks(content);
    expect(performance.now() - started).toBeLessThan(LINEAR_CEILING_MS);
    expect(links).toEqual(["after"]);

    started = performance.now();
    normalizeWikilinks(content, "full", ["after.md"]);
    expect(performance.now() - started).toBeLessThan(LINEAR_CEILING_MS);
  });
});
