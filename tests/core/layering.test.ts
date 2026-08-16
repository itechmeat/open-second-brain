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
 * as a violation. Neither is hypothetical - both shapes occur in this
 * tree - and both are the same defect this repository keeps finding, a
 * rule enforced by an instrument that cannot see its subject.
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
});
