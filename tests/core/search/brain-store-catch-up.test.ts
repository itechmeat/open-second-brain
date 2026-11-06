/**
 * Catch-up before reads (design D5, task 1.8): records appended to the
 * brain store become searchable without a reindex, an unchanged store
 * opens no store file, a replaced or truncated shard is re-read once and
 * holds each record once, and a notes-only search returns no brain record.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { brainChanges } from "../../../src/core/search/brain-store/changes.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { shardPath } from "../../../src/core/store/store-paths.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
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
  fx = makeStoreIndexFixture();
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

async function readyIndex(): Promise<ResolvedSearchConfig> {
  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/heron.md", "# Heron note\n\nThe user wrote about herons at the lake.\n");
  const config = fx.config();
  await indexVault(config);
  return config;
}

function remoteAppend(
  text: string,
  extra: { scope?: string; topic?: string } = {},
): StoreRecord & { shardFile: string } {
  const b = fx.open(REMOTE_DEVICE);
  const result = appendRecord(b, {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    ...extra,
    body: { text },
  });
  return { ...result.record, shardFile: result.path };
}

async function paths(config: ResolvedSearchConfig, query: string, source?: "notes" | "brain") {
  const outcome = await search(config, {
    query,
    limit: 10,
    transportReach: TRANSPORT_REACH.local,
    ...(source ? { source } : {}),
  });
  return outcome.results.map((r) => r.path);
}

async function recordCount(config: ResolvedSearchConfig): Promise<number> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return store.rawQuery<{ n: number }>("SELECT COUNT(*) AS n FROM records")[0]!.n;
  } finally {
    await store.close();
  }
}

const line = (record: StoreRecord): string => `${JSON.stringify(record)}\n`;

function remoteRecord(text: string, physical: number): StoreRecord {
  return buildRecord({
    hlc: { physical, counter: 0 },
    device: REMOTE_DEVICE,
    agent: "agent-b",
    kind: "decision",
    body: { text },
  });
}

const NOV_2026 = Date.UTC(2026, 10, 3);

function remoteShard(): string {
  return shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2026-11");
}

describe("catch-up before reads", () => {
  test("a record from another machine is searchable without a reindex", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Kingfisher nesting decision for the north bank");
    const found = await paths(config, "kingfisher nesting");
    expect(found).toContain(storeRecordPath("shared", record.id));
  });

  test("notes-only search returns no brain record, brain-only no note", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Herons were seen at the lake again");
    const all = await paths(config, "herons lake");
    expect(all).toContain("notes/heron.md");
    expect(all).toContain(storeRecordPath("shared", record.id));
    const notes = await paths(config, "herons lake", "notes");
    expect(notes).toEqual(["notes/heron.md"]);
    const brain = await paths(config, "herons lake", "brain");
    expect(brain).toEqual([storeRecordPath("shared", record.id)]);
  });

  test("an unchanged store opens no store file", async () => {
    const config = await readyIndex();
    remoteAppend("First record");
    remoteAppend("Second record");
    const first = await catchUpBrainStore(config);
    expect(first.skipped).toBeNull();
    expect(first.added).toBe(2);
    const open = spyOn(fs, "openSync");
    const readFile = spyOn(fs, "readFileSync");
    const touched = (): string[] =>
      [...open.mock.calls, ...readFile.mock.calls]
        .map((call) => String(call[0]))
        .filter((p) => p.startsWith(fx.root));
    try {
      const again = await catchUpBrainStore(config);
      expect(again).toMatchObject({ skipped: null, shardsRead: 0, added: 0 });
      expect(touched()).toEqual([]);
      // The spy does see the reader: one more record is read through it.
      remoteAppend("Third record");
      open.mockClear();
      readFile.mockClear();
      expect((await catchUpBrainStore(config)).added).toBe(1);
      expect(touched().length).toBeGreaterThan(0);
    } finally {
      open.mockRestore();
      readFile.mockRestore();
    }
  });

  test("a shard replaced by a same-size file is re-read once and holds each record once", async () => {
    const config = await readyIndex();
    const shard = remoteShard();
    fs.mkdirSync(dirname(shard), { recursive: true });
    const a = remoteRecord("alpha plover", NOV_2026);
    const b = remoteRecord("gamma plover", NOV_2026);
    expect(line(a).length).toBe(line(b).length);
    fs.writeFileSync(shard, line(a));
    expect((await catchUpBrainStore(config)).added).toBe(1);

    const replacement = join(dirname(shard), "replacement.tmp");
    fs.writeFileSync(replacement, line(b));
    fs.renameSync(replacement, shard);
    const reread = await catchUpBrainStore(config);
    expect(reread).toMatchObject({ shardsRead: 1, added: 1, removed: 1 });
    expect(await recordCount(config)).toBe(1);
    expect(await paths(config, "plover")).toEqual([storeRecordPath("shared", b.id)]);
    expect((await catchUpBrainStore(config)).shardsRead).toBe(0);
  });

  test("a same-size rewrite in place is found by the prefix hash once its mtime moves", async () => {
    const config = await readyIndex();
    const shard = remoteShard();
    fs.mkdirSync(dirname(shard), { recursive: true });
    const a = remoteRecord("alpha sandpiper", NOV_2026);
    const b = remoteRecord("gamma sandpiper", NOV_2026);
    fs.writeFileSync(shard, line(a));
    await catchUpBrainStore(config);
    const before = fs.statSync(shard);
    fs.writeFileSync(shard, line(b));
    // Same inode, same size; only the mtime says something happened.
    fs.utimesSync(shard, before.atime, new Date(before.mtimeMs + 5000));
    expect(fs.statSync(shard).ino).toBe(before.ino);
    expect(fs.statSync(shard).size).toBe(before.size);
    const reread = await catchUpBrainStore(config);
    expect(reread).toMatchObject({ shardsRead: 1, added: 1, removed: 1 });
    expect(await paths(config, "sandpiper")).toEqual([storeRecordPath("shared", b.id)]);
  });

  test("a truncated shard is re-read from the start once, then resumes from its offset", async () => {
    const config = await readyIndex();
    const shard = remoteShard();
    fs.mkdirSync(dirname(shard), { recursive: true });
    const a = remoteRecord("first curlew", NOV_2026);
    const b = remoteRecord("second curlew", NOV_2026 + 1);
    fs.writeFileSync(shard, line(a) + line(b));
    expect((await catchUpBrainStore(config)).added).toBe(2);

    fs.truncateSync(shard, Buffer.byteLength(line(a)));
    const reread = await catchUpBrainStore(config);
    expect(reread).toMatchObject({ shardsRead: 1, added: 0, removed: 1 });
    expect(await recordCount(config)).toBe(1);
    expect((await catchUpBrainStore(config)).shardsRead).toBe(0);

    const c = remoteRecord("third curlew", NOV_2026 + 2);
    fs.appendFileSync(shard, line(c));
    expect(await catchUpBrainStore(config)).toMatchObject({ shardsRead: 1, added: 1, removed: 0 });
    expect(await recordCount(config)).toBe(2);
  });

  test("a half-delivered last line is read once the rest arrives, and only once", async () => {
    const config = await readyIndex();
    const shard = remoteShard();
    fs.mkdirSync(dirname(shard), { recursive: true });
    const a = remoteRecord("first lapwing", NOV_2026);
    const b = remoteRecord("second lapwing", NOV_2026 + 1);
    const cut = 30;
    fs.writeFileSync(shard, line(a) + line(b).slice(0, cut));
    expect(await catchUpBrainStore(config)).toMatchObject({ shardsRead: 1, added: 1 });
    expect(await paths(config, "second lapwing")).not.toContain(storeRecordPath("shared", b.id));

    fs.appendFileSync(shard, line(b).slice(cut));
    expect(await catchUpBrainStore(config)).toMatchObject({ shardsRead: 1, added: 1, removed: 0 });
    expect(await recordCount(config)).toBe(2);
    const found = await paths(config, "second lapwing");
    expect(found.filter((p) => p === storeRecordPath("shared", b.id))).toHaveLength(1);
    expect((await catchUpBrainStore(config)).shardsRead).toBe(0);
  });

  test("a complete last line that fails its checksum is read once a good copy replaces it", async () => {
    const config = await readyIndex();
    const shard = remoteShard();
    fs.mkdirSync(dirname(shard), { recursive: true });
    const a = remoteRecord("first stint", NOV_2026);
    const b = remoteRecord("second stint", NOV_2026 + 1);
    const damaged = { ...b, sum: "0".repeat(b.sum.length) };
    fs.writeFileSync(shard, line(a) + line(damaged));
    expect(await catchUpBrainStore(config)).toMatchObject({ shardsRead: 1, added: 1 });
    expect(await recordCount(config)).toBe(1);

    // The sync tool delivers the good copy over the damaged one.
    const before = fs.statSync(shard);
    fs.writeFileSync(shard, line(a) + line(b));
    fs.utimesSync(shard, before.atime, new Date(before.mtimeMs + 5000));
    expect(await catchUpBrainStore(config)).toMatchObject({ shardsRead: 1, added: 1, removed: 0 });
    expect(await recordCount(config)).toBe(2);
    expect(await paths(config, "second stint")).toContain(storeRecordPath("shared", b.id));
  });

  test("a deleted shard takes its records out of the index", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Avocet survey decision");
    expect(await paths(config, "avocet")).toContain(storeRecordPath("shared", record.id));
    fs.rmSync(record.shardFile);
    expect(await paths(config, "avocet")).toEqual([]);
    expect(await recordCount(config)).toBe(0);
  });

  test("the incremental vault index keeps store records", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Dunlin roost decision");
    await catchUpBrainStore(config);
    await indexVault(config);
    expect(await paths(config, "dunlin roost")).toContain(storeRecordPath("shared", record.id));
  });
});

describe("the private partition on the read side", () => {
  test("a private record is found locally, reserved as private, and grouped apart", async () => {
    const config = await readyIndex();
    const b = fx.open(REMOTE_DEVICE);
    const append = (partition: "shared" | "private", text: string) =>
      appendRecord(b, {
        partition,
        stream: "events",
        kind: "decision",
        agent: "agent-b",
        body: { text },
      }).record;
    const secret = append("private", "Garganey private decision");
    const open = append("shared", "Garganey shared decision");
    const found = await paths(config, "garganey");
    expect(found).toContain(storeRecordPath("private", secret.id));
    expect(found).toContain(storeRecordPath("shared", open.id));

    const store = await Store.open(config, { mode: "read" });
    try {
      const visibility = (path: string) =>
        store.rawQuery<{ v: string }>(
          `SELECT visibility AS v FROM documents WHERE path = '${path}'`,
        )[0]?.v;
      expect(JSON.parse(visibility(storeRecordPath("private", secret.id))!)).toEqual([
        REMOTE_DENY_VISIBILITY_TOKEN,
      ]);
      expect(JSON.parse(visibility(storeRecordPath("shared", open.id))!)).toEqual([]);
    } finally {
      await store.close();
    }

    const changes = await brainChanges(config);
    expect(changes.groups.map((g) => [g.partition, g.ids])).toEqual(
      expect.arrayContaining([
        ["private", [secret.id]],
        ["shared", [open.id]],
      ]),
    );
    expect(changes.groups).toHaveLength(2);
  });
});

describe("the throttle at its default interval", () => {
  test("a second look inside the window is skipped; a forced one still reads", async () => {
    delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
    const config = await readyIndex();
    remoteAppend("Pratincole decision");
    expect(await catchUpBrainStore(config)).toMatchObject({ skipped: null, added: 1 });
    const late = remoteAppend("Courser decision");
    expect(await catchUpBrainStore(config)).toMatchObject({ skipped: "throttled", shardsRead: 0 });
    expect(await catchUpBrainStore(config, { force: true })).toMatchObject({
      skipped: null,
      added: 1,
    });
    expect(await paths(config, "courser")).toContain(storeRecordPath("shared", late.id));
  });
});

describe("reach", () => {
  test("a store record is withheld from a remote caller", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Shelduck count decision");
    expect(await paths(config, "shelduck")).toContain(storeRecordPath("shared", record.id));
    // A note with the same word comes back, so the reach filter, not an
    // empty answer, is what withholds the record.
    fx.writeNote("notes/shelduck.md", "# Shelduck\n\nShelduck count at the estuary.\n");
    await indexVault(config);
    const remote = await search(config, { query: "shelduck", limit: 10 });
    expect(remote.results.map((r) => r.path)).toEqual(["notes/shelduck.md"]);
  });
});

describe("an index shared by both modes", () => {
  test("drops the store records once the vault reads no store", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Oystercatcher decision");
    expect(await paths(config, "oystercatcher")).toContain(storeRecordPath("shared", record.id));
    // Same index file (an explicit search_db_path), the store no longer resolves.
    const storeless: ResolvedSearchConfig = Object.freeze({ ...config, brainStore: null });
    await indexVault(storeless);
    expect(await paths(storeless, "oystercatcher")).toEqual([]);
    expect(await paths(storeless, "heron")).toEqual(["notes/heron.md"]);
    expect(await recordCount(storeless)).toBe(0);
    // Back on the store: everything is read again.
    expect(await paths(config, "oystercatcher")).toContain(storeRecordPath("shared", record.id));
  });

  test("keeps the store records when a run cannot tell whether a store is in use", async () => {
    const config = await readyIndex();
    const record = remoteAppend("Turnstone decision");
    expect(await paths(config, "turnstone")).toContain(storeRecordPath("shared", record.id));
    // A store.json mid-rewrite: the run neither found the store nor its absence.
    const unsure: ResolvedSearchConfig = Object.freeze({
      ...config,
      brainStore: null,
      brainStoreUnknown: true,
    });
    await indexVault(unsure);
    expect(await recordCount(unsure)).toBeGreaterThan(0);
  });
});
