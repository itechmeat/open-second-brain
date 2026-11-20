/**
 * MCP error mapping (Task C2). An exhausted embedding quota surfaces to MCP
 * callers as the actionable billing message rather than a generic provider
 * failure.
 */

import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchErrorToMcp } from "../../src/mcp/search-tools.ts";
import {
  EMBEDDING_QUOTA_MESSAGE,
  SEARCH_ERROR_CODES,
  SearchError,
} from "../../src/core/search/types.ts";
import {
  IndexBuildingError,
  IndexBuildStartFailedError,
} from "../../src/core/search/build-progress.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

test("EMBEDDING_QUOTA_EXHAUSTED maps to the actionable billing message", () => {
  const mcp = searchErrorToMcp(new SearchError("EMBEDDING_QUOTA_EXHAUSTED", "internal detail"));
  expect(mcp.code).toBe(INTERNAL_ERROR);
  expect(mcp.message).toBe(EMBEDDING_QUOTA_MESSAGE);
});

test("a generic provider HTTP error keeps its own message", () => {
  const mcp = searchErrorToMcp(new SearchError("EMBEDDING_PROVIDER_HTTP", "embedding HTTP 500"));
  expect(mcp.message).toContain("embedding HTTP 500");
});

test("an index being built says so, not to run the command that would queue behind it", () => {
  const err = new IndexBuildingError("/state/index/brain.sqlite", {
    pid: process.pid,
    token: "t0",
    startedAt: new Date().toISOString(),
    phase: "notes",
    storeStartedAt: null,
    storeDoneAt: null,
    storeBytesDone: 0,
    storeBytesTotal: 0,
    storeRecords: 0,
  });
  const mcp = searchErrorToMcp(err);
  expect(mcp.code).toBe(INTERNAL_ERROR);
  expect(mcp.message).toBe(err.message);
  expect(mcp.message).toStartWith("the search index is being built (started");
  expect(mcp.message).not.toContain("Run: o2b search index");
  expect(mcp.data).toEqual({ code: "INDEX_MISSING" });
});

// ----- the SearchError code reaches the wire ---------------------------------

test("every SearchError code rides in data.code, verbatim", () => {
  for (const code of SEARCH_ERROR_CODES) {
    const mcp = searchErrorToMcp(new SearchError(code, "detail"));
    expect(mcp.data).toEqual({ code });
  }
});

test("the carried code leaves the numeric code and the message unchanged", () => {
  const invalid = searchErrorToMcp(new SearchError("INVALID_INPUT", "bad input"));
  expect(invalid.code).toBe(INVALID_PARAMS);
  expect(invalid.message).toBe("bad input");
  const quota = searchErrorToMcp(new SearchError("EMBEDDING_QUOTA_EXHAUSTED", "internal detail"));
  expect(quota.code).toBe(INTERNAL_ERROR);
  expect(quota.message).toBe(EMBEDDING_QUOTA_MESSAGE);
});

test("the fallback arm keeps its legacy [CODE] suffix beside the carried code", () => {
  const mcp = searchErrorToMcp(new SearchError("SCHEMA_MISMATCH", "index schema is stale"));
  expect(mcp.code).toBe(INTERNAL_ERROR);
  expect(mcp.message).toBe("index schema is stale [SCHEMA_MISMATCH]");
  expect(mcp.data).toEqual({ code: "SCHEMA_MISMATCH" });
});

test("the session-grep time bounds carry the SearchError code too", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "o2b-search-error-"));
  try {
    const vault = join(scratch, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const ctx: ServerContext = { vault, configPath: null, repoRoot: null };
    const grep = findTool(buildToolTable("full"), "brain_session_grep");
    let thrown: unknown;
    try {
      await grep.handler(ctx, { query: "needle", since: "2026-05-02", before: "2026-05-01" });
    } catch (exc) {
      thrown = exc;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    const err = thrown as MCPError;
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toBe("'since' must not be after 'until'");
    expect(err.data).toEqual({ code: "INVALID_INPUT" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a background build that could not be started says so and names the command", () => {
  const err = new IndexBuildStartFailedError("/state/index/brain.sqlite", "spawn ENOENT");
  const mcp = searchErrorToMcp(err);
  expect(mcp.message).toBe(err.message);
  expect(mcp.message).toContain("could not be started (spawn ENOENT)");
  expect(mcp.message).toContain("o2b search reindex");
  expect(mcp.data).toEqual({ code: "INDEX_MISSING" });
});
