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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { recordLineageObservation } from "../../../src/core/brain/lineage/ledger.ts";
import {
  ANTICIPATORY_SCHEMA_VERSION,
  anticipatoryCachePath,
  readAnticipatoryContext,
  refreshAnticipatoryCache,
} from "../../../src/core/brain/anticipatory-cache.ts";
import { PACK_STAMP_FIELD } from "../../../src/core/brain/pack-stamp.ts";

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
    // A literal, not the constant: comparing the constant to itself is a
    // tautology that can never catch an unintended schema-token change.
    expect(raw.schema).toBe("o2b.anticipatory.v2");
    expect(ANTICIPATORY_SCHEMA_VERSION).toBe("o2b.anticipatory.v2");
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

describe("provenance stamp and validity window", () => {
  function writePref(slug: string, body: string, mtimeSeconds: number): void {
    const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        "---",
        `id: pref-${slug}`,
        `topic: ${slug}`,
        "principle: p",
        "tier: core",
        "---",
        "",
        body,
      ].join("\n"),
    );
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  }

  test("the cache records the pack's stamp", () => {
    writePref("stamped", "a body", 1_700_000_000);
    refreshAnticipatoryCache(vault, { sessionId: "s-stamp", now: T0 });
    const raw = JSON.parse(readFileSync(anticipatoryCachePath(vault, "s-stamp"), "utf8")) as Record<
      string,
      unknown
    >;
    const stamp = raw["stamp"] as { tokens: Record<string, string | null>; expires_at: string };
    expect(typeof stamp.tokens[PACK_STAMP_FIELD.brainTree]).toBe("string");
    expect(typeof stamp.expires_at).toBe("string");
  });

  test("editing a Brain note invalidates a warm cache entry and names the reason", () => {
    writePref("edited", "original body", 1_700_000_000);
    refreshAnticipatoryCache(vault, { sessionId: "s-edit", now: T0 });
    expect(
      readAnticipatoryContext(vault, { sessionId: "s-edit", now: new Date(T0.getTime() + 5_000) })
        .cache_state,
    ).toBe("warm");

    writePref("edited", "a rewritten body of a different length", 1_700_000_500);
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-edit",
      now: new Date(T0.getTime() + 6_000),
    });
    expect(read.cache_state).toBe("miss");
    expect(read.cache_refusal).toBeDefined();
    expect(read.cache_refusal!).toContain(PACK_STAMP_FIELD.brainTree);
  });

  test("a refused entry is served warm again once it is rebuilt", () => {
    writePref("rebuilt", "original body", 1_700_000_000);
    refreshAnticipatoryCache(vault, { sessionId: "s-rebuild", now: T0 });
    writePref("rebuilt", "a rewritten body of a different length", 1_700_000_500);
    const refused = readAnticipatoryContext(vault, {
      sessionId: "s-rebuild",
      now: new Date(T0.getTime() + 6_000),
    });
    expect(refused.cache_state).toBe("miss");

    // The drifted entry must not survive the TTL debounce: a refresh
    // inside the debounce window still rebuilds, because the stamp -
    // not the clock - is the primary invalidator.
    const refreshed = refreshAnticipatoryCache(vault, {
      sessionId: "s-rebuild",
      now: new Date(T0.getTime() + 7_000),
    });
    expect(refreshed.refreshed).toBe(true);
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-rebuild",
      now: new Date(T0.getTime() + 8_000),
    });
    expect(read.cache_state).toBe("warm");
    expect(read.cache_refusal).toBeUndefined();
  });

  test("an expired validity window is refused rather than served, naming the expiry", () => {
    writePref("expiring", "a body", 1_700_000_000);
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8") +
        "\nintegrity:\n  pack_validity_seconds: 60\n",
    );
    refreshAnticipatoryCache(vault, { sessionId: "s-expire", now: T0, ttlSeconds: 3_600 });
    const read = readAnticipatoryContext(vault, {
      sessionId: "s-expire",
      now: new Date(T0.getTime() + 61_000),
      ttlSeconds: 3_600,
    });
    expect(read.cache_state).toBe("miss");
    expect(read.cache_refusal).toBeDefined();
    expect(read.cache_refusal!).toContain("2026-06-10T12:01:00.000Z");
  });

  test("a cache file written under the previous schema reads as a miss", () => {
    const path = anticipatoryCachePath(vault, "s-legacy");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema: "o2b.anticipatory.v1",
          root_session_id: "s-legacy",
          session_id: "s-legacy",
          generated_at: T0.toISOString(),
          max_tokens: 2_000,
          context: { items: [], session_hits: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const read = readAnticipatoryContext(vault, { sessionId: "s-legacy", now: T0 });
    expect(read.cache_state).toBe("miss");
  });

  test("a cache file with no stamp at all reads as a miss, never as an unstamped hit", () => {
    const path = anticipatoryCachePath(vault, "s-unstamped");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema: ANTICIPATORY_SCHEMA_VERSION,
          root_session_id: "s-unstamped",
          session_id: "s-unstamped",
          generated_at: T0.toISOString(),
          max_tokens: 2_000,
          context: { items: [], session_hits: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const read = readAnticipatoryContext(vault, { sessionId: "s-unstamped", now: T0 });
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

// ----- A4: the cache keys on the ENFORCED scope, not the requested one ----

describe("owner scope in the cache key", () => {
  /**
   * The two writers that warm the cache (the session-lifecycle hook and
   * `o2b brain anticipate --refresh`) pass no scope; the MCP tool passes
   * one unconditionally, because `coerceAgentScope(ctx, args, true)` falls
   * back to `resolveAgentName`, which always returns a string. Keying the
   * filename on the REQUESTED scope therefore made every MCP read a
   * permanent miss on a default vault, rebuilding a full `packContext` on
   * each call - an observable behaviour change with the gate off.
   */
  test("a hook-warmed cache is warm for a scoped MCP read under the default gate", () => {
    const warmed = refreshAnticipatoryCache(vault, { sessionId: "s-scope", now: T0 });
    expect(warmed.refreshed).toBe(true);

    const read = readAnticipatoryContext(vault, {
      sessionId: "s-scope",
      now: T0,
      agentScope: "agent-a",
    });
    expect(read.cache_state).toBe("warm");
  });

  test("the hook-written path and the scoped read path are the same file", () => {
    const hookPath = anticipatoryCachePath(vault, "root-1");
    expect(anticipatoryCachePath(vault, "root-1", "agent-a")).toBe(hookPath);
    expect(anticipatoryCachePath(vault, "root-1", "agent-b")).toBe(hookPath);
  });

  test("a second scoped read does not rebuild what the first one already had", () => {
    refreshAnticipatoryCache(vault, { sessionId: "s-twice", now: T0 });
    for (const scope of ["agent-a", "agent-b"]) {
      expect(
        readAnticipatoryContext(vault, { sessionId: "s-twice", now: T0, agentScope: scope })
          .cache_state,
      ).toBe("warm");
    }
  });
});
