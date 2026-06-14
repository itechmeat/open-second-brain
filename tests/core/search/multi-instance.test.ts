/**
 * Multi-instance isolation + writer-lock heartbeat (Indexer Durability
 * suite, t_ea80ddb5 / t_672c751e). The honest OSB reading of upstream's
 * "multi-instance" support: the MCP server is stdio-only, so there is
 * no port to multiplex. Isolation comes from the per-dbPath writer
 * lock - two instances on DIFFERENT vaults run conflict-free, and a
 * second writer on the SAME vault gets a typed INDEX_LOCKED rather than
 * corrupting the index. No --port / --instance daemon is fabricated.
 *
 * The heartbeat constants are pinned here so a future edit cannot
 * silently drop the lock refresh below the stale window.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  Store,
  WRITER_LOCK_HEARTBEAT_MS,
  WRITER_LOCK_STALE_MS,
} from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

const vaults: Array<() => void> = [];

beforeEach(() => {
  vaults.length = 0;
});

afterEach(() => {
  for (const c of vaults) c();
});

function freshConfig(prefix: string) {
  const v = createTempVault(prefix);
  vaults.push(v.cleanup);
  return makeConfig({ vault: v.vault, dbPath: v.dbPath });
}

test("the heartbeat refreshes well within the stale window", () => {
  expect(WRITER_LOCK_HEARTBEAT_MS).toBeGreaterThan(0);
  expect(WRITER_LOCK_HEARTBEAT_MS).toBeLessThan(WRITER_LOCK_STALE_MS);
});

test("writers on different vaults coexist", async () => {
  const a = freshConfig("multi-a");
  const b = freshConfig("multi-b");
  const sa = await Store.open(a, { mode: "write" });
  const sb = await Store.open(b, { mode: "write" });
  expect(sa).toBeInstanceOf(Store);
  expect(sb).toBeInstanceOf(Store);
  await sa.close();
  await sb.close();
});

test("a second writer on the same vault gets INDEX_LOCKED", async () => {
  const cfg = freshConfig("multi-same");
  const first = await Store.open(cfg, { mode: "write" });
  try {
    await Store.open(cfg, { mode: "write" });
    throw new Error("expected the second writer to be rejected");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect(e).toHaveProperty("code", "INDEX_LOCKED");
  } finally {
    await first.close();
  }
});

test("the lock is released on close: a later writer succeeds", async () => {
  const cfg = freshConfig("multi-reopen");
  const first = await Store.open(cfg, { mode: "write" });
  await first.close();
  const second = await Store.open(cfg, { mode: "write" });
  expect(second).toBeInstanceOf(Store);
  await second.close();
});
