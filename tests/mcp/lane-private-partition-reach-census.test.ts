/**
 * The census of durable writes reachable from the MCP tool handlers stays
 * true (change `lane-private-partition-reach`, the write rule).
 *
 * The same search as the checked-in table
 * (`lane-private-partition-reach-census.tsv`), as code
 * (`lane-private-partition-reach-census-scan.ts`): a durable-write site in
 * a module reachable from `src/mcp/` that the table does not name fails
 * here, and so does a row the code no longer has, a row with no class, or
 * a row classed as deciding from no lane read whose function now makes
 * one. A new writer is classified in the table by the rule: maintenance of
 * the machine's own state runs on the whole fold and narrows only its
 * answer (a); a write the caller addresses is judged by the whole fold
 * before its first durable step (b); a row that cannot be settled is OPEN.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { scanCensus, type CensusSite } from "./lane-private-partition-reach-census-scan.ts";

interface Row {
  readonly key: string;
  readonly class: string;
  readonly note: string;
  /** The number of calls of the primitive in the function when the row was reviewed. */
  readonly calls: number;
}

const CLASSES = new Set([
  "no-lane-decision",
  "a-shown",
  "a-fixed",
  "b-guarded",
  "b-fixed",
  "call-record",
  "primitive",
  "name-collision",
  "not-reachable",
  "OPEN",
]);

/** The rows of a census table: one tab-separated row per key, `#` lines are comments. */
function rowsOf(text: string): Row[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const [key = "", cls = "", note = "", calls = ""] = line.split("\t");
      return { key, class: cls, note, calls: /^\d+$/.test(calls) ? Number(calls) : Number.NaN };
    });
}

const tableText = readFileSync(
  join(import.meta.dir, "lane-private-partition-reach-census.tsv"),
  "utf8",
);
/** The checked-in table. */
const table: Row[] = rowsOf(tableText);

/**
 * The rows whose reviewed call count is not the number of calls the scan
 * finds in the function now: a call added after the review (or one
 * removed) is reviewed again before the count is changed.
 */
function callCountDefects(rows: ReadonlyArray<Row>, scanned: ReadonlyArray<CensusSite>): string[] {
  const found = new Map(scanned.map((s) => [s.key, s.lines.length]));
  return rows
    .filter((r) => found.has(r.key) && found.get(r.key) !== r.calls)
    .map((r) => `${r.key}: reviewed ${r.calls} call(s), found ${found.get(r.key)}`);
}

/** The header line that records the rows no handler is found above. */
const NO_HANDLER_HEADER = /^# Rows with no handler ancestor[^:\n]*: (\d+)$/m;

/** The header's count of rows with no handler ancestor, against the scan's. */
function noHandlerHeaderDefects(text: string, scanned: ReadonlyArray<CensusSite>): string[] {
  const m = NO_HANDLER_HEADER.exec(text);
  const found = scanned.filter((s) => s.handlers.length === 0).length;
  if (m === null) return [`no header line for the rows with no handler ancestor (found ${found})`];
  return Number(m[1]) === found
    ? []
    : [`header says ${m[1]} rows with no handler ancestor, found ${found}`];
}

describe("census of durable writes reachable from the MCP tool handlers", () => {
  const scanned = scanCensus();
  const listed = new Map(table.map((r) => [r.key, r]));

  test("every durable-write site the search finds is a row of the table", () => {
    expect(scanned.filter((s) => !listed.has(s.key)).map((s) => s.key)).toEqual([]);
  });

  test("every row of the table is still a site in the code", () => {
    const found = new Set(scanned.map((s) => s.key));
    expect(table.filter((r) => !found.has(r.key)).map((r) => r.key)).toEqual([]);
  });

  test("every row is classified, and a row with no decision read still has none", () => {
    expect(table.filter((r) => !CLASSES.has(r.class)).map((r) => r.key)).toEqual([]);
    expect(table.filter((r) => r.note.trim() === "").map((r) => r.key)).toEqual([]);
    const reads = new Map(scanned.map((s) => [s.key, s.laneReads]));
    expect(
      table
        .filter((r) => r.class === "no-lane-decision" && (reads.get(r.key)?.length ?? 0) > 0)
        .map((r) => `${r.key}: ${reads.get(r.key)!.join(",")}`),
    ).toEqual([]);
  });

  test("every row records the call count it was reviewed at, and the code still has that many", () => {
    expect(table.filter((r) => Number.isNaN(r.calls)).map((r) => r.key)).toEqual([]);
    expect(callCountDefects(table, scanned)).toEqual([]);
  });

  test("the header records the rows with no handler ancestor", () => {
    expect(noHandlerHeaderDefects(tableText, scanned)).toEqual([]);
  });
});

