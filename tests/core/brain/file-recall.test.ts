/**
 * File-context recall (Recall & Working-Memory Quality Suite,
 * t_4f420aca): given a file path, surface prior vault work that mentions
 * it, by querying the existing search index with terms derived
 * structurally from the path. No LLM. A file-size gate skips trivial
 * files, mirroring the mem0 source's >= 1500-byte threshold.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { fileContextRecall, deriveFileQuery } from "../../../src/core/brain/file-recall.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("file-recall"));
});

afterEach(() => {
  cleanup();
});

describe("deriveFileQuery", () => {
  test("derives basename and stem terms structurally", () => {
    const q = deriveFileQuery("src/services/auth-token.ts");
    expect(q).toContain("auth-token.ts");
    expect(q).toContain("auth-token");
    // The parent directory is intentionally excluded (it would AND-suppress hits).
    expect(q).not.toContain("services");
  });

  test("is deterministic and separator-agnostic", () => {
    expect(deriveFileQuery("a/b/c.ts")).toBe(deriveFileQuery("a\\b\\c.ts"));
  });
});

describe("fileContextRecall", () => {
  test("surfaces a note that documents prior work on the file", async () => {
    writeMd(
      vault,
      "Brain/notes/auth-decision.md",
      "# Auth decision\n\nWe refactored auth-token.ts to rotate keys hourly.\n",
    );
    writeMd(vault, "Brain/notes/unrelated.md", "# Unrelated\n\nMarsh cartography notes.\n");
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    await indexVault(config);

    const result = await fileContextRecall(config, { filePath: "src/services/auth-token.ts" });
    expect(result.skipped).toBe(false);
    expect(result.results.some((r) => r.path === "Brain/notes/auth-decision.md")).toBe(true);
  });

  test("skips a file below the size gate with an explicit reason", async () => {
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    await indexVault(config);
    const small = join(vault, "small.ts");
    writeFileSync(small, "x\n");
    const result = await fileContextRecall(config, { filePath: small, minBytes: 1500 });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("below_size_gate");
    expect(result.results).toHaveLength(0);
  });

  test("a file at or above the size gate is not skipped", async () => {
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    await indexVault(config);
    const big = join(vault, "big.ts");
    writeFileSync(big, "x".repeat(2000));
    const result = await fileContextRecall(config, { filePath: big, minBytes: 1500 });
    expect(result.skipped).toBe(false);
  });

  test("no matching prior work returns an empty, non-skipped result", async () => {
    writeMd(vault, "Brain/notes/unrelated.md", "# Unrelated\n\nMarsh cartography notes.\n");
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    await indexVault(config);
    const result = await fileContextRecall(config, {
      filePath: "src/zzz/nonexistent-widget.ts",
    });
    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(0);
  });
});
