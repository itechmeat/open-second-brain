import { test, expect } from "bun:test";
import { SearchError } from "../../../src/core/search/types.ts";

test("SearchError carries a typed code", () => {
  const err = new SearchError("INDEX_MISSING", "no index at /tmp/x");
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("SearchError");
  expect(err.code).toBe("INDEX_MISSING");
  expect(err.message).toBe("no index at /tmp/x");
});

test("SearchError preserves stack trace", () => {
  const err = new SearchError("INVALID_INPUT", "bad");
  expect(err.stack).toContain("SearchError");
});
