/**
 * Tests for §E.2 — `indexCheck` populates the `recommendations`
 * array per the design doc table. Driven through `makeConfig` so
 * the test never mutates real CLI state.
 *
 * Platform-specific branches (`process.platform === "darwin"`) are
 * exercised by re-defining `process.platform` for the duration of
 * the test and restoring after. The override is local and
 * synchronous so it cannot leak between tests on the same worker.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexCheck } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: p,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  const v = createTempVault("indexer-recs");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  cleanup();
});

test("semantic disabled → no recommendations", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const r = await indexCheck(cfg);
  expect(r.recommendations).toEqual([]);
});

test("semantic enabled, no key → recipe mentions the env var and the provider", async () => {
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: { enabled: true, apiKey: null, model: "text-embedding-3-small" },
  });
  const r = await indexCheck(cfg);
  expect(
    r.recommendations.some((s) => s.includes("OPEN_SECOND_BRAIN_EMBEDDING_KEY")),
  ).toBe(true);
  expect(
    r.recommendations.some((s) => s.includes("text-embedding-3-small")),
  ).toBe(true);
});

test("vec unavailable on Darwin → brew sqlite recipe", async () => {
  setPlatform("darwin");
  // Force the vec branch by enabling semantic without a key — `vec`
  // load is attempted regardless of the key.
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: { enabled: true, apiKey: null },
  });
  const r = await indexCheck(cfg);
  // Vec may load if sqlite-vec is genuinely installed on the test
  // host. The Darwin recommendation only appears when vec didn't
  // load — assert conditional on the report's own field.
  if (r.vecExtension === "unavailable") {
    expect(
      r.recommendations.some((s) => s.includes("brew install sqlite")),
    ).toBe(true);
  }
});

test("vec unavailable on Linux → bun pm hint, no brew mention", async () => {
  setPlatform("linux");
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: { enabled: true, apiKey: null },
  });
  const r = await indexCheck(cfg);
  if (r.vecExtension === "unavailable") {
    expect(
      r.recommendations.some((s) => s.includes("bun pm ls")),
    ).toBe(true);
    expect(
      r.recommendations.every((s) => !s.includes("brew install")),
    ).toBe(true);
  }
});

test("Recommendations array is frozen at the top level", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const r = await indexCheck(cfg);
  expect(Object.isFrozen(r.recommendations)).toBe(true);
});
