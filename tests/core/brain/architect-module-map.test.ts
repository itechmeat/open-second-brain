/**
 * The architect overview's Mermaid containment diagram
 * (salience-lifecycle-enrichment, unit 6 / t_041c571f).
 *
 * Claims pinned here:
 *  1. The `module-map` region carries a Mermaid block whose ONLY edges
 *     run from the project root to a module. The scanner records no
 *     import graph (`scan.ts`: "Import-graph analysis is explicitly out
 *     of scope"), so a diagram with module-to-module edges would be
 *     drawing relations nothing measured.
 *  2. Each module node is labeled with its name, its file count, and its
 *     dominant language; a module with no extension to count says so
 *     rather than rendering a blank label.
 *  3. Module order is codepoint-stable and does not depend on the host
 *     collation.
 *  4. A module name carrying Mermaid-hostile characters is entity-escaped
 *     in the label, and node ids never derive from the name at all.
 *  5. The same facts render a byte-identical block.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";

let tmp: string;
let project: string;

function seed(relPath: string, content = "// x\n"): void {
  const abs = join(project, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function freshVault(name: string): string {
  const made = join(tmp, name);
  mkdirSync(join(made, "Brain"), { recursive: true });
  return made;
}

/** The body of one sentinel region, without its sentinel lines. */
function regionBody(text: string, id: string): string {
  const begin = `<!-- o2b:begin ${id} -->\n`;
  const end = `\n<!-- o2b:end ${id} -->`;
  const from = text.indexOf(begin);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
}

function moduleMap(vaultName = "vault"): string {
  const res = generateArchDocs(freshVault(vaultName), project);
  return regionBody(readFileSync(res.overviewPath, "utf8"), "module-map");
}

/** The `a --> b` lines of a Mermaid block, in order. */
function edges(block: string): ReadonlyArray<string> {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("-->"));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-modulemap-"));
  project = join(tmp, "demo-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  seed("src/core/engine.ts");
  seed("src/core/util.ts");
  seed("src/cli/main.ts");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("the region renders a Mermaid block of root-to-module containment only", () => {
  const block = moduleMap();

  expect(block).toContain("```mermaid");
  expect(block).toContain("graph TD");
  expect(block.trimEnd().endsWith("```")).toBe(true);

  // One edge per module, and every one of them leaves the root node.
  const drawn = edges(block);
  expect(drawn).toHaveLength(2);
  expect(drawn.every((edge) => edge.startsWith("root -->"))).toBe(true);
});

test("each module node carries its file count and dominant language", () => {
  seed("src/core/notes.md");
  seed("src/core/more.ts");
  // A module whose files have no extension has no language to name.
  seed("src/scripts/Makefile", "all:\n");

  const block = moduleMap();

  expect(block).toContain("cli");
  expect(block).toContain("1 file(s)");
  // core: 3 .ts against 1 .md, so .ts dominates.
  expect(block).toContain("4 file(s)");
  expect(block).toContain(".ts");
  expect(block).toContain("no language detected");
});

test("module order is codepoint-stable, not collation-dependent", () => {
  seed("src/Zed/z.ts");
  seed("src/api/a.ts");

  const block = moduleMap();
  const drawn = edges(block);
  const named = drawn.map((edge) => edge.slice(edge.indexOf('["') + 2, edge.indexOf("<br/>")));

  // Uppercase before lowercase: codepoint order, which is what a
  // locale-aware collator would NOT produce.
  expect(named).toEqual(["Zed", "api", "cli", "core"]);
});

test("a Mermaid-hostile module name is escaped and never becomes a node id", () => {
  seed('src/a"b<c>#d/x.ts');

  const block = moduleMap();

  // The raw characters never reach the rendered label.
  expect(block).not.toContain('a"b');
  expect(block).not.toContain("<c>");
  expect(block).toContain("a#quot;b#lt;c#gt;#35;d");
  // Node ids are positional, so no name can produce an invalid one.
  for (const edge of edges(block)) {
    expect(edge).toMatch(/^root --> mod\d+\["/);
  }
});

test("the same facts render a byte-identical block", () => {
  expect(moduleMap("vault-b")).toBe(moduleMap("vault-a"));
});
