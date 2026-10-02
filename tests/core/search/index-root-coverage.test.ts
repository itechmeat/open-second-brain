/**
 * `indexRootCoverage` partitions the authorized note roots by whether the
 * index holds a document under them. An optional `admit` predicate lets a
 * caller count only the documents it may read, so a root reached solely
 * through pages that caller cannot read answers exactly like an empty one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexRootCoverage, indexVault } from "../../../src/core/search/indexer.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const ROOTS = Object.freeze(["Notes", "Journal", "Empty"]);
const RESERVED_PAGE = "Journal/reserved.md";

describe("indexRootCoverage", () => {
  let config: ResolvedSearchConfig;
  let cleanup: () => void;

  beforeEach(async () => {
    const temp = createTempVault("root-coverage");
    cleanup = temp.cleanup;
    writeMd(temp.vault, "Notes/open.md", "# Open\n\nlattice notes");
    writeMd(
      temp.vault,
      RESERVED_PAGE,
      "---\nvisibility: [private]\n---\n# Reserved\n\nlattice notes",
    );
    config = makeConfig({ vault: temp.vault, dbPath: temp.dbPath });
    await indexVault(config);
  });
  afterEach(() => cleanup());

  test("without an admit predicate every indexed document reaches its root", async () => {
    const coverage = await indexRootCoverage(config, ROOTS);
    expect(coverage.rootsWithDocuments).toEqual(["Notes", "Journal"]);
    expect(coverage.rootsWithoutDocuments).toEqual(["Empty"]);
  });

  test("an admit predicate that rejects every path leaves every root without documents", async () => {
    const coverage = await indexRootCoverage(config, ROOTS, () => false);
    expect(coverage.rootsWithDocuments).toEqual([]);
    expect(coverage.rootsWithoutDocuments).toEqual(["Notes", "Journal", "Empty"]);
  });

  test("admit sees each candidate path with the visibility the index measured for it", async () => {
    const seen = new Map<string, ReadonlyArray<string>>();
    const coverage = await indexRootCoverage(config, ROOTS, (path, indexedTags) => {
      seen.set(path, indexedTags);
      return indexedTags.length === 0;
    });
    expect(coverage.rootsWithDocuments).toEqual(["Notes"]);
    expect(coverage.rootsWithoutDocuments).toEqual(["Journal", "Empty"]);
    expect(seen.get(RESERVED_PAGE)).toEqual(["private"]);
    expect(seen.get("Notes/open.md")).toEqual([]);
  });
});
