/**
 * Query-side temporal intent end to end (t_58fc4720): `search()` detects
 * the window at the query-plan seam, strips the `since:` / `until:`
 * directives from the keyword lane so they bias rather than exclude, and
 * threads the declared event times into the ranker's temporal layer.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { utimesSync } from "node:fs";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const BODY = "Reactor coolant excursion timeline and valve maintenance log.";
const IN_WINDOW = new Date(Date.UTC(2024, 5, 15));
const OUT_OF_WINDOW_QUERY = "reactor coolant excursion";
const WINDOWED_QUERY = "reactor coolant excursion since:2024-06-01 until:2024-06-30";

describe("search() honours a query-declared temporal window", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("temporal-intent"));
  });

  afterEach(() => {
    cleanup();
  });

  async function buildVault(): Promise<ReturnType<typeof makeConfig>> {
    const old = writeMd(vault, "Brain/notes/old.md", `# Old\n\n${BODY}\n`);
    writeMd(vault, "Brain/notes/recent.md", `# Recent\n\n${BODY}\n`);
    utimesSync(old, IN_WINDOW, IN_WINDOW);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    return config;
  }

  test("without a window the fresher note wins", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: OUT_OF_WINDOW_QUERY });
    expect(outcome.results[0]!.path).toBe("Brain/notes/recent.md");
  });

  test("a declared historical window floats the in-window note without excluding the other", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: WINDOWED_QUERY });
    const paths = outcome.results.map((r) => r.path);
    // Biased, not filtered: both notes are still returned.
    expect(paths).toContain("Brain/notes/old.md");
    expect(paths).toContain("Brain/notes/recent.md");
    expect(paths[0]).toBe("Brain/notes/old.md");
  });

  test("the directive is stripped from the keyword lane, so it never kills the match", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: WINDOWED_QUERY });
    expect(outcome.results.length).toBeGreaterThan(0);
    const inWindow = outcome.results.find((r) => r.path === "Brain/notes/old.md")!;
    expect(inWindow.reasons.some((x) => x.startsWith("temporal_intent: "))).toBe(true);
  });

  test("a declared valid_from is the event-time authority over mtime", async () => {
    // Written today, but the note declares it is ABOUT the window.
    writeMd(
      vault,
      "Brain/notes/backfilled.md",
      `---\nvalid_from: 2024-06-10\nvalid_until: 2024-06-20\n---\n\n# Backfilled\n\n${BODY}\n`,
    );
    writeMd(vault, "Brain/notes/recent.md", `# Recent\n\n${BODY}\n`);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: WINDOWED_QUERY });
    expect(outcome.results[0]!.path).toBe("Brain/notes/backfilled.md");
  });

  test("the hard since/until filter still excludes, and composes with the soft window", async () => {
    const config = await buildVault();
    const outcome = await search(config, {
      query: OUT_OF_WINDOW_QUERY,
      since: "2024-06-01",
      until: "2024-06-30",
    });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/old.md");
    expect(paths).not.toContain("Brain/notes/recent.md");
  });

  // ----- the window survives query expansion ------------------------------
  //
  // Expansion rewrites the keyword text into `lex.include` terms, which is
  // a bare token list: the `field:value` grammar does not survive it. The
  // window must therefore be detected from the ORIGINAL query, or detection
  // and stripping disagree and the directive reaches the implicit-AND
  // keyword lane as a term no document carries.

  test("expansion alone (no window) is the control: both notes are found", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: OUT_OF_WINDOW_QUERY, expand: true });
    expect(outcome.results.map((r) => r.path).toSorted()).toEqual([
      "Brain/notes/old.md",
      "Brain/notes/recent.md",
    ]);
  });

  test("a declared window under expansion still finds both notes and still biases", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: WINDOWED_QUERY, expand: true });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/old.md");
    expect(paths).toContain("Brain/notes/recent.md");
    expect(paths[0]).toBe("Brain/notes/old.md");
    const inWindow = outcome.results.find((r) => r.path === "Brain/notes/old.md")!;
    expect(inWindow.reasons.some((x) => x.startsWith("temporal_intent: "))).toBe(true);
  });

  test("the thorough recall profile (expansion on) keeps the window too", async () => {
    const config = await buildVault();
    const outcome = await search(config, { query: WINDOWED_QUERY, profile: "thorough" });
    expect(outcome.results.length).toBeGreaterThan(0);
    const inWindow = outcome.results.find((r) => r.path === "Brain/notes/old.md")!;
    expect(inWindow.reasons.some((x) => x.startsWith("temporal_intent: "))).toBe(true);
  });

  // ----- a window with no terms is an input error --------------------------

  test("a directive-only query names what is missing instead of returning nothing", async () => {
    const config = await buildVault();
    await expect(search(config, { query: "since:2024-06-01 until:2024-06-30" })).rejects.toThrow(
      SearchError,
    );
    await expect(search(config, { query: "since:2024-06-01" })).rejects.toThrow(
      /no search terms/iu,
    );
  });

  // ----- a shape-only bare token is not a declaration ----------------------

  test("an ISO-shaped but impossible bare token never aborts the search", async () => {
    const config = await buildVault();
    for (const query of [
      "reactor coolant excursion 2024-06-31",
      "reactor coolant excursion 2023-02-29",
      "reactor coolant excursion 2026-13-45",
    ]) {
      // eslint-disable-next-line no-await-in-loop -- three sequential probes
      const outcome = await search(config, { query, limit: 5 });
      // No window is declared, so the token is ordinary content: the query
      // behaves exactly as it would with any other literal the corpus does
      // not carry, instead of raising INVALID_INPUT.
      expect(outcome.results.map((r) => r.path)).toEqual([]);
    }
  });

  test("an impossible date token stays in the query text as content", async () => {
    writeMd(vault, "Brain/notes/invoice.md", "# Invoice\n\nReactor invoice 2024-06-31 filed.\n");
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: "reactor invoice 2024-06-31", limit: 5 });
    expect(outcome.results.map((r) => r.path)).toContain("Brain/notes/invoice.md");
  });

  // ----- no natural-language phrase is recognised in query text ------------

  test("an English phrase in a query directive is refused, exactly as any other language is", async () => {
    const config = await buildVault();
    for (const value of ["yesterday", "today", "ayer"]) {
      // eslint-disable-next-line no-await-in-loop -- three sequential probes
      await expect(search(config, { query: `reactor coolant since:${value}` })).rejects.toThrow(
        SearchError,
      );
    }
  });

  test("the language-neutral forms still resolve from query text", async () => {
    const config = await buildVault();
    for (const value of ["2024-06-01", "2024-06-01T00:00:00Z", "30d"]) {
      // eslint-disable-next-line no-await-in-loop -- three sequential probes
      const outcome = await search(config, { query: `reactor coolant since:${value}` });
      expect(outcome.results.length).toBeGreaterThan(0);
    }
  });

  // ----- the cache treats a query-declared window like the parameter form --

  test("a query-declared window bypasses the query cache", async () => {
    const old = writeMd(vault, "Brain/notes/old.md", `# Old\n\n${BODY}\n`);
    utimesSync(old, IN_WINDOW, IN_WINDOW);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, cacheEnabled: true });
    await indexVault(config);

    await search(config, { query: OUT_OF_WINDOW_QUERY, limit: 5 });
    await search(config, { query: `${OUT_OF_WINDOW_QUERY} since:30d`, limit: 5 });

    const db = new Database(dbPath);
    try {
      const row = db.query<{ c: number }, []>("SELECT count(*) AS c FROM query_cache").get();
      // Only the windowless query was cached: a relative window resolves to
      // a new absolute signature on every call, so a row per call would be
      // pure growth that can never be served.
      expect(row?.c).toBe(1);
    } finally {
      db.close();
    }
  });
});
