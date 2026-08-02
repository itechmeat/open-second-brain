/**
 * The event anchor where it REMOVES results: the hard `since` / `until`
 * filter (provenance at the boundary, t_ac1c4176).
 *
 * `event-anchor-index.test.ts` pins both of its fixtures to one storage
 * mtime so the anchor is the only difference, and then asserts ranking
 * ORDER. That leaves the case where a result DISAPPEARS untested - a note
 * whose declared date and whose file mtime fall on opposite sides of the
 * queried window - which is the only case in which the anchor can turn a
 * hit into a non-hit. Every test here is that case, and each asserts
 * presence or absence explicitly.
 *
 * Two properties are pinned:
 *
 *   1. An anchor row this binary cannot interpret raises. The store
 *      raises `INDEX_UNREADABLE` for exactly that row, and the resolver
 *      must let it through: "declared no event time" and "I could not
 *      read what was declared" are different answers, and the second
 *      silently answered as the first would demote a document to mtime
 *      for every candidate in the call, through a memoised cache.
 *   2. `created_at` / `date` frontmatter is NOT event time in this
 *      release. Those keys are stamped by every Brain writer, they were
 *      never event time before it, and promoting them into a filter that
 *      DROPS candidates would silently change what a time-ranged query
 *      means.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { createEventTimeResolver } from "../../../src/core/search/pipeline/event-time.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** Budget for a test that builds an index; matches the other index suites. */
const INDEX_TEST_TIMEOUT_MS = 30_000;
/** Storage mtime every fixture below is pinned to: inside the query window. */
const MTIME_IN_WINDOW = new Date("2026-07-01T00:00:00Z");
/** The date every fixture DECLARES: two years outside that window. */
const DECLARED_OUT_OF_WINDOW = "2024-03-01";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("event-anchor-filter");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function pinMtime(relPath: string): void {
  utimesSync(join(vault, relPath), MTIME_IN_WINDOW, MTIME_IN_WINDOW);
}

/** A note whose only date sits in the named frontmatter field. */
function frontmatterNote(field: string): string {
  return [
    "---",
    `${field}: ${DECLARED_OUT_OF_WINDOW}`,
    "---",
    "",
    "# Ledger",
    "",
    "The reconciliation entry closed the batch.",
    "",
  ].join("\n");
}

/** A note whose only date sits in its body. */
function bodyNote(): string {
  return [
    "# Ledger",
    "",
    `The reconciliation entry ${DECLARED_OUT_OF_WINDOW} closed the batch.`,
    "",
  ].join("\n");
}

test("an anchor row this binary cannot interpret reaches the caller instead of reading as 'no declared event time'", () => {
  writeMd(vault, "notes/a.md", "# A\n\nNo validity frontmatter anywhere.\n");
  const unreadable = new SearchError(
    "INDEX_UNREADABLE",
    "documents.event_anchor_source for 'notes/a.md' is not a registered anchor source: 'wat'",
  );
  const resolver = createEventTimeResolver(vault, new Map(), () => {
    throw unreadable;
  });

  expect(() => resolver.validityWindowFor("notes/a.md")).toThrow(unreadable);
  // And again: a first call must not have memoised a null window, which
  // would answer every later candidate in the same call with "declared
  // nothing" on the strength of a read that failed.
  expect(() => resolver.validityWindowFor("notes/a.md")).toThrow(unreadable);
  expect(() => resolver.declaredEventTimeMs("notes/a.md")).toThrow(unreadable);
});

test(
  "a corrupt anchor token fails the whole query instead of quietly demoting the note to mtime",
  async () => {
    writeMd(vault, "notes/body.md", bodyNote());
    pinMtime("notes/body.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    // A token no registered vocabulary contains: an index written by a
    // binary this one cannot interpret.
    const db = new Database(dbPath);
    db.run("UPDATE documents SET event_anchor_source = 'wat' WHERE path = 'notes/body.md'");
    db.close();

    await expect(
      search(config, {
        query: "reconciliation entry",
        since: "2026-01-01",
        until: "2026-12-31",
        limit: 5,
      }),
    ).rejects.toThrow(SearchError);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "a note whose created_at disagrees with its mtime stays in a since/until filter",
  async () => {
    writeMd(vault, "notes/created-at.md", frontmatterNote("created_at"));
    writeMd(vault, "notes/date.md", frontmatterNote("date"));
    pinMtime("notes/created-at.md");
    pinMtime("notes/date.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const outcome = await search(config, {
      query: "reconciliation entry",
      since: "2026-01-01",
      until: "2026-12-31",
      limit: 5,
    });

    // Both notes were WRITTEN inside the window and neither declares a
    // validity window, so "what did I touch since January" must still
    // answer with both. Before this release neither key was event time;
    // this release does not make them event time either.
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("notes/created-at.md");
    expect(paths).toContain("notes/date.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "a body-declared date does remove the note from the filter, and says so",
  async () => {
    writeMd(vault, "notes/body.md", bodyNote());
    pinMtime("notes/body.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const outcome = await search(config, {
      query: "reconciliation entry",
      since: "2026-01-01",
      until: "2026-12-31",
      limit: 5,
    });

    // The body rung IS event time - that is the whole scope of this
    // release - so the note is judged by the date it states rather than
    // by when its file was last written, and it drops out.
    expect(outcome.results.map((r) => r.path)).not.toContain("notes/body.md");
    // Dropping a result is not something to do quietly: the candidate
    // was removed by an INFERRED date, and the caller is told which path
    // and which rung inferred it.
    expect(outcome.warnings.some((w) => w.includes("notes/body.md") && w.includes("body"))).toBe(
      true,
    );
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "a declared validity window still removes the note, exactly as it did before the anchor existed",
  async () => {
    writeMd(
      vault,
      "notes/validity.md",
      [
        "---",
        `valid_from: ${DECLARED_OUT_OF_WINDOW}`,
        `valid_until: ${DECLARED_OUT_OF_WINDOW}`,
        "---",
        "",
        "# Ledger",
        "",
        "The reconciliation entry closed the batch.",
        "",
      ].join("\n"),
    );
    pinMtime("notes/validity.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const outcome = await search(config, {
      query: "reconciliation entry",
      since: "2026-01-01",
      until: "2026-12-31",
      limit: 5,
    });
    expect(outcome.results.map((r) => r.path)).not.toContain("notes/validity.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);
