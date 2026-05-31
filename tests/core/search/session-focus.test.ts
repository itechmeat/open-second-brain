import { expect, test } from "bun:test";

import {
  normalizeSessionFocus,
  sessionFocusIsActive,
} from "../../../src/core/search/session-focus.ts";

const NOW = 1_750_000_000_000;

test("normalizeSessionFocus trims query and path with bounded ttl", () => {
  const focus = normalizeSessionFocus(
    { query: "  release decision  ", pathPrefix: " Sessions/May/ ", ttlMinutes: 30 },
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
