/**
 * Conversation chronology (S1 / t_347e8224): the `authored_at` frontmatter
 * instant is carried into the indexed document and exposed on search
 * results, and drives the exact hybrid-score recency tie-break end to end.
 * A document with no `authored_at` is unchanged (no field on its result).
 *
 * Re-derived under D1, which made that same instant the FRESHNESS anchor.
 * The tie-break test here previously asserted an exact score tie between
 * two notes with equal mtime and different instants; D1 removed the
 * construction that produced it, and the pair now separates on score.
 * Two tests replace it: one for the freshness prior itself, and one for
 * the tie-break, in the configuration that still reaches it. Both build
 * their instants RELATIVE to the wall clock, because the old absolute
 * dates would have drifted across the decay curve as the calendar moved
 * and turned this file into a slow flake.
 *
 * What this file deliberately does not cover: the ingestion paths that
 * write `authored_at` in the first place (session import and the inbox
 * backfill). It writes the frontmatter by hand and starts at the indexer.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("authored-at");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function signalMd(authoredAt: string | null, marker: string): string {
  const fm = [
    "---",
    "kind: brain-signal",
    "source_type: session",
    ...(authoredAt !== null ? [`authored_at: ${authoredAt}`] : []),
    "---",
    "",
    `# Turn ${marker}`,
    "",
    `The operator discussed chronology token ${marker} in this turn.`,
    "",
  ];
  return fm.join("\n");
}

test("authored_at is carried into the index and exposed on search results", async () => {
  writeMd(vault, "Brain/inbox/sig-a.md", signalMd("2026-05-20T10:00:00Z", "alpha"));
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token alpha", limit: 5 });
  const hit = outcome.results.find((r) => r.path === "Brain/inbox/sig-a.md");
  expect(hit).toBeDefined();
  expect(hit!.authoredAt).toBe(Math.floor(Date.parse("2026-05-20T10:00:00Z") / 1000));
});

test("a document without authored_at exposes no authoredAt field (byte-identical shape)", async () => {
  writeMd(vault, "Brain/inbox/sig-plain.md", signalMd(null, "beta"));
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token beta", limit: 5 });
  const hit = outcome.results.find((r) => r.path === "Brain/inbox/sig-plain.md");
  expect(hit).toBeDefined();
  expect(hit!.authoredAt).toBeUndefined();
  expect("authoredAt" in hit!).toBe(false);
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An ISO instant `days` before now. Relative, so a fixture cannot drift
 * across the decay curve as the calendar advances.
 */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Both notes written into the vault in this instant: maximal storage freshness. */
function pinMtimeNow(...paths: ReadonlyArray<string>): void {
  const now = new Date();
  for (const p of paths) utimesSync(join(vault, p), now, now);
}

test("freshness follows the turn instant, not the day the vault wrote the file (D1)", async () => {
  // Identical searchable content and identical mtime - the storage clock
  // calls both maximally fresh. Only the turn instants differ, and they
  // are what the freshness prior must answer to.
  writeMd(vault, "Brain/inbox/sig-stale.md", signalMd(isoDaysAgo(400), "drift"));
  writeMd(vault, "Brain/inbox/sig-fresh.md", signalMd(isoDaysAgo(3), "drift"));
  pinMtimeNow("Brain/inbox/sig-stale.md", "Brain/inbox/sig-fresh.md");
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token drift", limit: 5 });
  const hits = outcome.results.filter((r) => r.path.startsWith("Brain/inbox/sig-"));
  expect(hits.length).toBe(2);
  expect(hits[0]!.path).toBe("Brain/inbox/sig-fresh.md");
  // The three-day-old turn keeps its boost; the year-old turn has decayed
  // past the epsilon floor to nothing, however new its file is.
  expect(hits[0]!.recencyBoost).toBeGreaterThan(0);
  expect(hits[1]!.recencyBoost).toBe(0);
  // Ordering here is settled by the score, one level above the tie-break.
  expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
});

test("exact-score ties surface the more recent authored_at first end to end", async () => {
  // The tie-break rung, in the configuration D1 leaves it reachable in:
  // both turn instants are far enough past the epsilon floor that they
  // decay to exactly 0, so the freshness prior separates nothing and the
  // ladder below the score is what orders the pair. Identical content and
  // identical mtime make the rest of the composite equal.
  writeMd(vault, "Brain/inbox/sig-old.md", signalMd(isoDaysAgo(600), "tie"));
  writeMd(vault, "Brain/inbox/sig-new.md", signalMd(isoDaysAgo(500), "tie"));
  pinMtimeNow("Brain/inbox/sig-old.md", "Brain/inbox/sig-new.md");
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token tie", limit: 5 });
  const tied = outcome.results.filter((r) => r.path.startsWith("Brain/inbox/sig-"));
  expect(tied.length).toBe(2);
  // The premise, asserted: neither row carries a freshness contribution.
  expect(tied[0]!.recencyBoost).toBe(0);
  expect(tied[1]!.recencyBoost).toBe(0);
  expect(tied[0]!.score).toBe(tied[1]!.score);
  expect(tied[0]!.path).toBe("Brain/inbox/sig-new.md");
});
