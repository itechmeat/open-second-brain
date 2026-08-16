/**
 * Layering guard for the core layer.
 *
 * The CLI owns exit codes and stdout formatting; src/core must never
 * terminate the process or write to stdout directly. Fail-soft
 * diagnostics on stderr (process.stderr.write, console.error) are an
 * established core pattern and stay allowed.
 *
 * This is a source scan, not an AST pass, and it reads the shared census
 * lexer's code view rather than deciding "is a comment" from a line
 * prefix. The prefix rule was wrong in both directions: a continuation
 * line inside a block comment does not start with `*` and was scanned as
 * code, while a banned call quoted inside a string literal was reported
 * as a violation.
 *
 * Both shapes are CONSTRUCTED in the positive controls below rather than
 * observed in this tree, and saying so is the point: `src/core` mentions
 * a banned pattern exactly twice, both times as `process.exit` in a line
 * or block comment that the prefix rule blanked correctly too. The two
 * rules therefore agree on today's tree, and this change fixes no live
 * miscount - it closes a class the tree can re-enter with one sentence,
 * which is a smaller claim than the one this docblock used to make. The
 * last test measures those two mentions rather than asserting them from
 * memory.
 *
 * One thing the lexer view is BLINDER about than the prefix rule, stated
 * because it is a real narrowing: template-literal text is blanked, so a
 * banned pattern written inside a template is invisible here where the
 * prefix rule would have reported it. That is the intended reading - text
 * a module emits is not a call the module makes, exactly as a quoted
 * string is not - and `${…}` interpolations stay code, so a banned call
 * INSIDE an interpolation is still caught. The control below pins both
 * halves.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { lexCode } from "../helpers/source-lexer.ts";

const CORE_ROOT = join(import.meta.dir, "..", "..", "src", "core");

const BANNED = [
  { pattern: "process.exit", reason: "core must not terminate the process" },
  { pattern: "process.stdout.write", reason: "stdout formatting belongs to the CLI layer" },
  { pattern: "console.log(", reason: "stdout logging belongs to the CLI layer" },
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Banned calls in `text`, as `line:pattern` pairs. The code view blanks
 * comment bodies and string / template / regex CONTENTS while preserving
 * every offset, so a line number here still points at the same line of
 * the original file.
 */
function bannedCallsIn(text: string): string[] {
  const found: string[] = [];
  lexCode(text)
    .split("\n")
    .forEach((line, i) => {
      for (const { pattern, reason } of BANNED) {
        if (line.includes(pattern)) found.push(`${i + 1} uses ${pattern} (${reason})`);
      }
    });
  return found;
}

describe("core layering", () => {
  test("src/core never calls process.exit, process.stdout.write, or console.log", () => {
    const violations: string[] = [];
    for (const file of walk(CORE_ROOT)) {
      for (const hit of bannedCallsIn(readFileSync(file, "utf8"))) {
        violations.push(`${file}:${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the scan detects a banned call, and only where it is really code", () => {
    // Positive control first: a guard that cannot fail proves nothing.
    expect(bannedCallsIn("process.exit(1);\n")).toHaveLength(1);

    // A line comment, the one shape the old prefix rule got right.
    expect(bannedCallsIn("  // process.exit(1)\n")).toEqual([]);

    // A CONTINUATION line of a block comment. It starts with neither
    // `//`, `*` nor `/*`, so the prefix rule scanned it as code and this
    // was a false violation waiting for someone to write the sentence.
    expect(bannedCallsIn("/* explaining why\nconsole.log( is banned here\n*/\n")).toEqual([]);

    // The other direction: the pattern quoted inside a string literal is
    // not a call, and the prefix rule reported it as one.
    expect(bannedCallsIn('const banned = "console.log(";\n')).toEqual([]);

    expect(walk(CORE_ROOT).length).toBeGreaterThan(100);
  });

  test("template text is not a call, but an interpolation still is", () => {
    // The stated narrowing, pinned in both directions. A module that
    // BUILDS the text `console.log(` is emitting a string, and the
    // prefix rule used to call that a violation…
    expect(bannedCallsIn("const snippet = `console.log(x)`;\n")).toEqual([]);
    // …while a banned call written inside an interpolation is code, and
    // is still reported.
    expect(bannedCallsIn("const s = `a ${process.exit(1)} b`;\n")).toHaveLength(1);
  });

  test("every mention of a banned pattern in src/core is already a comment", () => {
    // The measurement behind the docblock's claim that the controls above
    // are constructed rather than observed. A RAW text scan, no lexing,
    // and then the same files through the lexer: every raw mention must
    // disappear, which is what "the two rules agree on today's tree"
    // means. A hit that survives is either a real violation (the test
    // above fails too) or a mention in a string, at which point the
    // docblock's "constructed, not observed" sentence is what changes.
    const rawMentions: string[] = [];
    for (const file of walk(CORE_ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const { pattern } of BANNED) {
        if (text.includes(pattern)) rawMentions.push(`${file} mentions ${pattern}`);
        if (lexCode(text).includes(pattern)) {
          throw new Error(`${file}: ${pattern} survives the code view`);
        }
      }
    }
    // Not zero, and the count is the point: there ARE mentions, all of
    // them prose about why the pattern is banned.
    expect(rawMentions).toHaveLength(2);
    expect(rawMentions.every((hit) => hit.endsWith("process.exit"))).toBe(true);
  });
});
