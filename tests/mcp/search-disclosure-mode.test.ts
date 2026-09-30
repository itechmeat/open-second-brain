/**
 * MCP `disclosure` on `brain_search`: the result-depth modes come from one
 * vocabulary, the schema enum is that list, and any refused value - however
 * long or whatever its type - is INVALID_PARAMS naming the accepted modes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DISCLOSURE_MODE,
  DISCLOSURE_MODES,
} from "../../src/core/search/disclosure-mode.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

let tmp: string;
let ctx: ServerContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-disclosure-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeMd(vault, "Brain/notes/lair.md", "# Lair\n\nA chimera sleeps in the lair.");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface SearchResponse {
  readonly results: ReadonlyArray<unknown>;
  readonly cards?: ReadonlyArray<unknown>;
}

async function run(args: Record<string, unknown>): Promise<SearchResponse> {
  return (await tool.handler(ctx, args)) as unknown as SearchResponse;
}

describe("disclosure mode vocabulary", () => {
  test("full is the default", () => {
    expect(DEFAULT_DISCLOSURE_MODE).toBe("full");
  });
});

describe("brain_search disclosure", () => {
  test("the schema declares the public full|cards enum", () => {
    const schema = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(schema["disclosure"]?.enum).toEqual(["full", "cards"]);
  });

  test("cards returns layer-1 cards instead of full results", async () => {
    const out = await run({ query: "chimera", disclosure: "cards" });
    expect(out.results).toEqual([]);
    expect(out.cards?.length).toBeGreaterThan(0);
  });

  test("any refused value, however long or typed, names the accepted modes", async () => {
    const refusal = `argument 'disclosure' must be one of ${DISCLOSURE_MODES.join(", ")}`;
    const errors = await Promise.all(
      ["x".repeat(40), "sometimes", 7].map((bad) =>
        run({ query: "chimera", disclosure: bad }).then(
          () => null,
          (exc: unknown) => exc,
        ),
      ),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(MCPError);
      expect((error as Error).message).toContain(refusal);
    }
  });
});
