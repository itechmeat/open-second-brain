/**
 * Freshen on read at the `search()` seam: a stale index starts one
 * background run and the answer still comes from the index as it is; a
 * read-only open never starts one; an index more than ten minutes old is
 * named on the trail as `index-stale` whatever the freshen setting. The
 * query cache stores answers without that code and the trail gains it at
 * read time, so a cache hit names the index age it is served at.
 *
 * The stale note also carries the measured behind count (t_e4438152):
 * computed only when the note fires, so a fresh index performs no walk;
 * a failed measurement leaves the age alone on the note.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { claimNoteWriteRefresh } from "../../../src/core/brain/notes/index-refresh.ts";
import { indexBehindCount, indexVault } from "../../../src/core/search/indexer.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import {
  INDEX_BEHIND_MEMO_TTL_MS,
  measureIndexBehind,
  search,
} from "../../../src/core/search/search.ts";
import { LAST_INDEXED_AT_STATE_KEY } from "../../../src/core/search/store/state.ts";
import type { SearchOutcome, ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import * as walkerModule from "../../../src/core/search/walker.ts";
import { withIndexStale } from "../../../src/core/search/pipeline/outcome.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let calls: string[][];
let walks = 0;
let failWalk = false;
const realWalkVault = walkerModule.walkVault;

// Count the vault walks every consumer of the shared walker performs,
// and allow a test to fail one, so "no walk" and "null measurement" are
// observed rather than inferred.
mock.module("../../../src/core/search/walker.ts", () => ({
  ...walkerModule,
  walkVault: (config: ResolvedSearchConfig) => {
    if (failWalk) throw new Error("walk refused");
    walks++;
    return realWalkVault(config);
  },
}));

const spawn = (argv: string[]): void => {
  calls.push(argv);
};

beforeEach(async () => {
  const v = createTempVault("freshen-search");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  calls = [];
  writeMd(vault, "notes/heron.md", "# Heron\n\nThe grey heron waits by the river.\n");
  await indexVault(config(60));
});

afterEach(() => {
  failWalk = false;
  cleanup();
});

function config(intervalSeconds: number, cacheEnabled = false): ResolvedSearchConfig {
  return Object.freeze({
    ...makeConfig({ vault, dbPath, cacheEnabled }),
    freshen: { intervalSeconds, embeddings: false, configPath: null },
  });
}

function setIndexAge(seconds: number): void {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE index_state SET value = ? WHERE key = ?").run(
      new Date(Date.now() - seconds * 1000).toISOString(),
      LAST_INDEXED_AT_STATE_KEY,
    );
  } finally {
    db.close();
  }
}

function staleCodes(outcome: Awaited<ReturnType<typeof search>>) {
  return (outcome.retrievalTrail?.degraded ?? []).filter(
    (d) => d.code === RETRIEVAL_DEGRADATION.indexStale,
  );
}

test("a stale index starts one background run and still answers", async () => {
  setIndexAge(300);
  const outcome = await search(config(60), { query: "heron", freshenSpawn: spawn });
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.join(" ")).toContain("search index --vault");
});

test("a fresh index starts nothing", async () => {
  await search(config(60), { query: "heron", freshenSpawn: spawn });
  expect(calls).toHaveLength(0);
});

test("a read-only open never starts a run", async () => {
  setIndexAge(3600);
  await search(config(60), { query: "heron", freshenSpawn: spawn, selfHeal: false });
  expect(calls).toHaveLength(0);
});

test("an index older than ten minutes is named on the trail with its age", async () => {
  setIndexAge(11 * 60);
  const outcome = await search(config(60), { query: "heron", freshenSpawn: spawn });
  const stale = staleCodes(outcome);
  expect(stale).toHaveLength(1);
  expect(stale[0]!.detail?.["ageSeconds"]).toBeGreaterThanOrEqual(660);
});

test("a lag of a couple of minutes is not reported", async () => {
  setIndexAge(120);
  expect(staleCodes(await search(config(60), { query: "heron", freshenSpawn: spawn }))).toEqual([]);
});

test("with freshening off a stale index is still reported but nothing starts", async () => {
  setIndexAge(11 * 60);
  const outcome = await search(config(0), { query: "heron", freshenSpawn: spawn });
  expect(staleCodes(outcome)).toHaveLength(1);
  expect(calls).toHaveLength(0);
});

function cachedPayloads(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ payload: string }, []>("SELECT payload FROM query_cache")
      .all()
      .map((r) => r.payload);
  } finally {
    db.close();
  }
}

/** Mark every cached row, so an answer carrying the mark was a cache hit. */
function markCachedRows(total: number): void {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE query_cache SET payload = json_set(payload, '$.total', ?)").run(total);
  } finally {
    db.close();
  }
}

