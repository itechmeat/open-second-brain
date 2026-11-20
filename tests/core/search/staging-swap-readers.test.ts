/**
 * The swap of a rebuild whose staging file searches are reading. On
 * Windows a file cannot be renamed while any handle to it is open (SQLite
 * opens without delete sharing), so a search holding the staging file
 * through the swap would fail a build of minutes. A search announces its
 * read and holds the file for one query; the rebuild, once finishing, lets
 * no new read in, waits for the ones in flight, folds the WAL and renames
 * with a bounded retry. Both cases run the real rename with a handle open
 * on every platform: on POSIX they pass at once, on Windows they prove the
 * wait and the retry.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { readIndexBuild, stagingIndexPath } from "../../../src/core/search/build-progress.ts";
import {
  closeServedStore,
  indexBuildServed,
  openReadOrSelfHeal,
} from "../../../src/core/search/pipeline/store-open.ts";
import { search } from "../../../src/core/search/search.ts";
import { closeDatabase } from "../../../src/core/sqlite-close.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOTES = 12;
const PAUSE_AT = 6;
const WORKER = join(import.meta.dir, "fixtures", "store-rebuild-worker.ts");

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-staging-swap-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

interface PausedBuild {
  readonly config: ResolvedSearchConfig;
  readonly child: ReturnType<typeof Bun.spawn>;
  /** Let the paused rebuild go on. */
  go(): void;
  exited(): boolean;
}

/** A first build of the fixture's index, paused while it holds the writer lock. */
async function pausedFirstBuild(): Promise<PausedBuild> {
  fx.open(LOCAL_DEVICE);
  for (let i = 0; i < NOTES; i++) {
    fx.writeNote(`notes/n${i}.md`, `# Note ${i}\n\nOrdinary note number ${i} about the estuary.\n`);
  }
  const config = fx.config();
  const signal = join(fx.parent, "rebuild-locked");
  const gate = join(fx.parent, "rebuild-go");
  const child = Bun.spawn([process.execPath, WORKER, fx.parent, signal, gate, String(PAUSE_AT)], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let done = false;
  void child.exited.then(() => {
    done = true;
  });
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!existsSync(signal) && !done) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(5);
  }
  if (!existsSync(signal)) {
    child.kill();
    await child.exited;
  }
  expect(existsSync(signal)).toBe(true);
  return {
    config,
    child,
    go: () => writeFileSync(gate, "go\n"),
    exited: () => done,
  };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(10);
  }
  return cond();
}

async function finished(build: PausedBuild): Promise<void> {
  const code = await build.child.exited;
  const stderr = await new Response(build.child.stderr as ReadableStream).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
  const { dbPath } = build.config;
  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(stagingIndexPath(dbPath))).toBe(false);
  const left = readdirSync(dirname(dbPath)).filter(
    (n) => n.startsWith(`${basename(dbPath)}.building`) || n.startsWith(`${basename(dbPath)}.new`),
  );
  expect(left).toEqual([]);
  const after = await search(build.config, {
    query: "estuary",
    limit: 50,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(after.results.length).toBe(NOTES);
}

test("the swap waits for a search that holds the staging file, then renames it", async () => {
  const build = await pausedFirstBuild();
  let held: Awaited<ReturnType<typeof openReadOrSelfHeal>> | null = null;
  try {
    held = await openReadOrSelfHeal(build.config, { serveBuilding: true });
    expect(indexBuildServed(held)).not.toBeNull();
    // A statement on the connection, as a query in flight leaves one.
    expect(
      held.rawQuery<{ n: number }>("SELECT count(*) AS n FROM documents")[0]!.n,
    ).toBeGreaterThan(0);
    build.go();
    // The build finishes its work, then waits for the read in flight.
    expect(
      await until(() => readIndexBuild(build.config.dbPath)?.phase === "finishing", 60_000),
    ).toBe(true);
    await Bun.sleep(300);
    expect(build.exited()).toBe(false);
    expect(existsSync(build.config.dbPath)).toBe(false);
    // A new search does not open the staging file now: it waits for the swap.
    const late = search(build.config, {
      query: "estuary",
      limit: 50,
      transportReach: TRANSPORT_REACH.local,
    });
    await Bun.sleep(100);
    await closeServedStore(held);
    held = null;
    const answered = await late;
    expect(answered.results.length).toBe(NOTES);
    expect(answered.warnings.some((w) => w.startsWith("the search index is being built"))).toBe(
      false,
    );
  } finally {
    if (held !== null) await closeServedStore(held);
    // Whatever failed above, the worker ends before the fixture is removed.
    build.go();
    await build.child.exited;
  }
  await finished(build);
});

test("a handle still open on the staging file during the rename does not fail the build", async () => {
  const build = await pausedFirstBuild();
  // A connection that announced nothing: on Windows the rename meets it
  // and retries until it closes; on POSIX the rename does not care.
  const raw = new Database(stagingIndexPath(build.config.dbPath), { readonly: true });
  try {
    expect(
      raw.query<{ n: number }, []>("SELECT count(*) AS n FROM documents").get()!.n,
    ).toBeGreaterThan(0);
    build.go();
    expect(
      await until(
        () => build.exited() || readIndexBuild(build.config.dbPath)?.phase === "finishing",
        60_000,
      ),
    ).toBe(true);
    // Hold the handle well into the swap's retry window, then let go.
    await Bun.sleep(1000);
  } finally {
    closeDatabase(raw);
    build.go();
    await build.child.exited;
  }
  await finished(build);
});
