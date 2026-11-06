/**
 * Catch-up under the moves a sync tool and a compaction make (design D5):
 * a record two shards hold for a while, a shard swapped while it is read,
 * a blob that arrives broken, and a pass that stops partway. In each case
 * the index must end up holding what the store holds, without a rebuild
 * and without reopening the index on every read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { INDEX_REVISION_STATE_KEY } from "../../../src/core/search/store/state.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import * as blobs from "../../../src/core/store/blobs.ts";
import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { blobPath, partitionDir, shardPath } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-races-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

async function readyIndex(): Promise<ResolvedSearchConfig> {
  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  return config;
}

async function found(config: ResolvedSearchConfig, query: string): Promise<string[]> {
  const outcome = await search(config, { query, limit: 10, transportReach: TRANSPORT_REACH.local });
  return [...new Set(outcome.results.map((r) => r.path))];
}

async function readState(config: ResolvedSearchConfig, key: string): Promise<string | null> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return store.getState(key);
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

function remoteShard(month: string, suffix = ""): string {
  const path = shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, month);
  return suffix === "" ? path : path.replace(/\.jsonl$/, `.${suffix}.jsonl`);
}

function writeShard(path: string, text: string): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
}

// A mode bit is the portable way to make one shard unreadable; it cannot
// stop root or a Windows reader.
const canDenyRead = !CHMOD_CANNOT_DENY;
// Windows refuses a rename over a file another handle holds open (EPERM), so a
// shard cannot be swapped under a reader that has it open there.
const testSwapUnderOpenReader = test.skipIf(IS_WINDOWS);

describe("catch-up races", () => {
  test("a compacted-away shard leaves the records its replacement holds", async () => {
    const config = await readyIndex();
    const a = remoteRecord("Stilt colony decision", Date.UTC(2026, 0, 5));
    const old = remoteShard("2026-01");
    const compacted = remoteShard("2026-01", "c1");
    // Both shards exist in one pass; the old one sorts last, so the
    // record is credited to it.
    writeShard(old, line(a));
    writeShard(compacted, line(a));
    await catchUpBrainStore(config);
    fs.rmSync(old);
    const pass = await catchUpBrainStore(config);
    expect(pass.removed).toBe(0);
    expect(await found(config, "stilt colony")).toEqual([storeRecordPath("shared", a.id)]);
    // Credited to the shard that holds it now: removing that one removes it.
    fs.rmSync(compacted);
    expect((await catchUpBrainStore(config)).removed).toBe(1);
    expect(await found(config, "stilt colony")).toEqual([]);
  });

  test.skipIf(!canDenyRead)(
    "a vanished shard does not read the device's other months to settle its records",
    async () => {
      const config = await readyIndex();
      const jan = remoteShard("2026-01");
      const feb = remoteShard("2026-02");
      writeShard(jan, line(remoteRecord("Sanderling decision", Date.UTC(2026, 0, 5))));
      writeShard(feb, line(remoteRecord("Dunlin decision", Date.UTC(2026, 1, 5))));
      await catchUpBrainStore(config);
      fs.chmodSync(feb, 0o000);
      try {
        fs.rmSync(jan);
        const pass = await catchUpBrainStore(config);
        expect(pass.skipped).toBeNull();
        expect(pass.removed).toBe(1);
      } finally {
        fs.chmodSync(feb, 0o644);
      }
    },
  );

  test.skipIf(!canDenyRead)(
    "a same-month sibling that cannot be read keeps the orphans instead of failing the pass",
    async () => {
      const config = await readyIndex();
      const a = remoteRecord("Whimbrel decision", Date.UTC(2026, 0, 5));
      const old = remoteShard("2026-01");
      const compacted = remoteShard("2026-01", "c1");
      writeShard(old, line(a));
      writeShard(compacted, line(a));
      await catchUpBrainStore(config);
      fs.chmodSync(compacted, 0o000);
      try {
        fs.rmSync(old);
        const pass = await catchUpBrainStore(config);
        expect(pass.skipped).toBeNull();
        expect(pass.removed).toBe(0);
      } finally {
        fs.chmodSync(compacted, 0o644);
      }
      expect(await found(config, "whimbrel")).toEqual([storeRecordPath("shared", a.id)]);
    },
  );

  test.skipIf(!canDenyRead)(
    "orphans a sibling could not settle are retried once it reads again",
    async () => {
      const config = await readyIndex();
      const a = remoteRecord("Godwit decision", Date.UTC(2026, 0, 5));
      const b = remoteRecord("Redshank decision", Date.UTC(2026, 0, 6));
      const old = remoteShard("2026-01");
      const sibling = remoteShard("2026-01", "c1");
      writeShard(old, line(a));
      // The sibling does not hold `a`: once it can be read, `a` has no shard.
      writeShard(sibling, line(b));
      await catchUpBrainStore(config);
      fs.chmodSync(sibling, 0o000);
      try {
        fs.rmSync(old);
        expect((await catchUpBrainStore(config)).removed).toBe(0);
        expect((await catchUpBrainStore(config)).removed).toBe(0);
      } finally {
        fs.chmodSync(sibling, 0o644);
      }
      expect((await catchUpBrainStore(config)).removed).toBe(1);
      expect(await found(config, "godwit")).toEqual([]);
      expect(await found(config, "redshank")).toEqual([storeRecordPath("shared", b.id)]);
    },
  );

  testSwapUnderOpenReader(
    "a shard swapped for a same-size file during its read is read again",
    async () => {
      const config = await readyIndex();
      const shard = remoteShard("2026-11");
      const a = remoteRecord("alpha knot", Date.UTC(2026, 10, 3));
      const b = remoteRecord("bravo knot", Date.UTC(2026, 10, 3));
      const c = remoteRecord("delta knot", Date.UTC(2026, 10, 3));
      expect(new Set([line(a).length, line(b).length, line(c).length]).size).toBe(1);
      writeShard(shard, line(a));
      await catchUpBrainStore(config);

      const swap = (text: string): void => {
        const tmp = join(dirname(shard), "swap.tmp");
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, shard);
      };
      swap(line(b));
      const realOpen = fs.openSync;
      let swapped = false;
      const open = spyOn(fs, "openSync").mockImplementation(((
        ...args: Parameters<typeof realOpen>
      ) => {
        const fd = realOpen(...args);
        // The reader holds the file it opened; the sync tool swaps the path.
        if (!swapped && String(args[0]) === shard) {
          swapped = true;
          swap(line(c));
        }
        return fd;
      }) as typeof realOpen);
      try {
        await catchUpBrainStore(config);
      } finally {
        open.mockRestore();
      }
      expect(swapped).toBe(true);
      // The pass read b; the next one must not trust the stat it took of c.
      await catchUpBrainStore(config);
      expect(await found(config, "knot")).toEqual([storeRecordPath("shared", c.id)]);
    },
  );

  test("a blob that arrives just after the pass looked for it is read on the next pass", async () => {
    const config = await readyIndex();
    const { record, spilled } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: `Avocet census ${"lorem ".repeat(4000)}` },
    });
    expect(spilled).toBe(true);
    const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
    const bytes = fs.readFileSync(blob);
    fs.rmSync(blob);
    // The sync tool delivers the blob right after the pass's last look for
    // it (the shard read looks first, the pending-body loop last).
    const original = blobs.readBlob;
    let looks = 0;
    const read = spyOn(blobs, "readBlob").mockImplementation((root, sha) => {
      const answer = original(root, sha);
      looks += 1;
      if (looks === 2) fs.writeFileSync(blob, bytes);
      return answer;
    });
    try {
      expect((await catchUpBrainStore(config)).completed).toBe(0);
    } finally {
      read.mockRestore();
    }
    expect(looks).toBe(2);
    expect((await catchUpBrainStore(config)).completed).toBe(1);
    expect(await found(config, "avocet census")).toEqual([storeRecordPath("shared", record.id)]);
  });

  test("a blob that fails verification does not reopen the index on every read", async () => {
    const config = await readyIndex();
    const { record, spilled } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: `Pratincole survey ${"lorem ".repeat(4000)}` },
    });
    expect(spilled).toBe(true);
    const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
    const bytes = fs.readFileSync(blob);
    fs.rmSync(blob);
    await catchUpBrainStore(config);

    fs.writeFileSync(blob, bytes.subarray(0, bytes.length - 10));
    await catchUpBrainStore(config);
    const open = spyOn(Store, "open");
    try {
      expect(await catchUpBrainStore(config)).toMatchObject({ skipped: null, completed: 0 });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
    fs.writeFileSync(blob, bytes);
    expect((await catchUpBrainStore(config)).completed).toBe(1);
  });

  test.skipIf(!canDenyRead)("a pass that stops partway still moves the revision", async () => {
    const config = await readyIndex();
    const before = Number(await readState(config, INDEX_REVISION_STATE_KEY));
    writeShard(remoteShard("2026-10"), line(remoteRecord("Ruff decision", Date.UTC(2026, 9, 3))));
    const broken = remoteShard("2026-12");
    writeShard(broken, line(remoteRecord("Unread decision", Date.UTC(2026, 11, 3))));
    fs.chmodSync(broken, 0o000);
    try {
      const pass = await catchUpBrainStore(config);
      expect(pass.skipped).toBe("failed");
      expect(Number(await readState(config, INDEX_REVISION_STATE_KEY))).toBeGreaterThan(before);
    } finally {
      fs.chmodSync(broken, 0o644);
    }
    expect((await catchUpBrainStore(config)).skipped).toBeNull();
    expect((await found(config, "decision")).length).toBe(2);
  });

  test.skipIf(!canDenyRead)("a rebuild survives a shard it cannot read", async () => {
    const config = await readyIndex();
    const broken = remoteShard("2026-11");
    writeShard(broken, line(remoteRecord("Unread decision", Date.UTC(2026, 10, 3))));
    fs.chmodSync(broken, 0o000);
    try {
      await reindexVault(config);
      expect(await found(config, "note")).toEqual(["notes/a.md"]);
    } finally {
      fs.chmodSync(broken, 0o644);
    }
    // The next catch-up reads the shard the rebuild could not.
    expect(await found(config, "unread decision")).toHaveLength(1);
  });
});

describe("a failed catch-up on the search trail", () => {
  test.skipIf(!canDenyRead)("is a typed degradation beside its warning", async () => {
    const config = await readyIndex();
    const broken = remoteShard("2026-11");
    writeShard(broken, line(remoteRecord("Unread decision", Date.UTC(2026, 10, 3))));
    fs.chmodSync(broken, 0o000);
    try {
      const outcome = await search(config, {
        query: "note",
        limit: 5,
        transportReach: TRANSPORT_REACH.local,
      });
      expect(outcome.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("brain store catch-up failed")]),
      );
      expect(outcome.retrievalTrail?.degraded.map((d) => d.code)).toContain(
        RETRIEVAL_DEGRADATION.storeCatchUpFailed,
      );
    } finally {
      fs.chmodSync(broken, 0o644);
    }
  });
});
