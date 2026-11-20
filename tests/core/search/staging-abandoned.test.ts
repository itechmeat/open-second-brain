/**
 * A staging file an interrupted first build left behind is never served:
 * until the rebuild has accepted it (its signature matches, and what the
 * store forgot since is out of it) or recreated it, the build is
 * `preparing` and no search opens it.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import {
  dropForgottenRecords,
  ingestStoreInto,
} from "../../../src/core/search/brain-store/catch-up.ts";
import { IndexBuildRecorder, stagingIndexPath } from "../../../src/core/search/build-progress.ts";
import {
  closeServedStore,
  indexBuildServed,
  openReadOrSelfHeal,
} from "../../../src/core/search/pipeline/store-open.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import {
  acquireWriterLease,
  isWriterLockHeld,
} from "../../../src/core/search/store/writer-lock.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const WORKER = join(import.meta.dir, "fixtures", "store-rebuild-worker.ts");

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-staging-abandoned-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

/** A staging file an earlier run left, holding a note the vault no longer has. */
async function abandonedStaging(signature: string): Promise<string> {
  const config = fx.config();
  const staging = stagingIndexPath(config.dbPath);
  mkdirSync(dirname(staging), { recursive: true });
  const index = await Store.open({ ...config, dbPath: staging }, { mode: "write", loadVec: false });
  try {
    const doc = index.upsertDocument({
      path: "notes/abandoned.md",
      title: "Abandoned",
      contentHash: "x",
      mtime: 1,
      size: 1,
      pageType: null,
      eventAnchor: null,
      visibility: [],
      pinned: false,
    });
    index.replaceDocumentChunks(doc, [
      {
        chunkIndex: 0,
        content: "Abandoned okapi page",
        ftsContent: "Abandoned okapi page",
        contentHash: "y",
        startLine: 1,
        endLine: 1,
        tokenCount: 3,
        headingPath: "Abandoned",
      },
    ]);
    index.setState("reindex_signature", signature);
  } finally {
    await index.close();
  }
  return staging;
}

test("a search never reads a prepared-but-not-accepted staging file", async () => {
  fx.open(LOCAL_DEVICE);
  const config = fx.config();
  await abandonedStaging("{}");
  const lease = await acquireWriterLease(config.dbPath);
  try {
    const recorder = new IndexBuildRecorder(config.dbPath);
    // While preparing, the read waits instead of opening the file.
    let settled = false;
    const opening = openReadOrSelfHeal(config, { serveBuilding: true }).then((s) => {
      settled = true;
      return s;
    });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    recorder.ready();
    const store = await opening;
    expect(indexBuildServed(store)).not.toBeNull();
    await closeServedStore(store);
    recorder.end();
  } finally {
    lease.release();
  }
});

test("an abandoned staging file whose signature does not match is never served", async () => {
  fx.open(LOCAL_DEVICE);
  for (let i = 0; i < 6; i++)
    fx.writeNote(`notes/n${i}.md`, `# Note ${i}\n\nAn estuary note ${i}.\n`);
  const config = fx.config();
  await abandonedStaging(JSON.stringify({ chunker: "another build" }));
  const signal = join(fx.parent, "rebuild-locked");
  const gate = join(fx.parent, "rebuild-go");
  const child = Bun.spawn([process.execPath, WORKER, fx.parent, signal, gate, "3"], {
    env: { ...process.env, STORE_REBUILD_WORKER_RESUME: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const served: string[] = [];
  try {
    // From the moment the rebuild holds the lock (its record says
    // `preparing`) a search must not reach the abandoned file. Before
    // that there is no build to answer from, and a search would heal the
    // index itself.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (!isWriterLockHeld(config.dbPath) && !exited) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(1);
    }
    // Search all the way from the spawn to the pause: the abandoned page
    // never answers (an index-building refusal is fine).
    // eslint-disable-next-line no-unmodified-loop-condition
    while (!existsSync(signal) && !exited) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await search(config, {
          query: "okapi",
          limit: 5,
          transportReach: TRANSPORT_REACH.local,
        });
        served.push(...out.results.map((r) => r.path));
      } catch (e) {
        if (!(e instanceof SearchError) || e.code !== "INDEX_MISSING") throw e;
      }
      // Let the child's exit be observed.
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(1);
    }
    // A rebuild that ended before its pause says why (its stderr).
    expect(existsSync(signal) ? "" : await new Response(child.stderr).text()).toBe("");
    expect(existsSync(signal)).toBe(true);
    const during = await search(config, {
      query: "okapi",
      limit: 5,
      transportReach: TRANSPORT_REACH.local,
    });
    served.push(...during.results.map((r) => r.path));
    expect(served).toEqual([]);
  } finally {
    writeFileSync(gate, "go\n");
    await child.exited;
  }
  expect(await child.exited).toBe(0);
  const after = await search(config, {
    query: "okapi",
    limit: 5,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(after.results).toEqual([]);
});

test("a resumed staging file loses what the store forgot since, before any read", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const config = fx.config();
  const signal = appendRecord(local, {
    partition: "shared",
    stream: "events",
    kind: "signal",
    agent: "t",
    body: {
      id: "sig-q",
      path: "Brain/inbox/sig-q.md",
      staged: false,
      frontmatter: { principle: "Quokka rule" },
      raw: "Quokka rule",
    },
  }).record;
  // An earlier run indexed the signal into its staging file.
  const staging = stagingIndexPath(config.dbPath);
  mkdirSync(dirname(staging), { recursive: true });
  const index = await Store.open({ ...config, dbPath: staging }, { mode: "write", loadVec: false });
  const has = (): boolean =>
    index.rawQuery<{ n: number }>("SELECT count(*) AS n FROM documents WHERE path = ?", [
      storeRecordPath("shared", signal.id),
    ])[0]!.n > 0;
  try {
    ingestStoreInto(index, { ...config, dbPath: staging });
    expect(has()).toBe(true);
    // The signal is forgotten after that run stopped.
    appendRecord(local, {
      partition: "shared",
      stream: "events",
      kind: "signal-removed",
      agent: "t",
      body: { authority: "human", signal: "sig-q" },
    });
    expect(dropForgottenRecords(index, config)).toBeGreaterThan(0);
    expect(has()).toBe(false);
  } finally {
    await index.close();
  }
});
