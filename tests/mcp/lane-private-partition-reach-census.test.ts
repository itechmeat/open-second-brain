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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scanCensus } from "./lane-private-partition-reach-census-scan.ts";

interface Row {
  readonly key: string;
  readonly class: string;
  readonly note: string;
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
  // Closed by the coarse rule of the fourth round, not traced one by one:
  // derived machine state computed for the answer and not persisted, or a
  // bulk verb refused below local reach while a lane holds a private entry.
  "coarse",
  "OPEN",
]);

/** The checked-in table: one tab-separated row per key, `#` lines are comments. */
const table: Row[] = readFileSync(
  join(import.meta.dir, "lane-private-partition-reach-census.tsv"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => {
    const [key = "", cls = "", note = ""] = line.split("\t");
    return { key, class: cls, note };
  });

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
});
