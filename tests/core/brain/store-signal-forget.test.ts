/**
 * Signals of the store on a store-only machine. Forgetting one
 * (`removeStoreSignal`): the tombstone reaches every partition that holds
 * a record of the signal, so a machine holding only `shared` forgets a
 * shared capture whose later records went to `private`. Parsing one: a
 * migrated record's page body reads as the page.
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { signalPageRaw, storeMemoryPage } from "../../../src/core/brain/memory-pages.ts";
import { compress, CODEC_VERSION } from "../../../src/core/brain/portability/codec.ts";
import { parseStoreSignal, writeSignal } from "../../../src/core/brain/signal.ts";
import { signalRecord } from "../../../src/core/store/dual-write-records.ts";
import { removeStoreSignal, storeSignal } from "../../../src/core/brain/signal-state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SIGNAL_REMOVED_KIND, SIGNAL_STATE_KIND } from "../../../src/core/store/fold-signals.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { StoreWriteError } from "../../../src/core/store/store-write.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function tombstonesIn(partition: "shared" | "private"): number {
  return readPartition(join(env!.storeRoot, partition))
    .flatMap((shard) => shard.all)
    .filter((r) => r.kind === SIGNAL_REMOVED_KIND).length;
}

test("a shared capture with a private later record is forgotten in both partitions", () => {
  env = makeStoreEnv("osb-forget-signal-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const { id } = writeSignal(env.vault, {
    topic: "forget-me",
    signal: "positive",
    agent: "claude",
    principle: "Principle of forget-me",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "forget-me",
  });
  appendRecord(store, {
    partition: "private",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "claude",
    body: { authority: "agent", signal: id, fields: { note: "kept private" } },
  });
  expect(storeSignal(id)?.partition).toBe("shared");
  expect(storeSignal(id)?.private).toBe(true);

  expect(removeStoreSignal(env.vault, id)).toBe(true);
  expect(tombstonesIn("shared")).toBe(1);
  expect(tombstonesIn("private")).toBe(1);
  expect(storeSignal(id)).toBeUndefined();
});

test("a removal while a shard of the signal is gone since this machine read it refuses", () => {
  env = makeStoreEnv("osb-forget-signal-gone-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const { id } = writeSignal(env.vault, {
    topic: "forget-me",
    signal: "positive",
    agent: "claude",
    principle: "Principle of forget-me",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "forget-me",
  });
  const peer = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
    partition: "private",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "claude",
    body: { authority: "agent", signal: id, fields: { note: "kept private" } },
  }).path;
  expect(storeSignal(id)?.private).toBe(true);
  rmSync(peer);
  expect(() => removeStoreSignal(env!.vault, id)).toThrow(StoreWriteError);
  expect(tombstonesIn("shared")).toBe(0);
  expect(tombstonesIn("private")).toBe(0);
});

test("a removal whose shared tombstone failed is finished by a retry", () => {
  env = makeStoreEnv("osb-forget-signal-retry-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const { id } = writeSignal(env.vault, {
    topic: "forget-me",
    signal: "positive",
    agent: "claude",
    principle: "Principle of forget-me",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "forget-me",
  });
  // The private tombstone landed, the shared one did not: this machine
  // folds the signal as forgotten, a machine holding only shared does not.
  appendRecord(store, {
    partition: "private",
    stream: "events",
    kind: SIGNAL_REMOVED_KIND,
    agent: "claude",
    body: { authority: "agent", signal: id },
  });
  expect(storeSignal(id)).toBeUndefined();
  expect(removeStoreSignal(env.vault, id)).toBe(true);
  expect(tombstonesIn("shared")).toBe(1);
  expect(removeStoreSignal(env.vault, id)).toBe(false);
});

test("a migrated signal record's page body parses as the page, with no doubled heading", () => {
  const fm = {
    kind: "brain-signal",
    id: "sig-2026-11-06-migrated",
    topic: "migrated",
    signal: "positive",
    agent: "claude",
    principle: "Migrated principle",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    tags: ["brain/signal"],
  };
  const bare = parseStoreSignal("Brain/inbox/x.md", fm, "the quote");
  const migrated = parseStoreSignal("Brain/inbox/x.md", fm, "## Raw\n\nthe quote\n", {
    rawShape: "page",
  });
  expect(bare.raw).toBe("the quote");
  expect(migrated.raw).toBe("the quote");
});

test("a captured quote that starts with a Raw heading reads back as written", () => {
  env = makeStoreEnv("osb-signal-raw-heading-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const quote = "## Raw\n\npasted markdown that opens with a heading";
  const { id } = writeSignal(env.vault, {
    topic: "pasted",
    signal: "positive",
    agent: "claude",
    principle: "Principle of pasted",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "pasted",
    raw: quote,
  });
  const page = storeMemoryPage(env.vault, id)!;
  expect(page.body).toBe(`## Raw\n\n${quote}\n`);
});

test("a migrated signal record rebuilds as a page with one heading over the expanded text", () => {
  env = makeStoreEnv("osb-migrated-signal-page-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const quote = "the quote,        with a long run of spaces the codec collapses";
  const id = "sig-2026-11-06-migrated";
  // What the migration imports from a page written with the codec on:
  // the page body itself, heading included, still compressed.
  const record = signalRecord({
    vault: env.vault,
    path: join(env.vault, "Brain", "inbox", `${id}.md`),
    id,
    staged: false,
    frontmatter: {
      kind: "brain-signal",
      id,
      topic: "migrated",
      signal: "positive",
      agent: "claude",
      principle: "Migrated principle",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      tags: ["brain/signal"],
      _raw_codec: CODEC_VERSION,
    },
    raw: `## Raw\n\n${compress(quote)}\n`,
    rawShape: "page",
    private: false,
  });
  appendRecord(store, { ...record, agent: "claude", partition: "shared" });
  const page = storeMemoryPage(env.vault, id)!;
  expect(page.body).toBe(`## Raw\n\n${quote}\n`);
  expect(parseStoreSignal(page.path, page.meta, signalPageRaw(page)).raw).toBe(quote);
});