/** A handler module under `src/mcp/` that calls each of `names` from `src/core/save.ts`. */
const handler = (names: ReadonlyArray<string>): string =>
  [
    `import { ${names.join(", ")} } from "../core/save.ts";`,
    "export function handle(vault: string): void {",
    ...names.map((n) => `  ${n}(vault);`),
    "}",
    "",
  ].join("\n");

describe("the census search on a small tree", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0).toReversed()) rmSync(root, { recursive: true, force: true });
  });

  /** A repository holding only `files` (paths relative to it), for the search. */
  function tree(files: Record<string, string>): { repo: string; src: string } {
    const repo = mkdtempSync(join(tmpdir(), "osb-census-"));
    roots.push(repo);
    for (const [rel, body] of Object.entries(files)) {
      const path = join(repo, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    return { repo, src: join(repo, "src") };
  }

  test("an aliased import of a write primitive is a call of it, named or through a namespace", () => {
    const fixture = tree({
      "src/mcp/handler.ts": handler(["saveOne", "saveTwo"]),
      "src/core/lane-alias.ts":
        'export { writeLanePage as store } from "../store/lane-pages.ts";\n',
      "src/core/save.ts": [
        'import { writeLaneText as put } from "../store/lane-pages.ts";',
        'import * as lanes from "./lane-alias.ts";',
        "export function saveOne(vault: string): void {",
        '  put(vault, "a.md", "x");',
        "}",
        "export function saveTwo(vault: string): void {",
        '  lanes.store(vault, "b.md", "y");',
        "}",
        "",
      ].join("\n"),
    });
    const keys = scanCensus(fixture).map((s) => s.key);
    expect(keys).toContain("src/core/save.ts::saveOne::writeLaneText");
    expect(keys).toContain("src/core/save.ts::saveTwo::writeLanePage");
  });

  test("a second call in a listed function fails the reviewed call count", () => {
    const fixture = tree({
      "src/mcp/handler.ts": handler(["saveTwice"]),
      "src/core/save.ts": [
        'import { writeLaneText } from "../store/lane-pages.ts";',
        "export function saveTwice(vault: string): void {",
        '  writeLaneText(vault, "a.md", "x");',
        '  writeLaneText(vault, "b.md", "y");',
        "}",
        "",
      ].join("\n"),
    });
    const scanned = scanCensus(fixture);
    const key = "src/core/save.ts::saveTwice::writeLaneText";
    expect(callCountDefects(rowsOf(`${key}\tb-guarded\treviewed\t1\n`), scanned)).toEqual([
      `${key}: reviewed 1 call(s), found 2`,
    ]);
    expect(callCountDefects(rowsOf(`${key}\tb-guarded\treviewed\t2\n`), scanned)).toEqual([]);
  });

  test("a function passed as a value is followed, and a primitive passed as a value is a call", () => {
    const fixture = tree({
      "src/mcp/handler.ts": handler(["run", "sweep"]),
      "src/core/save.ts": [
        'import { unlinkSync } from "node:fs";',
        'import { writeLaneText } from "../store/lane-pages.ts";',
        "function writeIt(vault: string): void {",
        '  writeLaneText(vault, "a.md", "x");',
        "}",
        "function withLock(vault: string, body: (vault: string) => void): void {",
        "  body(vault);",
        "}",
        "function orphan(vault: string): void {",
        '  writeLaneText(vault, "c.md", "z");',
        "}",
        "export function run(vault: string): void {",
        "  withLock(vault, writeIt);",
        "}",
        "export function sweep(vault: string): void {",
        "  [vault].forEach(unlinkSync);",
        "}",
        "",
      ].join("\n"),
    });
    const scanned = scanCensus(fixture);
    const site = (key: string): CensusSite | undefined => scanned.find((s) => s.key === key);
    expect(site("src/core/save.ts::writeIt::writeLaneText")?.handlers).toEqual(["handle"]);
    expect(site("src/core/save.ts::sweep::unlinkSync")?.handlers).toEqual(["handle"]);
    // The function nothing calls or passes stays a row with no handler above it.
    expect(site("src/core/save.ts::orphan::writeLaneText")?.handlers).toEqual([]);
    const header = "# Rows with no handler ancestor (reviewed by hand): 1\n";
    expect(noHandlerHeaderDefects(header, scanned)).toEqual([]);
    expect(noHandlerHeaderDefects(header.replace(": 1", ": 2"), scanned)).toEqual([
      "header says 2 rows with no handler ancestor, found 1",
    ]);
  });
});