test("with freshening off a stale-index answer is cached without its stale code", async () => {
  setIndexAge(11 * 60);
  const outcome = await search(config(0, true), { query: "heron", freshenSpawn: spawn });
  expect(staleCodes(outcome)).toHaveLength(1);
  const rows = cachedPayloads();
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toContain(RETRIEVAL_DEGRADATION.indexStale);
});

test("a cache hit over an index that has since gone stale names it", async () => {
  await search(config(0, true), { query: "heron", freshenSpawn: spawn });
  markCachedRows(4242);
  setIndexAge(11 * 60);
  const outcome = await search(config(0, true), { query: "heron", freshenSpawn: spawn });
  expect(outcome.total).toBe(4242);
  expect(staleCodes(outcome)).toHaveLength(1);
  expect(outcome.retrievalTrail?.retrieved).toBe(outcome.results.length);
});

test("a cache hit over a fresh index carries no stale code", async () => {
  setIndexAge(11 * 60);
  await search(config(0, true), { query: "heron", freshenSpawn: spawn });
  markCachedRows(4242);
  setIndexAge(0);
  const outcome = await search(config(0, true), { query: "heron", freshenSpawn: spawn });
  expect(outcome.total).toBe(4242);
  expect(staleCodes(outcome)).toEqual([]);
  expect(outcome.retrievalTrail).toBeUndefined();
});

test("a stale index names the measured behind count beside its age", async () => {
  writeMd(vault, "notes/kestrel.md", "# Kestrel\n\nThe kestrel hovers over the verge.\n");
  setIndexAge(11 * 60);
  const outcome = await search(config(0), { query: "heron", freshenSpawn: spawn });
  const stale = staleCodes(outcome);
  expect(stale).toHaveLength(1);
  expect(stale[0]!.detail?.["behindCount"]).toBe(1);
  expect(stale[0]!.detail?.["ageSeconds"]).toBeGreaterThanOrEqual(660);
});

test("a fresh index emits no stale code and performs no walk", async () => {
  writeMd(vault, "notes/kestrel.md", "# Kestrel\n\nThe kestrel hovers over the verge.\n");
  const before = walks;
  const outcome = await search(config(0), { query: "heron", freshenSpawn: spawn });
  expect(staleCodes(outcome)).toEqual([]);
  expect(walks).toBe(before);
});

test("a stale search performs exactly one walk", async () => {
  setIndexAge(11 * 60);
  const before = walks;
  await search(config(0), { query: "heron", freshenSpawn: spawn });
  expect(walks).toBe(before + 1);
});

test("repeated stale searches inside the behind-count memo window walk once", async () => {
  // Finding 24: on a permanently-stale origin (freshening off here; a
  // read-only cross-vault origin is the other case) every search used to
  // pay the full synchronous stat walk plus a vec-loading store open all
  // over again, forever. Inside the memo window the measurement is
  // reused, so the second stale search walks nothing.
  setIndexAge(11 * 60);
  const before = walks;
  await search(config(0), { query: "heron", freshenSpawn: spawn });
  await search(config(0), { query: "heron", freshenSpawn: spawn });
  expect(walks).toBe(before + 1);
});

test("the behind-count memo serves the TTL window and expires with the injected clock", async () => {
  setIndexAge(11 * 60);
  const before = walks;
  const cfg = config(0);
  const stamp = "2026-06-03T12:00:00.000Z";
  // First measurement under the memo: one walk.
  expect(await measureIndexBehind(cfg, stamp, 1_000_000)).toBe(0);
  expect(walks).toBe(before + 1);
  // Inside the window: served from the memo, no walk.
  expect(await measureIndexBehind(cfg, stamp, 1_000_000 + INDEX_BEHIND_MEMO_TTL_MS - 1)).toBe(0);
  expect(walks).toBe(before + 1);
  // At/after the window: measured again.
  expect(await measureIndexBehind(cfg, stamp, 1_000_000 + INDEX_BEHIND_MEMO_TTL_MS)).toBe(0);
  expect(walks).toBe(before + 2);
});

test("a re-stamped index invalidates the behind-count memo inside the window", async () => {
  setIndexAge(11 * 60);
  const before = walks;
  const cfg = config(0);
  expect(await measureIndexBehind(cfg, "2026-06-03T12:00:00.000Z", 1_000_000)).toBe(0);
  expect(walks).toBe(before + 1);
  // A freshen run re-stamped the index: the memo must not outlive the
  // index generation it measured, even inside the TTL.
  expect(await measureIndexBehind(cfg, "2026-06-03T12:00:05.000Z", 1_000_001)).toBe(0);
  expect(walks).toBe(before + 2);
});

