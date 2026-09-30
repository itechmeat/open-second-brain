/**
 * MCP `match_mode` on `brain_search` (t_c5326ece): the enum is validated at
 * the boundary - anything but `all` / `any` is INVALID_PARAMS - and a valid
 * `any` actually widens the keyword lane instead of being dropped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { FTS_MATCH_MODES } from "../../src/core/search/fts-match-mode.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

let tmp: string;
let vault: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-match-mode-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeMd(vault, "Brain/notes/both.md", "# Both\n\nchimera basilisk together in one lair.");
  writeMd(vault, "Brain/notes/one.md", "# One\n\nA lone chimera wanders here.");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface SearchResponse {
  readonly results: ReadonlyArray<{ readonly path: string }>;
}

async function run(args: Record<string, unknown>): Promise<SearchResponse> {
  return (await tool.handler(ctx, args)) as unknown as SearchResponse;
}

describe("brain_search match_mode", () => {
  test("the schema declares the public all|any enum", () => {
    const schema = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(schema["match_mode"]?.enum).toEqual(["all", "any"]);
  });

  test("any reaches the keyword lane and keeps the single-term document", async () => {
    const widened = await run({ query: "chimera basilisk", limit: 10, match_mode: "any" });
    expect(widened.results.some((h) => h.path.includes("one.md"))).toBe(true);
  });

  test.each([["sometimes"], ["x".repeat(40)], [7]])(
    "match_mode %p is INVALID_PARAMS naming the accepted modes",
    async (bad) => {
      let thrown: unknown = null;
      try {
        await run({ query: "chimera", match_mode: bad });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MCPError);
      expect((thrown as MCPError).code).toBe(INVALID_PARAMS);
      expect((thrown as MCPError).message).toContain(
        `must be one of ${FTS_MATCH_MODES.join(", ")}`,
      );
    },
  );
});
