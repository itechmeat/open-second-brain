/**
 * The first build of a store-aware index (the first start after the brain
 * moved into the brain store): there is no index to keep answering from,
 * and the build of a large store takes minutes. While a background
 * rebuild builds it, a search answers from what the build has indexed so
 * far and says so; every other read is refused with a message that names
 * the running build instead of a command that would queue behind it.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { IndexBuildingError, stagingIndexPath } from "../../../src/core/search/build-progress.ts";
import { openReadOrSelfHeal } from "../../../src/core/search/pipeline/store-open.ts";
import { search } from "../../../src/core/search/search.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { fileContextRecall } from "../../../src/core/brain/file-recall.ts";
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

const NOTES = 12;
/** The rebuild pauses at this indexed file: the ones before it are committed. */
const PAUSE_AT = 6;
const WORKER = join(import.meta.dir, "fixtures", "store-rebuild-worker.ts");

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-first-build-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

test("a search answers from what the first build has indexed so far, and says so", async () => {
  fx.open(LOCAL_DEVICE);
  for (let i = 0; i < NOTES; i++) {
    fx.writeNote(`notes/n${i}.md`, `# Note ${i}\n\nOrdinary note number ${i} about the estuary.\n`);
  }
  appendRecord(fx.open(REMOTE_DEVICE), {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    body: { text: "Turnstone ringing decision" },
  });
  const config = fx.config();
  expect(existsSync(config.dbPath)).toBe(false);

  const signal = join(fx.parent, "rebuild-locked");
  const gate = join(fx.parent, "rebuild-go");
  const child = Bun.spawn([process.execPath, WORKER, fx.parent, signal, gate, String(PAUSE_AT)], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!existsSync(signal) && !exited) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(5);
  }
  try {
    expect(existsSync(signal)).toBe(true);
    expect(isWriterLockHeld(config.dbPath)).toBe(true);
    expect(existsSync(config.dbPath)).toBe(false);

    const outcome = await search(config, {
      query: "estuary",
      limit: 20,
      transportReach: TRANSPORT_REACH.local,
    });
    // Notes committed before the pause answer; nothing is an error.
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.length).toBeLessThan(NOTES);
    const building = outcome.warnings.filter((w) =>
      w.startsWith("the search index is being built"),
    );
    expect(building).toHaveLength(1);
    expect(building[0]).toContain("these results come from what it has indexed so far");
    expect(outcome.retrievalTrail?.degraded?.map((d) => d.code)).toContain(
      RETRIEVAL_DEGRADATION.indexBuilding,
    );
    // The file-recall surface says so too: no result there may only not be indexed yet.
    const recall = await fileContextRecall(config, {
      filePath: join(fx.vault, "notes", "turnstone.md"),
      minBytes: 0,
      transportReach: TRANSPORT_REACH.local,
    });
    expect(recall.skipped).toBe(false);
    expect(recall.degraded).toContain(RETRIEVAL_DEGRADATION.indexBuilding);
    expect(recall.warnings.some((w) => w.startsWith("the search index is being built"))).toBe(true);
    // The answer wrote nothing into the file the build will swap in.
    expect(existsSync(config.dbPath)).toBe(false);

    // A read that does not opt in is refused at once, naming the build.
    const started = Date.now();
    const refusal = await openReadOrSelfHeal(config).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(IndexBuildingError);
    expect((refusal as IndexBuildingError).code).toBe("INDEX_MISSING");
    expect((refusal as Error).message).toContain("the search index is being built (started");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    // Whatever failed above, the worker ends before the fixture is removed.
    writeFileSync(gate, "go\n");
    await child.exited;
  }
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
  expect(existsSync(stagingIndexPath(config.dbPath))).toBe(false);
  expect(existsSync(`${config.dbPath}.building.json`)).toBe(false);
  // After the swap the whole index answers, store records included.
  const after = await search(config, {
    query: "turnstone",
    limit: 5,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(after.results.length).toBe(1);
  expect(after.warnings.some((w) => w.startsWith("the search index is being built"))).toBe(false);
});
