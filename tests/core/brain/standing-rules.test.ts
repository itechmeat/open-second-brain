/**
 * Operator standing rules (silence-is-not-an-answer, U8).
 *
 * The one lane of the session preamble the operator authors. Three
 * properties are load-bearing and each has a case here:
 *
 *   - ABSENCE IS NULL, FAILURE IS A THROW. A file that is not there and
 *     a file the process cannot read are different answers. The second
 *     one may never quietly become the first, because a constitution
 *     that vanishes without a word is worse than one that is missing.
 *   - OPACITY. The reader performs exactly three operations on the
 *     operator's bytes: read, trim, and line-boundary trimming at a
 *     character cap. A non-Latin body must round-trip byte-identically
 *     and count identically to a Latin body of the same length - the
 *     guard against any future word list, heading split, or classifier
 *     creeping into the reader.
 *   - LOUD TRUNCATION. A capped block says how much it kept, out of how
 *     much, in lines and characters, and where the whole text lives.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainStandingRulesPath } from "../../../src/core/brain/paths.ts";
import {
  STANDING_RULES_HEADER,
  STANDING_RULES_MAX_CHARS_DEFAULT,
  STANDING_RULES_MAX_CHARS_MAX,
  STANDING_RULES_MAX_CHARS_MIN,
  readStandingRules,
  renderStandingRules,
  renderStandingRulesFailure,
} from "../../../src/core/brain/standing-rules.ts";

let vault: string;

/** A mode change cannot make a file unreadable to uid 0. */
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-standing-rules-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeRules(body: string): string {
  const path = brainStandingRulesPath(vault);
  writeFileSync(path, body, "utf8");
  return path;
}

/** `n` lines of `char` repeated `width` times: a body of known char/line counts. */
function bodyOf(char: string, lines: number, width: number): string {
  return Array.from({ length: lines }, () => char.repeat(width)).join("\n");
}

describe("readStandingRules: absence and emptiness are null", () => {
  test("absent file returns null", () => {
    expect(readStandingRules(vault)).toBeNull();
  });

  test("whitespace-only file returns null", () => {
    writeRules("   \n\n\t\n  ");
    expect(readStandingRules(vault)).toBeNull();
  });
});

describe("readStandingRules: a present file", () => {
  const BODY = "Never force-push.\nAsk before deleting anything under Archive/.";

  test("carries the operator text verbatim and reports no truncation", () => {
    const path = writeRules(`\n${BODY}\n\n`);
    const rules = readStandingRules(vault);
    expect(rules).not.toBeNull();
    expect(rules!.path).toBe(path);
    expect(rules!.text).toBe(BODY);
    expect(rules!.truncated).toBe(false);
    expect(rules!.totalLines).toBe(2);
    expect(rules!.keptLines).toBe(2);
    expect(rules!.totalChars).toBe(BODY.length);
    expect(rules!.keptChars).toBe(BODY.length);
  });

  test("renders the header first, then the operator text unchanged", () => {
    writeRules(BODY);
    const block = renderStandingRules(readStandingRules(vault)!);
    expect(block.startsWith(STANDING_RULES_HEADER)).toBe(true);
    expect(block).toContain(BODY);
    // Nothing rides along when the body fits: the block is exactly the
    // header, the separator and the operator's own bytes.
    expect(block).toBe(`${STANDING_RULES_HEADER}\n\n${BODY}`);
  });
});

describe("readStandingRules: operator bytes are opaque", () => {
  // Equal LINE and CHARACTER counts, different scripts. Any reader that
  // inspected words, split on headings, or classified content would make
  // these two diverge; the counts and the round-trip say it does not.
  const LINES = 6;
  const WIDTH = 20;
  const LATIN = bodyOf("a", LINES, WIDTH);
  const NON_LATIN = bodyOf("ф", LINES, WIDTH);
  const IDEOGRAPHIC = bodyOf("方", LINES, WIDTH);

  test("a non-Latin body round-trips byte-identically", () => {
    writeRules(NON_LATIN);
    expect(readStandingRules(vault)!.text).toBe(NON_LATIN);
  });

  test("scripts of equal length produce identical counts", () => {
    const counts = (body: string): Record<string, unknown> => {
      writeRules(body);
      const { text: _text, path: _path, ...rest } = readStandingRules(vault)!;
      return rest;
    };
    const latin = counts(LATIN);
    expect(counts(NON_LATIN)).toEqual(latin);
    expect(counts(IDEOGRAPHIC)).toEqual(latin);
  });

  test("a capped non-Latin body is cut identically to a Latin one", () => {
    const cap = STANDING_RULES_MAX_CHARS_MIN;
    const wide = (char: string): string => bodyOf(char, 200, WIDTH);
    writeRules(wide("a"));
    const latin = readStandingRules(vault, { maxChars: cap })!;
    writeRules(wide("ф"));
    const nonLatin = readStandingRules(vault, { maxChars: cap })!;
    expect(nonLatin.keptLines).toBe(latin.keptLines);
    expect(nonLatin.keptChars).toBe(latin.keptChars);
    expect(nonLatin.text).toBe(bodyOf("ф", latin.keptLines, WIDTH));
  });
});

