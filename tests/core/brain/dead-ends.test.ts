/**
 * Dead-end registry (t_be62c62d): negative knowledge as first-class
 * markdown notes under `Brain/dead-ends/` - what was tried, why it
 * failed, in what context - bounded to the most-recent-N with
 * archive-on-overflow. Markdown-first means FTS indexes the notes
 * with zero search changes, so recall surfaces "avoid X" alongside
 * "prefer Y".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEAD_END_MAX_ACTIVE,
  deadEndsDir,
  listDeadEnds,
  recordDeadEnd,
} from "../../../src/core/brain/dead-ends.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

let vault: string;

const NOW = new Date("2026-06-04T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dead-ends-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function record(approach: string, over: { reason?: string; context?: string; now?: Date } = {}) {
  return recordDeadEnd(vault, {
    approach,
    reason: over.reason ?? "It corrupted the index on concurrent writes",
    ...(over.context !== undefined ? { context: over.context } : {}),
    agent: "claude-dev-agent",
    now: over.now ?? NOW,
  });
}

describe("recordDeadEnd", () => {
  test("writes a markdown note with brain-dead-end frontmatter and sections", () => {
    const { entry } = record("Mutable global cache for the search index", {
      context: "v0.41 indexing rework",
    });
    expect(entry.id).toBe("de-2026-06-04-mutable-global-cache-for-the-search-index");
    const text = readFileSync(entry.path, "utf8");
    expect(text).toContain("kind: brain-dead-end");
    expect(text).toContain("agent: claude-dev-agent");
    expect(text).toContain("## Approach");
    expect(text).toContain("Mutable global cache for the search index");
    expect(text).toContain("## Why it failed");
    expect(text).toContain("corrupted the index");
    expect(text).toContain("## Context");
    expect(text).toContain("v0.41 indexing rework");
  });

  test("same approach on the same day allocates a collision suffix", () => {
    const first = record("Retry loop");
    const second = record("Retry loop");
    expect(first.entry.id).not.toBe(second.entry.id);
    expect(second.entry.id.endsWith("-2")).toBe(true);
  });

  test("empty approach or reason throws", () => {
    expect(() => record("  ")).toThrow();
    expect(() => record("Approach", { reason: " " })).toThrow();
  });

  test("overflow archives the oldest entries", () => {
    for (let i = 0; i < 4; i++) {
      record(`Approach number ${i}`, { now: new Date(`2026-06-0${i + 1}T10:00:00Z`) });
    }
    const result = recordDeadEnd(vault, {
      approach: "The newest approach",
      reason: "Still failed",
      agent: "claude-dev-agent",
      now: new Date("2026-06-05T10:00:00Z"),
      maxActive: 3,
    });
    expect(result.archived.length).toBe(2);
    const active = listDeadEnds(vault);
    expect(active.entries).toHaveLength(3);
    expect(existsSync(join(deadEndsDir(vault), "archive"))).toBe(true);
    const archived = readdirSync(join(deadEndsDir(vault), "archive"));
    expect(archived).toHaveLength(2);
  });

  test("default cap is generous", () => {
    expect(DEAD_END_MAX_ACTIVE).toBeGreaterThanOrEqual(100);
  });
});

describe("listDeadEnds", () => {
  test("returns active entries newest first with parsed fields", () => {
    record("Old approach", { now: new Date("2026-06-01T10:00:00Z") });
    record("New approach", { now: new Date("2026-06-03T10:00:00Z") });
    const { entries } = listDeadEnds(vault);
    expect(entries.map((e) => e.approach)).toEqual(["New approach", "Old approach"]);
    expect(entries[0]!.reason).toContain("corrupted");
    expect(entries[0]!.agent).toBe("claude-dev-agent");
  });

  test("malformed files are skipped fail-closed, never fatal", () => {
    record("Good approach");
    mkdirSync(deadEndsDir(vault), { recursive: true });
    writeFileSync(join(deadEndsDir(vault), "de-2026-06-04-junk.md"), "no frontmatter at all");
    const { entries, warnings } = listDeadEnds(vault);
    expect(entries).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  test("an empty vault lists nothing", () => {
    expect(listDeadEnds(vault).entries).toEqual([]);
  });
});

describe("recall integration", () => {
  test("dead-end notes index into FTS and surface on search", async () => {
    const tmp = createTempVault("dead-end-recall");
    try {
      recordDeadEnd(tmp.vault, {
        approach: "Sharding the quartz ledger by month",
        reason: "Quartz ledger shards desynchronized under Syncthing",
        agent: "claude-dev-agent",
        now: NOW,
      });
      const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath });
      await indexVault(config);
      const outcome = await search(config, { query: "quartz ledger shards" });
      expect(outcome.results.some((r) => r.path.startsWith("Brain/dead-ends/"))).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});
