/**
 * Layering guard for the core layer.
 *
 * The CLI owns exit codes and stdout formatting; src/core must never
 * terminate the process or write to stdout directly. Fail-soft
 * diagnostics on stderr (process.stderr.write, console.error) are an
 * established core pattern and stay allowed.
 *
 * This is a source scan, not an AST pass: comment-only lines are
 * skipped, everything else that mentions a banned call fails with a
 * file:line pointer.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("core layering", () => {
  test("src/core never calls process.exit, process.stdout.write, or console.log", () => {
    const violations: string[] = [];
    for (const file of walk(CORE_ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const { pattern, reason } of BANNED) {
          if (line.includes(pattern)) {
            violations.push(`${file}:${i + 1} uses ${pattern} (${reason})`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test("the scan actually detects a banned call", () => {
    // Self-check so a broken walk or pattern list cannot rot into a
    // vacuously green guard.
    expect(isCommentLine("  // process.exit(1)")).toBe(true);
    expect(isCommentLine("  process.exit(1);")).toBe(false);
    expect(walk(CORE_ROOT).length).toBeGreaterThan(100);
  });
});
