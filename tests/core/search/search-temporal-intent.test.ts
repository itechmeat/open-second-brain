/**
 * Query-side temporal intent end to end (t_58fc4720): `search()` detects
 * the window at the query-plan seam, strips the `since:` / `until:`
 * directives from the keyword lane so they bias rather than exclude, and
 * threads the declared event times into the ranker's temporal layer.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { utimesSync } from "node:fs";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
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
});
