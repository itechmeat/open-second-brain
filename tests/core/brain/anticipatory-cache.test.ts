/**
 * Anticipatory Brain context cache
 * (continuity-hygiene-freshness suite, Task 6; kanban t_4cee9df5).
 *
 * The cache keeps a small, inspectable, turn-specific context pack
 * warm while an agent works: refreshed from existing hook events (no
 * daemon, no watcher), debounced by TTL with an injected clock, written
 * atomically, keyed by the lineage root. Reads return the warm cache
 * or fall back to a live pack, always reporting `cache_state`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { recordLineageObservation } from "../../../src/core/brain/lineage/ledger.ts";
import {
  anticipatoryCachePath,
  readAnticipatoryContext,
  refreshAnticipatoryCache,
} from "../../../src/core/brain/anticipatory-cache.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-anticipatory-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const T0 = new Date("2026-06-10T12:00:00Z");

describe("refreshAnticipatoryCache", () => {
  test("writes a cache keyed by the lineage root", () => {
    recordLineageObservation(vault, {
      sessionId: "child-1",
      at: T0.toISOString(),
      event: "SessionStart",
      lineage: { rootId: "root-1", parentId: "root-1", depth: 1, source: "payload" },
    });
    const result = refreshAnticipatoryCache(vault, {
      sessionId: "child-1",
      signalText: "debugging the indexer",
      now: T0,
    });
    expect(result.refreshed).toBe(true);
    expect(result.rootSessionId).toBe("root-1");
    const raw = JSON.parse(readFileSync(anticipatoryCachePath(vault, "root-1"), "utf8")) as {
      schema: string;
      root_session_id: string;
    };
    expect(raw.schema).toBe("o2b.anticipatory.v1");
    expect(raw.root_session_id).toBe("root-1");
  });

  test("debounces by TTL with the injected clock", () => {
    const first = refreshAnticipatoryCache(vault, { sessionId: "s-1", now: T0 });
    expect(first.refreshed).toBe(true);
    const second = refreshAnticipatoryCache(vault, {
      sessionId: "s-1",
      now: new Date(T0.getTime() + 30_000),
      ttlSeconds: 120,
    });
    expect(second.refreshed).toBe(false);
    const third = refreshAnticipatoryCache(vault, {
      sessionId: "s-1",
      now: new Date(T0.getTime() + 121_000),
      ttlSeconds: 120,
    });
    expect(third.refreshed).toBe(true);
  });

  test("distinct roots that sanitize identically never share a cache file", () => {
    const pathA = anticipatoryCachePath(vault, "a/b");
    const pathB = anticipatoryCachePath(vault, "a:b");
    expect(pathA).not.toBe(pathB);
    const longA = anticipatoryCachePath(vault, "x".repeat(150) + "A");
    const longB = anticipatoryCachePath(vault, "x".repeat(150) + "B");
    expect(longA).not.toBe(longB);
  });

  test("a token-budget change bypasses the TTL debounce and is never served warm", () => {
    refreshAnticipatoryCache(vault, { sessionId: "s-budget", now: T0, maxTokens: 2000 });
    const rebuilt = refreshAnticipatoryCache(vault, {
      sessionId: "s-budget",
      now: new Date(T0.getTime() + 5_000),
      maxTokens: 500,
    });
    expect(rebuilt.refreshed).toBe(true);
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-budget",
      now: new Date(T0.getTime() + 10_000),
      maxTokens: 4000,
    });
    expect(read.cache_state).not.toBe("warm");
  });

  test("sanitizes hostile session ids into safe cache filenames", () => {
    const result = refreshAnticipatoryCache(vault, { sessionId: "../../etc/passwd", now: T0 });
    expect(result.refreshed).toBe(true);
    const path = anticipatoryCachePath(vault, "../../etc/passwd");
    expect(path).toContain(join("Brain", ".state", "anticipatory"));
    expect(path.includes("..")).toBe(false);
  });
});

describe("readAnticipatoryContext", () => {
  test("returns the warm cache inside the TTL", () => {
    refreshAnticipatoryCache(vault, { sessionId: "s-2", signalText: "warm topic", now: T0 });
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-2",
      now: new Date(T0.getTime() + 10_000),
      ttlSeconds: 120,
    });
    expect(read.cache_state).toBe("warm");
    expect(read.generated_at).toBe(T0.toISOString());
    expect(Array.isArray(read.context.items)).toBe(true);
  });

  test("falls back to a live pack on miss", () => {
    const read = readAnticipatoryContext(vault, { sessionId: "never-cached", now: T0 });
    expect(read.cache_state).toBe("miss");
    expect(Array.isArray(read.context.items)).toBe(true);
  });

  test("falls back to a live pack when the cache is stale", () => {
    refreshAnticipatoryCache(vault, { sessionId: "s-3", now: T0 });
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-3",
      now: new Date(T0.getTime() + 10 * 60_000),
      ttlSeconds: 120,
    });
    expect(read.cache_state).toBe("stale");
  });

  test("treats a corrupt cache file as a miss instead of throwing", () => {
    const path = anticipatoryCachePath(vault, "s-4");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-json", "utf8");
    const read = readAnticipatoryContext(vault, { sessionId: "s-4", now: T0 });
    expect(read.cache_state).toBe("miss");
  });
});

describe("hook integration", () => {
  test("a UserPromptSubmit lifecycle event warms the cache fail-soft", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "hook-1",
        cwd: "/work",
        prompt: "plain prompt with no markers",
      },
      { agent: "tester", now: T0 },
    );
    const read = readAnticipatoryContext(vault, { sessionId: "hook-1", now: T0 });
    expect(read.cache_state).toBe("warm");
  });

  test("dry runs never write the cache", async () => {
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "hook-2",
        cwd: "/work",
        prompt: "plain prompt",
      },
      { agent: "tester", now: T0, dryRun: true },
    );
    const read = readAnticipatoryContext(vault, { sessionId: "hook-2", now: T0 });
    expect(read.cache_state).toBe("miss");
  });
});