test("an in-process note write invalidates the served behind count inside the window", async () => {
  // M9: the memo was keyed by the TTL and the index stamp alone, so on an
  // origin where nothing freshens (freshening off here; read-only
  // cross-vault recall is the other case) a search memoized 0 and every
  // later search inside the window served it - including over notes this
  // process had just written. The applied write path must drop the
  // entry, so the next search re-measures instead of serving a
  // confident 0 across an edit. A write from a DIFFERENT process still
  // reaches nothing here - the memo is per-process state - and the TTL
  // alone bounds that residual: past the window the entry expires and
  // the next search re-measures, which the window test above pins.
  setIndexAge(11 * 60);
  const before = walks;
  const cfg = config(0);
  // Prime the memo: the first stale search measures 0 behind, one walk.
  const primed = await search(cfg, { query: "heron", freshenSpawn: spawn });
  expect(staleCodes(primed)[0]!.detail?.["behindCount"]).toBe(0);
  expect(walks).toBe(before + 1);
  // Three notes land through the in-process write seam - the same
  // create-then-claim sequence the MCP note tools drive after an
  // applied create, one claim per write. The spawn seam stays a no-op:
  // the claim's detached child is not what retires the memo, the write
  // is.
  const memoOne = createNote(vault, {
    path: "notes/memo-one.md",
    content: "# Memo one\n\nwritten after the measurement.\n",
  });
  expect(memoOne.outcome).toBe("created");
  await claimNoteWriteRefresh(vault, () => {});
  const memoTwo = createNote(vault, {
    path: "notes/memo-two.md",
    content: "# Memo two\n\nwritten after the measurement.\n",
  });
  expect(memoTwo.outcome).toBe("created");
  await claimNoteWriteRefresh(vault, () => {});
  const memoThree = createNote(vault, {
    path: "notes/memo-three.md",
    content: "# Memo three\n\nwritten after the measurement.\n",
  });
  expect(memoThree.outcome).toBe("created");
  await claimNoteWriteRefresh(vault, () => {});
  // Still inside the TTL: the count is re-measured, not served. The
  // three notes ride with the write path's own audit log (createNote
  // appends Brain/log), so the exact number is whatever a live census
  // measures at this instant - the pin is that the served count EQUALS
  // that fresh measurement and is not the memoized 0, which only the
  // invalidation can produce.
  const served = await search(cfg, { query: "heron", freshenSpawn: spawn });
  const live = await indexBehindCount(cfg);
  expect(live).not.toBeNull();
  expect(live!.behind).toBeGreaterThanOrEqual(3);
  expect(staleCodes(served)[0]!.detail?.["behindCount"]).toBe(live!.behind);
  // One walk each: the priming search, the re-measure after the writes
  // (the invalidation fired; the memo served nothing), and the live
  // census above through the same mocked walker.
  expect(walks).toBe(before + 3);
});

test("a failed behind-count measurement is not memoized", async () => {
  setIndexAge(11 * 60);
  const before = walks;
  const cfg = config(0);
  failWalk = true;
  expect(await measureIndexBehind(cfg, "2026-06-03T12:00:00.000Z", 1_000_000)).toBeNull();
  expect(walks).toBe(before);
  failWalk = false;
  // The next search retries: null was never a measurement.
  expect(await measureIndexBehind(cfg, "2026-06-03T12:00:00.000Z", 1_000_001)).toBe(0);
  expect(walks).toBe(before + 1);
});

test("a failed measurement leaves the age alone on the stale note", async () => {
  failWalk = true;
  setIndexAge(11 * 60);
  const outcome = await search(config(0), { query: "heron", freshenSpawn: spawn });
  const stale = staleCodes(outcome);
  expect(stale).toHaveLength(1);
  expect(Object.keys(stale[0]!.detail ?? {})).toEqual(["ageSeconds"]);
});

test("the stale detail carries behindCount only when one was measured", () => {
  const base = {
    results: [],
    warnings: [],
    total: 0,
    idfWeightedCoverage: 0,
  } as unknown as SearchOutcome;
  const measured = withIndexStale(base, 100_000, 4);
  expect(measured.retrievalTrail?.degraded[0]?.detail).toEqual({
    ageSeconds: 100_000,
    behindCount: 4,
  });
  const unmeasured = withIndexStale(base, 100_000, null);
  expect(unmeasured.retrievalTrail?.degraded[0]?.detail).toEqual({ ageSeconds: 100_000 });
});
