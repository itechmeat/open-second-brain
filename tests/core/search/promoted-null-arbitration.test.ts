/**
 * The promoted-key pushdown's NULL arm never decides a row on its own
 * (recall-quality, OCR wave).
 *
 * The pushdown compiles `type` as `(page_type IN (...) OR page_type IS
 * NULL)` and `pinned` as `(pinned = 1 OR pinned IS NULL)` because both
 * columns have a state that cannot answer the filter: `page_type` is
 * written only for scalar-string `type` frontmatter, and `pinned` is NULL
 * on every row an in-place upgrade carried over without re-examining (the
 * v13 lazy story). The NULL arms admit those rows as candidates - which is
 * correct - but the SQL arm that admitted them proves nothing, so the
 * post-rank stage must judge each NULL-column row under the live filter,
 * per row, regardless of the query's shape. The defect this pins: the old
 * shape gate arbitrated by the LIVE frontmatter's shape, so a stale-NULL
 * row whose live file meanwhile said `type: note` (a speakable scalar)
 * kept the SQL "verdict" it never received and surfaced under a
 * `type: report` filter; and a bare `pinned = 1` returned zero results on
 * an upgraded index whose every row is NULL.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("promoted-null"));
});
afterEach(() => cleanup());

function note(name: string, frontmatter: string, body: string): string {
  return `---\n${frontmatter}---\n\n# ${name}\n\n${body}`;
}

/**
 * Carry a document's row across a migration WITHOUT re-examining it: the
 * state an in-place upgrade leaves behind - the promoted columns exist,
 * hold NULL, and the live file says something the index never recorded.
 */
function carryOverUnmeasured(dbPath: string, paths: ReadonlyArray<string>): void {
  const db = new Database(dbPath);
  try {
    const update = db.query("UPDATE documents SET page_type = NULL, pinned = NULL WHERE path = ?");
    for (const path of paths) update.run(path);
  } finally {
    db.close(true);
  }
}

describe("the type pushdown arbitrates stale-NULL rows by the live filter", () => {
  test("a stale-NULL row is dropped when its live type misses the filter", async () => {
    writeMd(vault, "stale/a.md", note("A", "type: note\n", "delta stale anchor"));
    writeMd(vault, "stale/b.md", note("B", "type: report\n", "delta stale report"));
    writeMd(vault, "fresh/c.md", note("C", "type: report\n", "delta fresh control"));
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    carryOverUnmeasured(dbPath, ["stale/a.md", "stale/b.md"]);

    // The defect: stale/a (live `type: note`) rode the NULL arm in, its
    // scalar live shape earned the SQL verdict's trust, and it surfaced
    // under a `type: report` filter its own frontmatter fails.
    const reports = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["report"]]]),
    });
    expect(reports.results.map((r) => r.path).toSorted()).toEqual(["fresh/c.md", "stale/b.md"]);
  });

  test("a stale-NULL row whose live type matches the filter survives", async () => {
    writeMd(vault, "stale/a.md", note("A", "type: note\n", "delta stale anchor"));
    writeMd(vault, "stale/b.md", note("B", "type: report\n", "delta stale report"));
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    carryOverUnmeasured(dbPath, ["stale/a.md", "stale/b.md"]);

    // The complementary half of the same per-row rule: judging the NULL
    // row live must not over-drop the one whose live value matches.
    const notes = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["note"]]]),
    });
    expect(notes.results.map((r) => r.path)).toEqual(["stale/a.md"]);
  });

  test("a measured row keeps its SQL verdict untouched", async () => {
    writeMd(vault, "fresh/c.md", note("C", "type: report\n", "delta fresh control"));
    writeMd(vault, "fresh/d.md", note("D", "type: note\n", "delta fresh note"));
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);

    // No carried-over rows: every page_type is measured, the SQL IN arm
    // answered them as-indexed, and the gate finds nothing to arbitrate.
    const reports = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["report"]]]),
    });
    expect(reports.results.map((r) => r.path)).toEqual(["fresh/c.md"]);
  });
});

describe("the pinned pushdown arbitrates upgraded-index NULL rows by the live filter", () => {
  test("an all-NULL pinned column answers from the live frontmatter, not zero results", async () => {
    writeMd(vault, "pin/yes1.md", note("Yes1", "pinned: true\n", "delta pinned alpha"));
    writeMd(vault, "pin/yes2.md", note("Yes2", 'pinned: "true"\n', "delta pinned beta"));
    writeMd(vault, "pin/no1.md", note("No1", "pinned: false\n", "delta unpinned gamma"));
    writeMd(vault, "pin/no2.md", note("No2", "status: draft\n", "delta unpinned delta"));
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    // The in-place-upgrade index: the v13 column exists and the lazy
    // backfill has not run, so every carried-over row is NULL - the state
    // the bare `d.pinned = 1` pushdown answered with zero results.
    const db = new Database(dbPath);
    try {
      db.query("UPDATE documents SET pinned = NULL").run();
    } finally {
      db.close(true);
    }

    const pinned = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["pinned", ["true"]]]),
    });
    // Exactly the pages whose live frontmatter pins them - measured-spelling
    // "true" and quoted "true" alike - while the live false and the absent
    // key stay out.
    expect(pinned.results.map((r) => r.path).toSorted()).toEqual(["pin/yes1.md", "pin/yes2.md"]);
  });
});
