import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  clearSessionFocus,
  normalizeSessionFocus,
  readActiveSessionFocus,
  readSessionFocus,
  sessionFocusPath,
  writeSessionFocus,
} from "../../../src/core/search/session-focus.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const NOW = 1_750_000_000_000;

let cfg: ResolvedSearchConfig;
let cleanup: () => void;

beforeEach(() => {
  const t = createTempVault("focus-scoped");
  cfg = makeConfig({ vault: t.vault, dbPath: t.dbPath });
  cleanup = t.cleanup;
});

afterEach(() => {
  cleanup();
});

function focus(query: string) {
  return normalizeSessionFocus({ query }, NOW);
}

test("a scoped focus file lives under search-focus/<scope>.json", () => {
  const path = sessionFocusPath(cfg, "sess-1");
  expect(path.endsWith(join("search-focus", "sess-1.json"))).toBe(true);
  expect(dirname(sessionFocusPath(cfg))).toBe(dirname(dirname(path)));
});

test("scoped write/read round-trips without touching the global file", () => {
  writeSessionFocus(cfg, focus("scoped topic"), "sess-1");
  expect(readSessionFocus(cfg, NOW, "sess-1")?.query).toBe("scoped topic");
  expect(readSessionFocus(cfg, NOW)).toBeNull();
  expect(existsSync(sessionFocusPath(cfg))).toBe(false);
});

test("readActiveSessionFocus prefers the session focus over the global one", () => {
  writeSessionFocus(cfg, focus("global topic"));
  writeSessionFocus(cfg, focus("session topic"), "sess-1");
  expect(readActiveSessionFocus(cfg, "sess-1", NOW)?.query).toBe("session topic");
});

test("readActiveSessionFocus falls back to global when the session has none", () => {
  writeSessionFocus(cfg, focus("global topic"));
  expect(readActiveSessionFocus(cfg, "sess-2", NOW)?.query).toBe("global topic");
  expect(readActiveSessionFocus(cfg, undefined, NOW)?.query).toBe("global topic");
});

test("an expired session focus falls back to the global focus", () => {
  writeSessionFocus(cfg, focus("global topic"));
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "stale", ttlMinutes: 1 }, NOW), "sess-1");
  const later = NOW + 10 * 60 * 1000;
  expect(readActiveSessionFocus(cfg, "sess-1", later)?.query).toBe("global topic");
});

test("clearing a scope removes only that scope's file", () => {
  writeSessionFocus(cfg, focus("global topic"));
  writeSessionFocus(cfg, focus("one"), "sess-1");
  writeSessionFocus(cfg, focus("two"), "sess-2");
  clearSessionFocus(cfg, "sess-1");
  expect(readSessionFocus(cfg, NOW, "sess-1")).toBeNull();
  expect(readSessionFocus(cfg, NOW, "sess-2")?.query).toBe("two");
  expect(readSessionFocus(cfg, NOW)?.query).toBe("global topic");
});

test("a raw session id is normalised to its scope slug", () => {
  writeSessionFocus(cfg, focus("normalised"), "My Session #42");
  expect(readSessionFocus(cfg, NOW, "my-session-42")?.query).toBe("normalised");
  expect(readActiveSessionFocus(cfg, "My Session #42", NOW)?.query).toBe("normalised");
});
