/**
 * Freshen on read at the `search()` seam: a stale index starts one
 * background run and the answer still comes from the index as it is; a
 * read-only open never starts one; an index more than ten minutes old is
 * named on the trail as `index-stale` whatever the freshen setting.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { search } from "../../../src/core/search/search.ts";
import { LAST_INDEXED_AT_STATE_KEY } from "../../../src/core/search/store/state.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let calls: string[][];
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

afterEach(() => cleanup());

function config(intervalSeconds: number): ResolvedSearchConfig {
  return Object.freeze({
    ...makeConfig({ vault, dbPath }),
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
