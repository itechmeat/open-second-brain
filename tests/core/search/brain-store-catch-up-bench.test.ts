/**
 * The phase 1 catch-up benchmark (design D5): with 500 unchanged shards
 * the catch-up check before a read stays under 20 ms. That budget holds
 * on a quiet workstation only, so it is asserted only when `O2B_BENCH=1`
 * asks for the benchmark. Every other run (CI, a loaded laptop, Windows
 * with a virus scanner, coverage) asserts the functional half, that no
 * shard is read, and prints the measured value without judging it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";
import { shardPath } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

const DEVICES = 100;
const MONTHS = 5;
const BUDGET_MS = 20;
/** Environment variable that asks for the strict benchmark budget. */
const BENCH_ENV = "O2B_BENCH";
const RUNS = 7;

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-bench-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

test("the catch-up check over 500 unchanged shards stays within budget", async () => {
  fx.open(LOCAL_DEVICE);
  const config = fx.config();
  await indexVault(config);
  const dirs = new Set<string>();
  for (let d = 0; d < DEVICES; d++) {
    const device = `dev-${String(d).padStart(3, "0")}`;
    for (let m = 1; m <= MONTHS; m++) {
      const month = `2026-0${m}`;
      const path = shardPath(fx.root, "shared", { stream: "digests" }, device, month);
      mkdirSync(dirname(path), { recursive: true });
      const record = buildRecord({
        hlc: { physical: Date.UTC(2026, m - 1, 2), counter: d },
        device,
        agent: "bench",
        kind: "digest",
        body: { n: d * MONTHS + m },
      });
      writeFileSync(path, `${JSON.stringify(record)}\n`);
      dirs.add(dirname(path));
      dirs.add(dirname(dirname(path)));
    }
  }
  // A store at rest: its directories were last changed well before now.
  const past = new Date(Date.now() - 60_000);
  for (const dir of dirs) utimesSync(dir, past, past);

  const first = await catchUpBrainStore(config);
  expect(first.added).toBe(DEVICES * MONTHS);

  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    // Sequential by design: each run measures one catch-up check on its own.
    // eslint-disable-next-line no-await-in-loop
    const result = await catchUpBrainStore(config);
    samples.push(performance.now() - t0);
    expect(result).toMatchObject({ skipped: null, shardsRead: 0 });
  }
  const median = samples.toSorted((a, b) => a - b)[Math.floor(RUNS / 2)]!;
  const benchmark = process.env[BENCH_ENV] === "1";
  // eslint-disable-next-line no-console
  console.log(
    `catch-up check, ${DEVICES * MONTHS} unchanged shards: median ${median.toFixed(2)} ms ` +
      `(runs: ${samples.map((s) => s.toFixed(2)).join(", ")}; ` +
      `${benchmark ? `budget ${BUDGET_MS} ms` : `not judged, set ${BENCH_ENV}=1`})`,
  );
  if (benchmark) expect(median).toBeLessThan(BUDGET_MS);
}, 60_000);
