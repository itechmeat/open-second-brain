/**
 * Every row of a Markdown table in `docs/` has the columns of its header.
 *
 * A pipe inside a table cell ends the cell, a code span included, unless
 * it is written `\|`: an unescaped one split a row of the MCP reference
 * into extra cells and cut its description short.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "docs");

/** The cells of a table row: split on every pipe that is not escaped. */
function cellCount(row: string): number {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/).length;
}

/** `file:line (cells, header cells)` for every row whose cell count differs from its header's. */
function misshapenRows(file: string): string[] {
  const lines = readFileSync(join(DOCS, file), "utf8").split(/\r?\n/);
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.startsWith("|") || !/^\|\s*:?-{3,}/.test(lines[i + 1] ?? "")) continue;
    const header = cellCount(line);
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? "").startsWith("|"); j++) {
      const cells = cellCount(lines[j] ?? "");
      if (cells !== header) out.push(`${file}:${j + 1} (${cells} cells, header ${header})`);
    }
    i = j - 1;
  }
  return out;
}

describe("documentation tables", () => {
  test("every row has the columns of its header", () => {
    const files = readdirSync(DOCS).filter((name) => name.endsWith(".md"));
    expect(files.flatMap(misshapenRows)).toEqual([]);
  });
});
