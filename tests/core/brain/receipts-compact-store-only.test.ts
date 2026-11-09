/**
 * The store-only guard of `compactReceiptLedgers` (task 2.10, design D14
 * item 1): on a switched machine the legacy receipt ledgers are read-only,
 * so a real compaction is refused and leaves the shards byte-identical,
 * while a dry run still previews them and writes nothing. The unswitched
 * cases live in `receipts-compact.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { continuityLogDir } from "../../../src/core/brain/continuity/store.ts";
import { resolveAppendShardId } from "../../../src/core/brain/ledger-shards.ts";
import { compactReceiptLedgers } from "../../../src/core/brain/receipts/compact.ts";
import { RECEIPT_LEDGER_FAMILY } from "../../../src/core/brain/receipts/types.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const NOW = new Date("2026-09-25T00:00:00Z");

function continuityLine(kind: string, createdAt: string): string {
  const id = `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${kind}`;
  return `${JSON.stringify({
    schema: "o2b.continuity.v1",
    id,
    kind,
    createdAt,
    sourceRefs: [],
    payload: {},
    private: false,
    redacted: false,
  })}\n`;
}

let env: StoreEnv;
let shard: string;

beforeEach(() => {
  // A switched machine that still holds its legacy tree, receipts and all.
  env = makeStoreEnv("osb-receipts-store-only-");
  shard = `2026-08.${resolveAppendShardId()}.jsonl`;
  mkdirSync(continuityLogDir(env.vault), { recursive: true });
  writeFileSync(
    join(continuityLogDir(env.vault), shard),
    continuityLine("recall_telemetry", "2026-08-10T12:00:00Z") +
      continuityLine("recall_telemetry", "2026-08-20T12:00:00Z"),
  );
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

function compact(dryRun: boolean) {
  return compactReceiptLedgers(env.vault, {
    shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: shard }],
    now: NOW,
    dryRun,
  });
}

describe("receipt compaction on a switched machine", () => {
  test("a real run is refused and the shards stay byte-identical", () => {
    const before = digestVaultTree(env.vault, { mtime: true });
    expect(() => compact(false)).toThrow(/receipt compaction refused/);
    expect(digestVaultTree(env.vault, { mtime: true })).toBe(before);
  });

  test("a dry run still previews the legacy shards and writes nothing", () => {
    const before = digestVaultTree(env.vault, { mtime: true });
    const preview = compact(true);
    expect(preview.dryRun).toBe(true);
    expect(preview.failures).toEqual([]);
    expect(preview.totals.folded).toBe(2);
    expect(digestVaultTree(env.vault, { mtime: true })).toBe(before);
  });
});
