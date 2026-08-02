/**
 * The event anchor end to end (provenance at the boundary, t_ac1c4176):
 * materialised at index time onto `documents`, then consumed by the
 * query-side event-time resolver so a note is ranked by when it is ABOUT
 * rather than by when its file was last written.
 *
 * The point of materialising it is that a candidate's body is not
 * re-scanned on every query; these tests therefore assert the stored row
 * as well as the ranking it produces.
 *
 * Each test drives a real index build, so they carry the same explicit
 * 30s budget the other index-driving suites use rather than the 5s
 * default, and each shares one build across as many assertions as it can.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { EVENT_ANCHOR_SOURCE, type EventAnchor } from "../../../src/core/search/event-anchor.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { TEMPORAL_INTENT_BOOST_CAP } from "../../../src/core/search/ranker.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Budget for a test that builds an index; matches the other index suites. */
const INDEX_TEST_TIMEOUT_MS = 30_000;
/** Two fixtures sharing this storage mtime leave the anchor as the only difference. */
const PINNED_MTIME = new Date("2026-07-01T00:00:00Z");

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("event-anchor");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/**
 * Two notes built from this helper are identical in token count and in
 * query-term frequency, so their BM25 scores tie exactly; `token` is the
 * only difference and only some of its forms are ISO dates.
 */
function noteMd(token: string): string {
  return [
    "# Ledger reconciliation",
    "",
    `The reconciliation entry ${token} closed the batch.`,
    "",
  ].join("\n");
}

function pinMtime(relPath: string): void {
  utimesSync(join(vault, relPath), PINNED_MTIME, PINNED_MTIME);
}

function dayWindow(iso: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${iso}T00:00:00Z`);
  return { startMs, endMs: startMs + DAY_MS - 1 };
}

async function anchors(
  config: ReturnType<typeof makeConfig>,
  paths: ReadonlyArray<string>,
): Promise<Array<EventAnchor | null>> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return paths.map((p) => store.eventAnchorForPath(p));
  } finally {
    store.close();
  }
}

test(
  "each ladder rung is materialised onto the document with its registered source token",
  async () => {
    writeMd(vault, "notes/dated.md", noteMd("2026-03-04"));
    writeMd(vault, "notes/plain.md", noteMd("ref-xy-1234"));
    writeMd(vault, "notes/embargo.md", noteMd("2099-12-31"));
    writeMd(vault, "notes/duration.md", noteMd("P1Y"));
    writeMd(
      vault,
      "notes/fm.md",
      ["---", "created_at: 2025-11-20", "---", "", noteMd("2026-03-04")].join("\n"),
    );
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const paths = [
      "notes/dated.md",
      "notes/plain.md",
      "notes/embargo.md",
      "notes/duration.md",
      "notes/fm.md",
    ];
    const first = await anchors(config, paths);

    expect(first).toEqual([
      // A body ISO date becomes a day-width window sourced to the body.
      { ...dayWindow("2026-03-04"), source: EVENT_ANCHOR_SOURCE.body },
      // A note that declares nothing anywhere stores nothing.
      null,
      // A future date is STORED, not dropped: it is a real declaration.
      { ...dayWindow("2099-12-31"), source: EVENT_ANCHOR_SOURCE.body },
      // A clock-relative derivation is never materialised.
      null,
      // Frontmatter outranks the body, and says so in its own token.
      {
        startMs: Date.parse("2025-11-20T00:00:00Z"),
        endMs: Date.parse("2025-11-20T00:00:00Z") + DAY_MS - 1,
        source: EVENT_ANCHOR_SOURCE.createdAt,
      },
    ]);

    // Re-index over UNCHANGED content. Both fastpaths gate on content
    // identity and correctly decline to recompute, so a clock-derived
    // value stored on the first run would still be sitting here on the
    // second, silently ageing. Nothing may drift between the two runs.
    await indexVault(config, { embeddings: false, force: true });
    expect(await anchors(config, paths)).toEqual(first);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "a body ISO date ranks the note into a query-declared window over an equally relevant dateless peer",
  async () => {
    writeMd(vault, "notes/dated.md", noteMd("2026-03-04"));
    writeMd(vault, "notes/plain.md", noteMd("ref-xy-1234"));
    pinMtime("notes/dated.md");
    pinMtime("notes/plain.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const outcome = await search(config, {
      query: "since:2026-03-01 until:2026-03-31 reconciliation entry",
      limit: 5,
    });
    const dated = outcome.results.find((r) => r.path === "notes/dated.md");
    const plain = outcome.results.find((r) => r.path === "notes/plain.md");
    expect(dated).toBeDefined();
    expect(plain).toBeDefined();
    // The anchor puts the dated note inside the declared window; the
    // dateless one falls back to its storage mtime, months outside it.
    expect(dated!.breakdown!["temporal"]).toBeCloseTo(TEMPORAL_INTENT_BOOST_CAP, 6);
    expect(plain!.breakdown!["temporal"]).toBeLessThan(dated!.breakdown!["temporal"]!);
    expect(outcome.results[0]!.path).toBe("notes/dated.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "two dateless notes keep the mtime ordering the temporal layer had before the anchor existed",
  async () => {
    writeMd(vault, "notes/old.md", noteMd("ref-xy-1234"));
    writeMd(vault, "notes/new.md", noteMd("ref-xy-5678"));
    const older = new Date("2026-01-05T00:00:00Z");
    utimesSync(join(vault, "notes/old.md"), older, older);
    pinMtime("notes/new.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    expect(await anchors(config, ["notes/old.md", "notes/new.md"])).toEqual([null, null]);

    const outcome = await search(config, {
      query: "since:2026-06-15 until:2026-07-15 reconciliation entry",
      limit: 5,
    });
    // Neither note declares anything, so both are judged on mtime exactly
    // as they were before this feature; the one inside the window leads.
    expect(outcome.results[0]!.path).toBe("notes/new.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "the anchor also composes with the hard since/until filter, not only the ranking boost",
  async () => {
    writeMd(vault, "notes/dated.md", noteMd("2026-03-04"));
    writeMd(vault, "notes/plain.md", noteMd("ref-xy-1234"));
    pinMtime("notes/dated.md");
    pinMtime("notes/plain.md");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    const outcome = await search(config, {
      query: "reconciliation entry",
      since: "2026-03-01",
      until: "2026-03-31",
      limit: 5,
    });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("notes/dated.md");
    expect(paths).not.toContain("notes/plain.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);
