import { expect, test } from "bun:test";

import { homeEnv } from "./platform.ts";

// A hook or MCP server spawned with the minimal environment would
// otherwise fall back to freshening every 60 s and start real background
// indexers into temp vaults the test is about to delete.
test("the minimal child environment keeps freshen on read off", () => {
  expect(homeEnv("/tmp/h")["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"]).toBe("0");
});

// The same environment would otherwise start a real store migration worker
// on every legacy fixture vault a spawned hook or server start meets.
test("the minimal child environment keeps the automatic store migration off", () => {
  expect(homeEnv("/tmp/h")["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"]).toBe("false");
});
