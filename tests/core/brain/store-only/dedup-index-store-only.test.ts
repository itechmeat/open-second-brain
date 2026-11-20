/**
 * The signal dedup index on a switched vault with no `Brain/` tree. Every
 * capture path (inline scan, session import, fact extraction, the session
 * lifecycle) skips a signal whose `dedup_hash` the index holds; on a
 * switched machine the signals are store records, so the index is built
 * from them, or the same rule is captured again on every run.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildDedupIndex,
  computeDedupHash,
  loadDedupIndex,
} from "../../../../src/core/brain/dedup-hash.ts";
import { createSafeguard, SafeguardTimeoutError } from "../../../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("the dedup index holds the store's signals on a vault with no Brain/", async () => {
  env = makeStoreEnv("osb-dedup-store-", { legacyTree: false });
  const hash = computeDedupHash({ topic: "tabs", signal: "positive", principle: "Use tabs" });
  writeSignal(env.vault, {
    topic: "tabs",
    signal: "positive",
    agent: "claude",
    principle: "Use tabs",
    created_at: "2026-11-20T10:00:00Z",
    date: "2026-11-20",
    slug: "use-tabs",
    dedup_hash: hash,
  });
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const sync = buildDedupIndex(env.vault);
  expect(sync.get(hash)?.id).toMatch(/use-tabs/);
  const loaded = await loadDedupIndex(env.vault);
  expect(loaded.get(hash)).toEqual(sync.get(hash));
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("the store fold honours the hook deadline at its record boundaries", () => {
  env = makeStoreEnv("osb-dedup-deadline-", { legacyTree: false });
  for (let i = 0; i < 20; i++) {
    writeSignal(env.vault, {
      topic: `tabs-${i}`,
      signal: "positive",
      agent: "claude",
      principle: `Use tabs ${i}`,
      created_at: "2026-11-20T10:00:00Z",
      date: "2026-11-20",
      slug: `use-tabs-${i}`,
      dedup_hash: computeDedupHash({
        topic: `tabs-${i}`,
        signal: "positive",
        principle: `Use tabs ${i}`,
      }),
    });
  }
  // A clock that advances one millisecond per look: the deadline passes
  // a few records into the fold, after the first checkpoint.
  let clock = 0;
  const safeguard = createSafeguard({ operation: "dedup", timeoutMs: 5, now: () => clock++ });
  expect(() => buildDedupIndex(env!.vault, { safeguard })).toThrow(SafeguardTimeoutError);
  // Nothing half-read was kept: a read with no deadline sees every signal.
  expect(buildDedupIndex(env.vault).size).toBe(20);
});
