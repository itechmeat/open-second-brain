/**
 * Anticipatory cache pruning.
 *
 * Every prompt refreshes `Brain/.state/anticipatory/<key>.json` and
 * nothing used to delete those files: a live install accumulated 3,647
 * entries (305 MB). A refresh that writes now prunes the directory,
 * rate-limited, by age and by a hard count cap, and never removes the
 * entry it just wrote.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshAnticipatoryCache } from "../../../src/core/brain/anticipatory-cache.ts";
import {
  ANTICIPATORY_CACHE_MAX_ENTRIES,
  ANTICIPATORY_CACHE_RETENTION_MS,
  ANTICIPATORY_PRUNE_INTERVAL_MS,
  pruneAnticipatoryCache,
} from "../../../src/core/brain/anticipatory-prune.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { BRAIN_ANTICIPATORY_REL } from "../../../src/core/brain/path-constants.ts";

let vault: string;
let cacheDir: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-anticipatory-prune-"));
  bootstrapBrain(vault);
  cacheDir = join(vault, BRAIN_ANTICIPATORY_REL);
});

afterEach(() => {
  setSystemTime();
  rmSync(vault, { recursive: true, force: true });
});

function plantEntry(name: string, ageMs: number): string {
  const path = join(cacheDir, `${name}.json`);
  writeFileSync(path, "{}\n");
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  return path;
}

function entries(): string[] {
  return readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
}

describe("anticipatory cache pruning", () => {
  test("the first writing refresh prunes without an explicit call", () => {
    // Plant before the directory has ever been pruned.
    mkdirSync(cacheDir, { recursive: true });
    const expired = plantEntry("expired", ANTICIPATORY_CACHE_RETENTION_MS + 60_000);
    const fresh = plantEntry("fresh", 5_000);

    const result = refreshAnticipatoryCache(vault, { sessionId: "s-1", now: new Date() });

    expect(result.refreshed).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("the count cap holds and keeps the newest entries", () => {
    mkdirSync(cacheDir, { recursive: true });
    const extra = 7;
    const total = ANTICIPATORY_CACHE_MAX_ENTRIES + extra;
    // Entry i is i minutes old, all well inside the retention window.
    for (let i = 0; i < total; i++) plantEntry(`e-${String(i).padStart(4, "0")}`, (i + 1) * 60_000);

    const result = refreshAnticipatoryCache(vault, { sessionId: "s-cap", now: new Date() });

    const left = entries();
    expect(left.length).toBe(ANTICIPATORY_CACHE_MAX_ENTRIES);
    expect(existsSync(result.path)).toBe(true);
    // The oldest planted entries went first.
    for (let i = total - extra - 1; i < total; i++) {
      expect(left).not.toContain(`e-${String(i).padStart(4, "0")}.json`);
    }
    expect(left).toContain("e-0000.json");
  });

  test("pruning is rate-limited between writing refreshes", () => {
    refreshAnticipatoryCache(vault, { sessionId: "s-1", now: new Date() });
    const expired = plantEntry("expired", ANTICIPATORY_CACHE_RETENTION_MS + 60_000);

    refreshAnticipatoryCache(vault, { sessionId: "s-2", now: new Date() });

    // Inside the rate-limit window the second write does not scan the directory.
    expect(existsSync(expired)).toBe(true);
    // Once the window has passed, the next writing refresh prunes again.
    const later = new Date(Date.now() + ANTICIPATORY_PRUNE_INTERVAL_MS + 1_000);
    setSystemTime(later);
    refreshAnticipatoryCache(vault, { sessionId: "s-3", now: later });
    expect(existsSync(expired)).toBe(false);
  });

  test("a missing cache directory is not an error", () => {
    expect(pruneAnticipatoryCache(vault)).toEqual({ ran: false, removed: 0 });
  });
});
