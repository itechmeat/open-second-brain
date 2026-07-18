/**
 * MCP error mapping (Task C2). An exhausted embedding quota surfaces to MCP
 * callers as the actionable billing message rather than a generic provider
 * failure.
 */

import { test, expect } from "bun:test";

import { searchErrorToMcp } from "../../src/mcp/search-tools.ts";
import { EMBEDDING_QUOTA_MESSAGE, SearchError } from "../../src/core/search/types.ts";
import { INTERNAL_ERROR } from "../../src/mcp/protocol.ts";

test("EMBEDDING_QUOTA_EXHAUSTED maps to the actionable billing message", () => {
  const mcp = searchErrorToMcp(new SearchError("EMBEDDING_QUOTA_EXHAUSTED", "internal detail"));
  expect(mcp.code).toBe(INTERNAL_ERROR);
  expect(mcp.message).toBe(EMBEDDING_QUOTA_MESSAGE);
});

test("a generic provider HTTP error keeps its own message", () => {
  const mcp = searchErrorToMcp(new SearchError("EMBEDDING_PROVIDER_HTTP", "embedding HTTP 500"));
  expect(mcp.message).toContain("embedding HTTP 500");
});
