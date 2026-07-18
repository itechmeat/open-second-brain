/**
 * Conversation chronology (S1 / t_347e8224): the `authored_at` frontmatter
 * instant is carried into the indexed document and exposed on search
 * results, and drives the exact hybrid-score recency tie-break end to end.
 * A document with no `authored_at` is unchanged (no field on its result).
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

test("exact-score ties surface the more recent authored_at first end to end", async () => {
  // Two documents with identical searchable content → tied relevance; only
  // authored_at distinguishes them. The newer one must lead.
  writeMd(vault, "Brain/inbox/sig-old.md", signalMd("2026-01-01T00:00:00Z", "tie"));
  writeMd(vault, "Brain/inbox/sig-new.md", signalMd("2026-06-01T00:00:00Z", "tie"));
  // Pin identical storage mtimes so the recency boost is equal and the
  // only distinguishing signal on the exact tie is authored_at.
  const when = new Date("2026-06-15T00:00:00Z");
  utimesSync(join(vault, "Brain/inbox/sig-old.md"), when, when);
  utimesSync(join(vault, "Brain/inbox/sig-new.md"), when, when);
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token tie", limit: 5 });
  const tied = outcome.results.filter((r) => r.path.startsWith("Brain/inbox/sig-"));
  expect(tied.length).toBe(2);
  expect(tied[0]!.score).toBeCloseTo(tied[1]!.score, 6);
  expect(tied[0]!.path).toBe("Brain/inbox/sig-new.md");
});
