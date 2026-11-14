/**
 * Rebuild on format change (design D5): while a background rebuild builds
 * the new index in another process, reads keep answering from the old
 * one, store records included, and the swap happens without a failed
 * read. The rebuild is the self-heal one an index chunked by older rules
 * gets, and the new index carries the store from its first read.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { inspectIndex } from "../../../src/core/search/self-heal.ts";
import { CHUNKER_VERSION_STATE_KEY } from "../../../src/core/search/store/state.ts";
import { isWriterLockHeld } from "../../../src/core/search/store/writer-lock.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOTES = 400;
const WORKER = join(import.meta.dir, "fixtures", "store-rebuild-worker.ts");

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-rebuild-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

test("reads keep working during a background rebuild and after its swap", async () => {
  fx.open(LOCAL_DEVICE);
  for (let i = 0; i < NOTES; i++) {
    fx.writeNote(`notes/n${i}.md`, `# Note ${i}\n\nOrdinary note number ${i} about the estuary.\n`);
  }
  const config = fx.config();
  await indexVault(config);
  const { record } = appendRecord(fx.open(REMOTE_DEVICE), {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    body: { text: "Turnstone ringing decision" },
  });
  const expected = storeRecordPath("shared", record.id);
  const read = async (): Promise<string[]> =>
    (
      await search(config, { query: "turnstone", limit: 5, transportReach: TRANSPORT_REACH.local })
    ).results.map((r) => r.path);
  expect(await read()).toContain(expected);

  // Chunks cut by older rules: the condition a format change leaves.
  const db = new Database(config.dbPath);
  db.query("UPDATE index_state SET value = '0' WHERE key = ?").run(CHUNKER_VERSION_STATE_KEY);
  db.close();
  expect(inspectIndex(config)).toBe("rebuild");
  const before = statSync(config.dbPath).ino;

  const signal = join(fx.parent, "rebuild-locked");
  const gate = join(fx.parent, "rebuild-go");
  const child = Bun.spawn([process.execPath, WORKER, fx.parent, signal, gate], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const failures: string[] = [];
  const readOnce = async (): Promise<void> => {
    try {
      const paths = await read();
      if (!paths.includes(expected)) failures.push(`missing record: ${paths.join(", ")}`);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  };
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  // The child pauses inside its rebuild, holding the writer lock, until
  // the gate opens: reads in that window run while the rebuild is under way.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!existsSync(signal) && !exited) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(5);
  }
  try {
    expect(existsSync(signal)).toBe(true);
    expect(isWriterLockHeld(config.dbPath)).toBe(true);
    await readOnce();
    await readOnce();
    expect(isWriterLockHeld(config.dbPath)).toBe(true);
  } finally {
    // Never leave the child waiting on the gate, whatever failed above.
    writeFileSync(gate, "go\n");
  }
  // Then reads keep going through the rest of the rebuild and its swap.
  // `exited` flips in the child's exit callback; each read below is
  // sequential on purpose, the next one starts after the last answered.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!exited) {
    // eslint-disable-next-line no-await-in-loop
    await readOnce();
    // Search is synchronous SQLite under its awaits; yield to the event
    // loop so the child's exit is observed.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(5);
  }
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
  expect(JSON.parse(stdout.trim()).kind).toBe("rebuilt");
  expect(failures).toEqual([]);
  expect(statSync(config.dbPath).ino).not.toBe(before);
  expect(inspectIndex(config)).toBe("current");
  expect(await read()).toContain(expected);
}, 120_000);
