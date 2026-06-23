/**
 * Progressive 3-layer disclosure for the general vault search
 * (search → expand → transcript), the contract session-recall already
 * ships lifted up to the main recall surface.
 *
 * Layer 1 — `search(..., { disclosure: "cards" })` returns compact cards
 *   (path/title/score/reasons/snippet/pointer), never full content.
 * Layer 2 — `expandHit` returns the fuller note (the document's chunks
 *   reconstructed from the store).
 * Layer 3 — `expandHit` returns the raw chunk transcript, paginated by a
 *   cursor, exactly like `expandSessionRecall`.
 *
 * The default (`disclosure` absent) path stays byte-identical to the
 * pre-change full-content search, and expand reuses the existing store
 * read — it never rebuilds or writes the index.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";

import { expandHit, indexVault, search, SearchError } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault, writeMd } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(async () => {
  tmp = createTempVault("disclosure");
  // A note long enough to split into several chunks (> the 800-token
  // budget), so layer-3 raw pagination has more than one page to walk.
  const body = Array.from(
    { length: 260 },
    (_, i) => `Paragraph ${i} discusses the migration plan and rollback strategy in detail.`,
  ).join("\n\n");
  writeMd(
    tmp.vault,
    "notes/migration.md",
    `---\ntitle: Migration Plan\n---\n\n# Migration\n\n${body}\n`,
  );
  writeMd(
    tmp.vault,
    "notes/rollback.md",
    `---\ntitle: Rollback\n---\n\n# Rollback\n\nThe rollback strategy reverts the migration in one step.\n`,
  );
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  await indexVault(config, {});
});

afterEach(() => {
  tmp.cleanup();
});

function config() {
  return makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
}

test("layer 1: disclosure 'cards' returns compact cards, never full content", async () => {
  const out = await search(config(), {
    query: "migration rollback strategy",
    limit: 10,
    disclosure: "cards",
  });

  expect(out.cards).toBeDefined();
  expect(out.cards!.length).toBeGreaterThan(0);
  // The cards lane is the payload; the heavy `results` array is empty.
  expect(out.results.length).toBe(0);
  expect(out.total).toBe(out.cards!.length);

  for (const card of out.cards!) {
    expect(typeof card.chunkId).toBe("number");
    expect(typeof card.documentId).toBe("number");
    expect(typeof card.path).toBe("string");
    expect(Array.isArray(card.reasons)).toBe(true);
    expect(typeof card.snippet).toBe("string");
    // The pointer is a D2 `path:Lstart-Lend` (or `path:Lstart`) form.
    expect(card.pointer).toMatch(/:L\d+(-L\d+)?$/);
    // A card carries a snippet, not the chunk's full content field.
    expect("content" in card).toBe(false);
  }

  // The big note's card snippet is strictly shorter than its full chunk
  // content — token economy is the whole point of the cards lane.
  const full = await search(config(), { query: "migration rollback strategy", limit: 10 });
  const bigResult = full.results.find((r) => r.path === "notes/migration.md");
  const bigCard = out.cards!.find((c) => c.path === "notes/migration.md");
  expect(bigResult).toBeDefined();
  expect(bigCard).toBeDefined();
  expect(bigCard!.snippet.length).toBeLessThan(bigResult!.content.length);
});

test("layer 2 + 3: expandHit returns the fuller note and the paginated raw transcript", async () => {
  const out = await search(config(), {
    query: "migration rollback strategy",
    limit: 10,
    disclosure: "cards",
  });
  const card = out.cards!.find((c) => c.path === "notes/migration.md");
  expect(card).toBeDefined();

  // First raw page: one chunk only, so the multi-chunk note still has more.
  const first = await expandHit(config(), { chunkId: card!.chunkId, rawLimit: 1 });

  // Layer 2 — the fuller note.
  expect(first.note.path).toBe("notes/migration.md");
  expect(first.note.title).toBe("Migration Plan");
  expect(first.note.content.length).toBeGreaterThan(card!.snippet.length);
  expect(first.note.content).toContain("migration");
  expect(first.note.pointer).toMatch(/:L\d+(-L\d+)?$/);

  // Layer 3 — the raw chunk transcript, paginated.
  expect(first.raw_content.length).toBe(1);
  expect(typeof first.raw_content[0]!.content).toBe("string");
  expect(first.raw_content[0]!.pointer).toMatch(/:L\d+(-L\d+)?$/);
  expect(first.next_cursor).not.toBeNull();

  // Walking the cursor yields the next raw chunk.
  const second = await expandHit(config(), {
    chunkId: card!.chunkId,
    rawLimit: 1,
    cursor: first.next_cursor!,
  });
  expect(second.raw_content.length).toBe(1);
  expect(second.raw_content[0]!.chunkId).not.toBe(first.raw_content[0]!.chunkId);
});

test("expandHit on an unknown chunk fails with INVALID_INPUT", async () => {
  await expect(expandHit(config(), { chunkId: 999_999 })).rejects.toThrow(SearchError);
});

test("bit-identity: default (no disclosure) output is unchanged full-content search", async () => {
  const implicitFull = await search(config(), { query: "migration rollback strategy", limit: 10 });
  const explicitFull = await search(config(), {
    query: "migration rollback strategy",
    limit: 10,
    disclosure: "full",
  });

  // No cards lane on the default path, and the result rows carry full content.
  expect("cards" in implicitFull).toBe(false);
  expect(implicitFull.results.length).toBeGreaterThan(0);
  expect(implicitFull.results[0]!.content.length).toBeGreaterThan(0);

  // Implicit-default and explicit-'full' are the same search. The score's
  // recency layer folds in Date.now(), which drifts by microseconds
  // between two live calls, so compare the stable identity/content/order
  // projection rather than the raw floats.
  const stable = (o: typeof implicitFull) =>
    o.results.map((r) => ({
      path: r.path,
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      content: r.content,
      startLine: r.startLine,
      endLine: r.endLine,
      searchType: r.searchType,
    }));
  expect(stable(explicitFull)).toEqual(stable(implicitFull));
  expect("cards" in explicitFull).toBe(false);
});

test("expand reuses the existing store read — no index rebuild, no new index file", async () => {
  const out = await search(config(), {
    query: "migration rollback strategy",
    limit: 10,
    disclosure: "cards",
  });
  const card = out.cards![0]!;

  // The search above built the index; capture its identity, then expand.
  const before = statSync(tmp.dbPath);
  const result = await expandHit(config(), { chunkId: card.chunkId });
  const after = statSync(tmp.dbPath);

  // A rebuild swaps the index file in place (new mtime); a pure read does not.
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
  expect(result.note.documentId).toBe(card.documentId);
});