describe("readStandingRules: capping is loud and cut on a line boundary", () => {
  const LINES = 400;
  const WIDTH = 30;

  test("an over-cap body is cut at a line boundary", () => {
    writeRules(bodyOf("r", LINES, WIDTH));
    const rules = readStandingRules(vault, { maxChars: STANDING_RULES_MAX_CHARS_MIN })!;
    expect(rules.truncated).toBe(true);
    expect(rules.totalLines).toBe(LINES);
    expect(rules.keptLines).toBeLessThan(LINES);
    expect(rules.keptChars).toBeLessThanOrEqual(STANDING_RULES_MAX_CHARS_MIN);
    // Every kept line is a whole line of the original.
    for (const line of rules.text.split("\n")) expect(line).toBe("r".repeat(WIDTH));
  });

  test("the notice names kept and total lines, kept and total characters, and the path", () => {
    const path = writeRules(bodyOf("r", LINES, WIDTH));
    const rules = readStandingRules(vault, { maxChars: STANDING_RULES_MAX_CHARS_MIN })!;
    const block = renderStandingRules(rules);
    const notice = block.slice(block.indexOf(rules.text) + rules.text.length);
    for (const n of [rules.keptLines, rules.totalLines, rules.keptChars, rules.totalChars]) {
      expect(notice).toContain(String(n));
    }
    expect(notice).toContain(path);
    // The operator's own bytes still lead the block, header aside.
    expect(block.startsWith(`${STANDING_RULES_HEADER}\n\n${rules.text}`)).toBe(true);
  });

  test("the default cap applies when the caller names none", () => {
    writeRules(bodyOf("r", LINES, WIDTH));
    const rules = readStandingRules(vault)!;
    expect(rules.keptChars).toBeLessThanOrEqual(STANDING_RULES_MAX_CHARS_DEFAULT);
  });

  test("a cap above the body length keeps everything", () => {
    const body = bodyOf("r", LINES, WIDTH);
    writeRules(body);
    const rules = readStandingRules(vault, { maxChars: STANDING_RULES_MAX_CHARS_MAX })!;
    expect(rules.truncated).toBe(false);
    expect(rules.text).toBe(body);
  });
});

describe("readStandingRules: an unreadable file throws rather than returning null", () => {
  test.skipIf(RUNNING_AS_ROOT)("the throw names the path and the reason", () => {
    const path = writeRules("Never force-push.\n");
    chmodSync(path, 0o000);
    try {
      let thrown: unknown;
      try {
        readStandingRules(vault);
      } catch (err) {
        thrown = err;
      }
      // Stated as two separate claims: it threw, AND what it did not do
      // was return the same null an absent file returns.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(path);
      expect((thrown as Error).message.toLowerCase()).toContain("permission denied");
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("a directory at the rules path is a failure, not an absence", () => {
    mkdirSync(brainStandingRulesPath(vault));
    expect(() => readStandingRules(vault)).toThrow(brainStandingRulesPath(vault));
  });
});

describe("renderStandingRulesFailure", () => {
  test("names the path, the reason, and that no rules are in force", () => {
    const path = brainStandingRulesPath(vault);
    const block = renderStandingRulesFailure(path, new Error("EACCES: permission denied"));
    expect(block).toContain(path);
    expect(block).toContain("EACCES: permission denied");
    expect(block.toLowerCase()).toContain("unavailable");
    expect(block.toLowerCase()).toContain("no standing rules are in force");
  });

  test("a non-Error reason is still reported", () => {
    const block = renderStandingRulesFailure("/v/Brain/standing-rules.md", "disk went away");
    expect(block).toContain("disk went away");
  });
});
