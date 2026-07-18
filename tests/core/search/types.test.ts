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

test("SearchError exposes optional status and retryAfterMs fields", () => {
  const err = new SearchError("EMBEDDING_QUOTA_EXHAUSTED", "billing exhausted", {
    status: 402,
    retryAfterMs: 5000,
  });
  expect(err.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(err.status).toBe(402);
  expect(err.retryAfterMs).toBe(5000);
});

test("SearchError leaves status and retryAfterMs undefined for the two-arg form", () => {
  const err = new SearchError("INDEX_MISSING", "no index");
  expect(err.status).toBeUndefined();
  expect(err.retryAfterMs).toBeUndefined();
});
