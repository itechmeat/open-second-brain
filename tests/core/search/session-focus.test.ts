import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  normalizeSessionFocus,
  readSessionFocus,
  sessionFocusPath,
  sessionFocusIsActive,
} from "../../../src/core/search/session-focus.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

const NOW = 1_750_000_000_000;

test("normalizeSessionFocus trims query and path with bounded ttl", () => {
  const focus = normalizeSessionFocus(
    {
      query: "  release decision  ",
      pathPrefix: " Sessions/May/ ",
      ttlMinutes: 30,
    },
    NOW,
  );

  expect(focus.query).toBe("release decision");
  expect(focus.pathPrefix).toBe("Sessions/May/");
  expect(focus.expiresAt).toBe(NOW + 30 * 60 * 1000);
  expect(sessionFocusIsActive(focus, NOW)).toBe(true);
});

test("sessionFocusIsActive rejects expired focus", () => {
  const focus = normalizeSessionFocus({ query: "alpha", ttlMinutes: 1 }, NOW);

  expect(sessionFocusIsActive(focus, NOW + 61_000)).toBe(false);
});

test("readSessionFocus treats malformed persisted focus as missing", () => {
  const temp = createTempVault("session-focus");
  try {
    const config = makeConfig({ vault: temp.vault, dbPath: temp.dbPath });
    const path = sessionFocusPath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ query: " alpha ", expiresAt: "forever" }));

    expect(readSessionFocus(config, NOW)).toBeNull();
  } finally {
    temp.cleanup();
  }
});
