/**
 * A brain store record whose entity the readers no longer show stays out
 * of search: a signal tombstoned before the migration (its capture carries
 * `_status: tombstoned`), one tombstoned after the index was built (a
 * field change), a tombstoned preference, and a record an index still
 * holds when its mark arrives between two catch-ups. A signal waiting for
 * write approval is kept out until it is approved, and a lane entry an
 * index still holds after its removal is refused like a signal.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import {
  catchUpBrainStore,
  ingestStoreInto,
  storeRecordVisibility,
} from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { reindexVault } from "../../../src/core/search/indexer.ts";
import {
  applyPoolFilters,
  resolvePoolFilters,
} from "../../../src/core/search/pipeline/pool-filters.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  applyStoreEntityFilter,
  precomputedAnswerAdmitted,
} from "../../../src/core/search/brain-store/entity-filter.ts";
import { expandHit, planRead } from "../../../src/core/search/index.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { blobPath, partitionDir, shardPath } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-forgotten-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const TOMBSTONE = {
  _status: "tombstoned",
  tombstoned_at: "2026-11-01T10:00:00Z",
  tombstone_reason: "wrong",
};

function capture(
  handle: StoreHandle,
  id: string,
  words: string,
  extra: Record<string, unknown> = {},
  at = T0,
): string {
  return appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id,
        path: `Brain/inbox/${id}.md`,
        staged: false,
        frontmatter: { kind: "brain-signal", id, principle: words, ...extra },
        raw: words,
      },
    },
    { now: () => at },
  ).record.id;
}

function patch(handle: StoreHandle, signal: string, fields: Record<string, unknown>, at: number) {
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: { authority: "human", signal, fields },
    },
    { now: () => at },
  );
}

async function found(config: ResolvedSearchConfig, query: string): Promise<string[]> {
  const outcome = await search(config, {
    query,
    limit: 20,
    transportReach: TRANSPORT_REACH.local,
  });
  return outcome.results.map((r) => r.path);
}

async function indexed(config: ResolvedSearchConfig, recordId: string): Promise<boolean> {
  const index = await Store.open(config, { mode: "read" });
  try {
    return (
      index.rawQuery<{ n: number }>("SELECT count(*) AS n FROM documents WHERE path = ?", [
        storeRecordPath("shared", recordId),
      ])[0]!.n > 0
    );
  } finally {
    await index.close();
  }
}

test("a signal tombstoned before the migration is never indexed, during the build or after it", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const kept = capture(local, "sig-kept", "Kept narwhal agreement rule");
  const gone = capture(local, "sig-gone", "Golem narwhal agreement rule", TOMBSTONE, T0 + 1000);
  const config = fx.config();
  await reindexVault(config);
  expect(await indexed(config, gone)).toBe(false);
  expect(await indexed(config, kept)).toBe(true);
  const paths = await found(config, "narwhal agreement rule");
  expect(paths).toContain(storeRecordPath("shared", kept));
  expect(paths).not.toContain(storeRecordPath("shared", gone));

  // At every record the build reads, on the connection that writes it.
  const staging = { ...config, dbPath: `${config.dbPath}.probe` };
  const index = await Store.open(staging, { mode: "write", loadVec: false });
  try {
    ingestStoreInto(index, staging, () => {
      const n = index.rawQuery<{ n: number }>(
        "SELECT count(*) AS n FROM documents WHERE path = ?",
        [storeRecordPath("shared", gone)],
      )[0]!.n;
      expect(n).toBe(0);
    });
  } finally {
    await index.close();
  }
});

test("a signal tombstoned after the build leaves the index, and comes back when the mark is undone", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-later", "Heron estuary agreement rule");
  const config = fx.config();
  await reindexVault(config);
  expect(await found(config, "heron estuary")).toContain(storeRecordPath("shared", id));

  patch(local, "sig-later", TOMBSTONE, T0 + 5000);
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, id)).toBe(false);
  expect(await found(config, "heron estuary")).not.toContain(storeRecordPath("shared", id));

  patch(
    local,
    "sig-later",
    { _status: null, tombstoned_at: null, tombstone_reason: null },
    T0 + 9000,
  );
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, id)).toBe(true);
  expect(await found(config, "heron estuary")).toContain(storeRecordPath("shared", id));
});

test("a tombstoned preference is not found, and is again once its status moves on", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const set = (preference: string, principle: string, status: string, at: number): string =>
    appendRecord(
      local,
      {
        partition: "shared",
        stream: "events",
        kind: "preference-set",
        agent: "t",
        body: { authority: "agent", preference, fields: { principle, status } },
      },
      { now: () => at },
    ).record.id;
  const live = set("pref-live", "Plover dune review rule", "confirmed", T0);
  const gone = set("pref-gone", "Plover dune push rule", "tombstoned", T0 + 1000);
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "plover dune");
  expect(paths).toContain(storeRecordPath("shared", live));
  expect(paths).not.toContain(storeRecordPath("shared", gone));

  // A later set that moves the status off `tombstoned` carries no mark of
  // its own: the catch-up still brings the preference's records back.
  const back = set("pref-gone", "Plover dune push rule", "confirmed", T0 + 9000);
  await catchUpBrainStore(config, { force: true });
  const again = await found(config, "plover dune");
  expect(again).toContain(storeRecordPath("shared", gone));
  expect(again).toContain(storeRecordPath("shared", back));
});

test("a search refuses a signal its index still holds once the entity reader shows it tombstoned", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-held", "Avocet lagoon agreement rule");
  const config = fx.config();
  await reindexVault(config);
  // No catch-up between the two searches: the index keeps the record.
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  expect(await found(config, "avocet lagoon")).toContain(storeRecordPath("shared", id));
  patch(local, "sig-held", TOMBSTONE, T0 + 5000);
  expect(await indexed(config, id)).toBe(true);
  expect(await found(config, "avocet lagoon")).not.toContain(storeRecordPath("shared", id));
});

function stage(handle: StoreHandle, id: string, words: string, at: number): string {
  return appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id,
        path: `Brain/pending/${id}.md`,
        staged: true,
        frontmatter: { kind: "brain-signal", id, principle: words },
        raw: words,
      },
    },
    { now: () => at },
  ).record.id;
}

function move(handle: StoreHandle, signal: string, state: string, at: number): void {
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: { authority: "human", signal, state },
    },
    { now: () => at },
  );
}

test("a staged signal is not indexed until it is approved", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const early = stage(local, "sig-early", "Curlew saltmarsh approval rule", T0);
  const config = fx.config();
  await reindexVault(config);
  expect(await indexed(config, early)).toBe(false);
  expect(await found(config, "curlew saltmarsh")).not.toContain(storeRecordPath("shared", early));

  // Staged after the build: the incremental path keeps it out too.
  const late = stage(local, "sig-late", "Curlew saltmarsh review rule", T0 + 2000);
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, late)).toBe(false);

  // Approved: both become searchable on the next catch-up.
  move(local, "sig-early", "approved", T0 + 5000);
  move(local, "sig-late", "approved", T0 + 6000);
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, early)).toBe(true);
  const paths = await found(config, "curlew saltmarsh");
  expect(paths).toContain(storeRecordPath("shared", early));
  expect(paths).toContain(storeRecordPath("shared", late));
});

test("a search refuses a signal its index still holds once it is staged", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-restaged", "Stilt pool approval rule");
  const config = fx.config();
  await reindexVault(config);
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  expect(await found(config, "stilt pool")).toContain(storeRecordPath("shared", id));
  move(local, "sig-restaged", "staged", T0 + 5000);
  expect(await indexed(config, id)).toBe(true);
  expect(await found(config, "stilt pool")).not.toContain(storeRecordPath("shared", id));
});

test("a search refuses a lane entry its index still holds once it is removed or marked", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const entry = (name: string, text: string, fields: Record<string, unknown>, at: number) =>
    appendRecord(
      local,
      {
        partition: "shared",
        stream: "events",
        kind: "lane-entry",
        agent: "t",
        body: { authority: "agent", lane: "sources", entry: name, fields, text },
      },
      { now: () => at },
    ).record.id;
  const kept = entry("src-kept", "Ruff meadow summary kept", {}, T0);
  const removed = entry("src-removed", "Ruff meadow summary removed", {}, T0 + 100);
  const marked = entry("src-marked", "Ruff meadow summary marked", {}, T0 + 200);
  const config = fx.config();
  await reindexVault(config);
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  const before = await found(config, "ruff meadow summary");
  for (const id of [kept, removed, marked]) expect(before).toContain(storeRecordPath("shared", id));

  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry-remove",
      agent: "t",
      body: { authority: "agent", lane: "sources", entry: "src-removed" },
    },
    { now: () => T0 + 5000 },
  );
  const markedAgain = entry("src-marked", "Ruff meadow summary marked", TOMBSTONE, T0 + 6000);
  // No catch-up ran: the index still holds both, and the search refuses them.
  expect(await indexed(config, removed)).toBe(true);
  const after = await found(config, "ruff meadow summary");
  expect(after).toContain(storeRecordPath("shared", kept));
  expect(after).not.toContain(storeRecordPath("shared", removed));
  expect(after).not.toContain(storeRecordPath("shared", marked));
  expect(after).not.toContain(storeRecordPath("shared", markedAgain));
});

test("records the search withholds still count for the backfill, never for the trail", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const gone = [
    capture(local, "sig-w1", "Grebe lake rule one"),
    capture(local, "sig-w2", "Grebe lake rule two", {}, T0 + 1),
  ];
  const kept = capture(local, "sig-w3", "Grebe lake rule three", {}, T0 + 2);
  const config = fx.config();
  await reindexVault(config);
  patch(local, "sig-w1", TOMBSTONE, T0 + 5000);
  patch(local, "sig-w2", TOMBSTONE, T0 + 5001);
  const index = await Store.open(config, { mode: "read" });
  try {
    const row = (id: string, i: number): BrainSearchResult =>
      ({
        documentId: i,
        chunkId: i,
        path: storeRecordPath("shared", id),
        title: "signal",
        content: "Grebe lake rule",
        startLine: 1,
        endLine: 1,
        score: 1 - i / 10,
        keywordScore: 1,
        semanticScore: 0,
        linkBoost: 0,
        recencyBoost: 0,
        searchType: "keyword",
        reasons: [],
      }) as unknown as BrainSearchResult;
    const pool = applyPoolFilters(
      [row(gone[0]!, 1), row(gone[1]!, 2), row(kept, 3)],
      resolvePoolFilters({ query: "grebe", limit: 2, transportReach: TRANSPORT_REACH.local }),
      { vault: config.vault, store: index, frontmatterCache: new Map() },
    );
    expect(pool.visible.map((r) => r.path)).toEqual([storeRecordPath("shared", kept)]);
    // The backfill sees the two withheld rows; the trail's baseline does not.
    expect(pool.prePoolFilters).toBe(3);
    expect(pool.preVisibility).toBe(1);
  } finally {
    await index.close();
  }
});

test("a signal whose body arrives after a search read it pending is found once it is whole", async () => {
  const local = fx.open(LOCAL_DEVICE);
  // A live match, so the search reads (and caches) what it may show.
  capture(local, "sig-anchor", "Sanderling shoreline anchor rule");
  const config = fx.config();
  await reindexVault(config);
  const filler = "lorem ".repeat(4000);
  const { record, spilled } = appendRecord(local, {
    partition: "shared",
    stream: "events",
    kind: "signal",
    agent: "t",
    body: {
      id: "sig-spilled",
      path: "Brain/inbox/sig-spilled.md",
      staged: false,
      frontmatter: { kind: "brain-signal", id: "sig-spilled", principle: "Sanderling rule" },
      raw: `Sanderling shoreline rule ${filler}`,
    },
  });
  expect(spilled).toBe(true);
  const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
  const bytes = readFileSync(blob);
  rmSync(blob);
  // Read while pending: the search caches what it may show.
  expect(await found(config, "sanderling shoreline")).not.toContain(
    storeRecordPath("shared", record.id),
  );
  writeFileSync(blob, bytes);
  expect(await found(config, "sanderling shoreline")).toContain(
    storeRecordPath("shared", record.id),
  );
});

test("a tombstone mark whose body arrives late takes the signal out of the index", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-late-mark", "Knot mudflat rule");
  const config = fx.config();
  await reindexVault(config);
  const { record, spilled } = appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: {
        authority: "human",
        signal: "sig-late-mark",
        fields: { ...TOMBSTONE, tombstone_reason: "wrong ".repeat(4000) },
      },
    },
    { now: () => T0 + 5000 },
  );
  expect(spilled).toBe(true);
  const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
  const bytes = readFileSync(blob);
  rmSync(blob);
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, id)).toBe(true);
  writeFileSync(blob, bytes);
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, id)).toBe(false);
  expect(await found(config, "knot mudflat")).not.toContain(storeRecordPath("shared", id));
});

// Symbolic links need a privilege on Windows that CI runners lack.
test.skipIf(IS_WINDOWS)(
  "a search shows no signal while an events shard is not a regular file",
  async () => {
    const local = fx.open(LOCAL_DEVICE);
    const id = capture(local, "sig-linked", "Whimbrel heath rule");
    const config = fx.config();
    await reindexVault(config);
    process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
    expect(await found(config, "whimbrel heath")).toContain(storeRecordPath("shared", id));
    // The tombstone sits in another device's shard, which is then replaced
    // by a symbolic link to a copy of itself: the folds cannot read it.
    appendRecord(
      fx.open(REMOTE_DEVICE),
      {
        partition: "shared",
        stream: "events",
        kind: "signal-state",
        agent: "t",
        body: { authority: "human", signal: "sig-linked", fields: TOMBSTONE },
      },
      { now: () => T0 + 5000 },
    );
    const shard = shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2026-11");
    const copy = join(fx.parent, "linked-shard.jsonl");
    renameSync(shard, copy);
    symlinkSync(copy, shard);
    expect(await found(config, "whimbrel heath")).not.toContain(storeRecordPath("shared", id));
  },
);

test("a cached answer is not served once the store hides one of its records", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-cached", "Turnstone jetty rule");
  const base = fx.config();
  const config = { ...base, recall: { ...base.recall, cacheEnabled: true } };
  await reindexVault(config);
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  // Computed and cached, then served from the cache.
  expect(await found(config, "turnstone jetty")).toContain(storeRecordPath("shared", id));
  expect(await found(config, "turnstone jetty")).toContain(storeRecordPath("shared", id));
  const cachedRows = async (): Promise<number> => {
    const index = await Store.open(config, { mode: "read" });
    try {
      return index.rawQuery<{ n: number }>("SELECT count(*) AS n FROM query_cache")[0]!.n;
    } finally {
      await index.close();
    }
  };
  expect(await cachedRows()).toBeGreaterThan(0);
  // Tombstoned, and no catch-up has run: the index revision has not moved.
  patch(local, "sig-cached", TOMBSTONE, T0 + 5000);
  expect(await found(config, "turnstone jetty")).not.toContain(storeRecordPath("shared", id));
});

// A FIFO cannot be made on Windows.
test.skipIf(IS_WINDOWS)(
  "a search shows no signal while an events shard name is a FIFO",
  async () => {
    const local = fx.open(LOCAL_DEVICE);
    const id = capture(local, "sig-fifo", "Oystercatcher shingle rule");
    const config = fx.config();
    await reindexVault(config);
    process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
    expect(await found(config, "oystercatcher shingle")).toContain(storeRecordPath("shared", id));
    appendRecord(
      fx.open(REMOTE_DEVICE),
      {
        partition: "shared",
        stream: "events",
        kind: "signal-state",
        agent: "t",
        body: { authority: "human", signal: "sig-fifo", fields: TOMBSTONE },
      },
      { now: () => T0 + 5000 },
    );
    const shard = shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2026-11");
    rmSync(shard);
    expect(Bun.spawnSync(["mkfifo", shard]).exitCode).toBe(0);
    expect(await found(config, "oystercatcher shingle")).not.toContain(
      storeRecordPath("shared", id),
    );
  },
);

test("a record revived with its body still pending is indexed once its blob arrives", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const signal = capture(local, "sig-revived", "Godwit estuary revival rule");
  const spill = (fields: Record<string, unknown>, at: number) => {
    const { record, spilled } = appendRecord(
      local,
      {
        partition: "shared",
        stream: "events",
        kind: "signal-state",
        agent: "t",
        body: { authority: "human", signal: "sig-revived", fields },
      },
      { now: () => at },
    );
    expect(spilled).toBe(true);
    const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
    const bytes = readFileSync(blob);
    rmSync(blob);
    return { id: record.id, restore: () => writeFileSync(blob, bytes) };
  };
  // A field change whose body has not arrived, then a tombstone: the
  // build leaves the whole signal out.
  const note = spill({ note: "long ".repeat(4000) }, T0 + 1000);
  patch(local, "sig-revived", TOMBSTONE, T0 + 2000);
  const config = fx.config();
  await reindexVault(config);
  expect(await indexed(config, signal)).toBe(false);
  // The clear arrives with its body pending; once that body arrives the
  // fold brings the signal back, the field change still pending.
  const clear = spill(
    { _status: null, tombstoned_at: null, tombstone_reason: "x".repeat(20_000) },
    T0 + 3000,
  );
  await catchUpBrainStore(config, { force: true });
  clear.restore();
  await catchUpBrainStore(config, { force: true });
  expect(await indexed(config, signal)).toBe(true);
  const pendingOf = async (id: string): Promise<number | null> => {
    const index = await Store.open(config, { mode: "read" });
    try {
      return (
        index.rawQuery<{ p: number }>("SELECT body_pending AS p FROM records WHERE id = ?", [id])[0]
          ?.p ?? null
      );
    } finally {
      await index.close();
    }
  };
  expect(await pendingOf(note.id)).toBe(1);
  // Only the blob arrives: no shard changes, and the next catch-up still
  // completes the revived record.
  note.restore();
  await catchUpBrainStore(config, { force: true });
  expect(await pendingOf(note.id)).toBe(0);
});

test("a card or a read plan never reaches a record the store hides, before any catch-up", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-card", "Plover saltpan card rule");
  const config = fx.config();
  await reindexVault(config);
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  const index = await Store.open(config, { mode: "read" });
  let chunkId: number;
  try {
    chunkId = index.rawQuery<{ id: number }>(
      "SELECT c.id AS id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ?",
      [storeRecordPath("shared", id)],
    )[0]!.id;
  } finally {
    await index.close();
  }
  const expand = () => expandHit(config, { chunkId, transportReach: TRANSPORT_REACH.local });
  expect((await expand()).note.path).toBe(storeRecordPath("shared", id));
  const planned = async (): Promise<string[]> =>
    // The planner withholds what a search by the same caller withholds,
    // and no reach given is the narrowest: the local caller the expansion
    // above is.
    (
      await planRead(config, "signal", { filters: { transportReach: TRANSPORT_REACH.local } })
    ).shortlist.map((e) => e.path);
  // The plan names it while it is live (its title is the record kind).
  expect(await planned()).toContain(storeRecordPath("shared", id));
  patch(local, "sig-card", TOMBSTONE, T0 + 5000);
  expect(await indexed(config, id)).toBe(true);
  expect(
    await expand().then(
      () => "served",
      () => "refused",
    ),
  ).toBe("refused");
  expect(await planned()).not.toContain(storeRecordPath("shared", id));
});

test("an evidence pack never names a record the store hides, before any catch-up", async () => {
  const local = fx.open(LOCAL_DEVICE);
  capture(local, "sig-ev-live", "Avocet scrape rule");
  const hidden = capture(local, "sig-ev-gone", "Quillwort pool rule", {}, T0 + 1);
  const config = fx.config();
  await reindexVault(config);
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  const union = async (): Promise<string[]> => {
    const outcome = await search(config, {
      query: "avocet quillwort",
      limit: 1,
      evidencePack: true,
      transportReach: TRANSPORT_REACH.local,
    });
    return [
      ...outcome.results.map((r) => r.path),
      ...(outcome.evidencePack?.unionRecords ?? []).map((r) => r.path),
    ];
  };
  expect(await union()).toContain(storeRecordPath("shared", hidden));
  patch(local, "sig-ev-gone", TOMBSTONE, T0 + 5000);
  expect(await indexed(config, hidden)).toBe(true);
  expect(await union()).not.toContain(storeRecordPath("shared", hidden));
});

// Every shape a cached outcome can carry a store record in, end to end:
// each mode is computed, cached, served from the cache, then the record is
// tombstoned with no catch-up, and the next identical search must not name
// it anywhere in the outcome.
const CACHED_MODES: ReadonlyArray<{
  readonly name: string;
  readonly options: Record<string, unknown>;
  readonly query: string;
}> = [
  { name: "results", options: {}, query: "sandpiper groyne" },
  { name: "cards", options: { disclosure: "cards" }, query: "sandpiper groyne" },
  {
    name: "evidence pack records",
    options: { evidencePack: true },
    query: "sandpiper groyne",
  },
  {
    name: "evidence pack union records",
    options: { evidencePack: true, limit: 1 },
    query: "dunnock groyne",
  },
];

for (const mode of CACHED_MODES) {
  test(`a cached ${mode.name} answer never names a record the store hid since`, async () => {
    const local = fx.open(LOCAL_DEVICE);
    capture(local, "sig-mode-live", "Dunnock hedge rule");
    const id = capture(local, "sig-mode-gone", "Sandpiper groyne rule", {}, T0 + 1);
    const base = fx.config();
    const config = { ...base, recall: { ...base.recall, cacheEnabled: true } };
    await reindexVault(config);
    process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
    const path = storeRecordPath("shared", id);
    const answer = async (): Promise<string> =>
      JSON.stringify(
        await search(config, {
          query: mode.query,
          limit: 5,
          transportReach: TRANSPORT_REACH.local,
          ...mode.options,
        }),
      );
    expect(await answer()).toContain(path);
    // Served from the cache this time.
    expect(await answer()).toContain(path);
    patch(local, "sig-mode-gone", TOMBSTONE, T0 + 5000);
    expect(await indexed(config, id)).toBe(true);
    expect(await answer()).not.toContain(path);
  });
}

// Every field of a cached outcome, judged on its own: the check reads the
// whole row, so a record named only in one field still stops the hit.
test("a precomputed answer naming a hidden record in any field is not admitted", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const live = capture(local, "sig-field-live", "Linnet field rule");
  const gone = capture(local, "sig-field-gone", "Twite field rule", {}, T0 + 1);
  const config = fx.config();
  await reindexVault(config);
  patch(local, "sig-field-gone", TOMBSTONE, T0 + 5000);
  const livePath = storeRecordPath("shared", live);
  const gonePath = storeRecordPath("shared", gone);
  const index = await Store.open(config, { mode: "read" });
  try {
    const chunkOf = (path: string): number =>
      index.rawQuery<{ id: number }>(
        "SELECT c.id AS id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ?",
        [path],
      )[0]!.id;
    const shapes: ReadonlyArray<readonly [string, (p: string) => unknown]> = [
      ["results", (p) => ({ results: [{ path: p }] })],
      ["cards", (p) => ({ results: [], cards: [{ path: p, pointer: `${p}:L1-2` }] })],
      ["card duplicates", (p) => ({ cards: [{ path: livePath, duplicates: [`${p}:L1`] }] })],
      ["evidence records", (p) => ({ evidencePack: { records: [{ path: p, linePointer: p }] } })],
      ["dropped candidates", (p) => ({ evidencePack: { droppedCandidates: [{ path: p }] } })],
      ["union records", (p) => ({ evidencePack: { unionRecords: [{ path: p }] } })],
      ["iterative prompt", (p) => ({ iterative: { llmStep: { prompt: `candidate ${p}` } } })],
      ["decision trace", (p) => ({ retrievalDecisionTrace: { steps: [{ note: `kept ${p}` }] } })],
    ];
    for (const [name, shape] of shapes) {
      expect([name, precomputedAnswerAdmitted(shape(livePath), index)]).toEqual([name, true]);
      expect([name, precomputedAnswerAdmitted(shape(gonePath), index)]).toEqual([name, false]);
    }
    // An iterative plan hands back chunk ids for its commit call.
    expect(precomputedAnswerAdmitted({}, index, [chunkOf(livePath)])).toBe(true);
    expect(precomputedAnswerAdmitted({}, index, [chunkOf(gonePath)])).toBe(false);
  } finally {
    await index.close();
  }
});

// A shard the fold cannot open: chmod cannot deny reading as root or on Windows.
test.skipIf(CHMOD_CANNOT_DENY)(
  "a late tombstone whose fold met an unreadable shard is folded once the shard reads",
  async () => {
    const local = fx.open(LOCAL_DEVICE);
    const id = capture(local, "sig-retry", "Shelduck creek rule");
    // Another device's events shard, which the fold must read too (its
    // path is the one the append wrote, whatever month the clock says).
    const { path: remote } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "Unrelated decision" },
    });
    const { record, spilled } = appendRecord(
      local,
      {
        partition: "shared",
        stream: "events",
        kind: "signal-state",
        agent: "t",
        body: {
          authority: "human",
          signal: "sig-retry",
          fields: { ...TOMBSTONE, tombstone_reason: "wrong ".repeat(4000) },
        },
      },
      { now: () => T0 + 5000 },
    );
    expect(spilled).toBe(true);
    const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
    const bytes = readFileSync(blob);
    rmSync(blob);
    const config = fx.config();
    await reindexVault(config);
    expect(await indexed(config, id)).toBe(true);
    // The body arrives while the other shard cannot be read: the pass
    // completes the body, its fold read has a gap, and nothing is removed.
    writeFileSync(blob, bytes);
    chmodSync(remote, 0o000);
    try {
      await catchUpBrainStore(config, { force: true });
      expect(await indexed(config, id)).toBe(true);
      // Search fails closed meanwhile.
      expect(await found(config, "shelduck creek")).not.toContain(storeRecordPath("shared", id));
      // Still owed on the next pass while the gap lasts.
      await catchUpBrainStore(config, { force: true });
      expect(await indexed(config, id)).toBe(true);
    } finally {
      chmodSync(remote, 0o644);
    }
    // Nothing changed since: no shard, no pending body. The fold is still owed.
    await catchUpBrainStore(config, { force: true });
    expect(await indexed(config, id)).toBe(false);
  },
);

test("a duplicate pointer to a hidden record is dropped from the visible row that carries it", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const gone = capture(local, "sig-dup-gone", "Garganey ditch rule");
  const config = fx.config();
  await reindexVault(config);
  patch(local, "sig-dup-gone", TOMBSTONE, T0 + 5000);
  const index = await Store.open(config, { mode: "read" });
  try {
    const dup = { path: storeRecordPath("shared", gone), startLine: 1, endLine: 2 };
    const keptDup = { path: "notes/other.md", startLine: 1, endLine: 2 };
    const rows = [
      { path: "notes/kept.md", duplicates: [dup, keptDup] },
      { path: "notes/only.md", duplicates: [dup] },
      { path: "notes/plain.md" },
    ];
    const out = applyStoreEntityFilter(rows, index);
    expect(out.map((r) => r.path)).toEqual(["notes/kept.md", "notes/only.md", "notes/plain.md"]);
    expect(out[0]!.duplicates).toEqual([keptDup]);
    expect("duplicates" in out[1]!).toBe(false);
  } finally {
    await index.close();
  }
});

test("a fold read with a gap in a shard neither revives, removes nor settles", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const id = capture(local, "sig-gap", "Smew reservoir rule");
  // The tombstone sits in another device's shard.
  const remoteHandle = fx.open(REMOTE_DEVICE);
  const { path: remote } = appendRecord(
    remoteHandle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: { authority: "human", signal: "sig-gap", fields: TOMBSTONE },
    },
    { now: () => T0 + 1000 },
  );
  const config = fx.config();
  await reindexVault(config);
  expect(await indexed(config, id)).toBe(false);
  // The tombstone line is damaged in place (a corrupt line, not torn), and
  // a later record follows it: the shard reads with a gap where it was.
  writeFileSync(remote, "this line is no record\n");
  appendRecord(
    remoteHandle,
    {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "A later decision" },
    },
    { now: () => T0 + 2000 },
  );
  await catchUpBrainStore(config, { force: true });
  // A read that cannot see the tombstone does not bring the signal back.
  expect(await indexed(config, id)).toBe(false);
  // Search shows no fold record while the gap lasts.
  expect(await found(config, "smew reservoir")).not.toContain(storeRecordPath("shared", id));
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a cached visibility is not served while an events shard cannot be read",
  async () => {
    const local = fx.open(LOCAL_DEVICE);
    capture(local, "sig-vis", "Pintail marsh rule");
    const { path: remote } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "Another decision" },
    });
    const store = fx.config().brainStore!;
    expect(storeRecordVisibility(store)).not.toBeNull();
    // Warm: the same answer from the cache.
    expect(storeRecordVisibility(store)).not.toBeNull();
    chmodSync(remote, 0o000);
    try {
      expect(storeRecordVisibility(store)).toBeNull();
    } finally {
      chmodSync(remote, 0o644);
    }
    expect(storeRecordVisibility(store)).not.toBeNull();
  },
);

test("a cached visibility follows a spilled fold body whose blob goes away", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const staged = stage(local, "sig-approved", "Gadwall lagoon rule", T0);
  // The approval is spilled to a blob, whole when the visibility is read.
  const { record, spilled } = appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: {
        authority: "human",
        signal: "sig-approved",
        state: "approved",
        fields: { note: "long ".repeat(4000) },
      },
    },
    { now: () => T0 + 1000 },
  );
  expect(spilled).toBe(true);
  const store = fx.config().brainStore!;
  const before = storeRecordVisibility(store)!;
  expect(before.hidden.has(staged)).toBe(false);
  expect(before.known.has(staged)).toBe(true);
  // The blob goes: a cold read sets the approval aside, and the capture is
  // staged again. No events shard changed.
  rmSync(blobPath(partitionDir(fx.root, "shared"), record.sum));
  const after = storeRecordVisibility(store)!;
  expect(after.hidden.has(staged)).toBe(true);
});

test("a cached plan whose pool names a chunk the index no longer holds is not admitted", async () => {
  const local = fx.open(LOCAL_DEVICE);
  capture(local, "sig-pool", "Wigeon pool rule");
  const config = fx.config();
  await reindexVault(config);
  const index = await Store.open(config, { mode: "read" });
  try {
    expect(precomputedAnswerAdmitted({}, index, [987_654_321])).toBe(false);
  } finally {
    await index.close();
  }
});
