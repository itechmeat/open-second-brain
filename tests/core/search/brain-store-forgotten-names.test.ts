/**
 * A forgotten record's name leaves search with it: the indexed log events
 * that name a tombstoned, forgotten or staged signal (its own `feedback`
 * event, its `tombstone` event) or a tombstoned preference are not
 * returned, while a log event naming a live record still is. The log
 * itself keeps every event (it is the audit trail); only the search
 * answers leave them out, and a cached answer naming one is not served.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { reindexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-forgotten-names-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

function capture(handle: StoreHandle, id: string, words: string, at: number, staged = false): void {
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id,
        path: `Brain/${staged ? "pending" : "inbox"}/${id}.md`,
        staged,
        frontmatter: { kind: "brain-signal", id, principle: words },
        raw: words,
      },
    },
    { now: () => at },
  );
}

function logEvent(
  handle: StoreHandle,
  eventType: string,
  body: Record<string, unknown>,
  at: number,
): string {
  return appendRecord(
    handle,
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "t",
      body: { timestamp: new Date(at).toISOString(), event_type: eventType, body },
    },
    { now: () => at },
  ).record.id;
}

function tombstoneSignal(handle: StoreHandle, signal: string, at: number): void {
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: {
        authority: "human",
        signal,
        fields: {
          _status: "tombstoned",
          tombstoned_at: "2026-11-02T10:00:00Z",
          tombstone_reason: "forget it",
        },
      },
    },
    { now: () => at },
  );
}

async function found(config: ResolvedSearchConfig, query: string): Promise<string[]> {
  const outcome = await search(config, {
    query,
    limit: 50,
    transportReach: TRANSPORT_REACH.local,
  });
  return outcome.results.map((r) => r.path);
}

test("the log events naming a tombstoned signal leave search; the ones naming a live signal stay", async () => {
  const local = fx.open(LOCAL_DEVICE);
  capture(local, "sig-2026-11-02-quokka-forget-probe", "Quokka marmot rule to forget", T0);
  capture(local, "sig-2026-11-02-quokka-keep-probe", "Quokka marmot rule to keep", T0 + 10);
  const gone = logEvent(
    local,
    "feedback",
    { signal: "[[sig-2026-11-02-quokka-forget-probe]]", topic: "quokka marmot forget" },
    T0 + 20,
  );
  const kept = logEvent(
    local,
    "feedback",
    { signal: "[[sig-2026-11-02-quokka-keep-probe]]", topic: "quokka marmot keep" },
    T0 + 30,
  );
  const config = fx.config();
  await reindexVault(config);
  const before = await found(config, "quokka marmot");
  expect(before).toContain(storeRecordPath("shared", gone));
  expect(before).toContain(storeRecordPath("shared", kept));

  tombstoneSignal(local, "sig-2026-11-02-quokka-forget-probe", T0 + 40);
  const stone = logEvent(
    local,
    "tombstone",
    { path: "Brain/inbox/sig-2026-11-02-quokka-forget-probe.md", reason: "quokka marmot" },
    T0 + 50,
  );
  // Before any catch-up: the query-time filter already hides the names.
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = String(3_600_000);
  const cached = await found(config, "quokka marmot");
  expect(cached).not.toContain(storeRecordPath("shared", gone));
  expect(cached).toContain(storeRecordPath("shared", kept));

  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  await catchUpBrainStore(config, { force: true });
  const answers = await Promise.all(
    ["quokka marmot", "sig-2026-11-02-quokka-forget-probe", "quokka-forget-probe"].map((query) =>
      found(config, query),
    ),
  );
  for (const paths of answers) {
    expect(paths).not.toContain(storeRecordPath("shared", gone));
    expect(paths).not.toContain(storeRecordPath("shared", stone));
  }
  expect(await found(config, "quokka marmot")).toContain(storeRecordPath("shared", kept));
});

test("a log event naming a staged signal is not found until the signal is approved", async () => {
  const local = fx.open(LOCAL_DEVICE);
  capture(local, "sig-2026-11-02-wombat-staged-probe", "Wombat staged probe rule", T0, true);
  const event = logEvent(
    local,
    "feedback",
    { signal: "[[sig-2026-11-02-wombat-staged-probe]]", topic: "wombat staged probe" },
    T0 + 10,
  );
  const config = fx.config();
  await reindexVault(config);
  expect(await found(config, "wombat staged probe")).not.toContain(
    storeRecordPath("shared", event),
  );
  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-state",
      agent: "t",
      body: { authority: "human", signal: "sig-2026-11-02-wombat-staged-probe", state: "approved" },
    },
    { now: () => T0 + 20 },
  );
  await catchUpBrainStore(config, { force: true });
  expect(await found(config, "wombat staged probe")).toContain(storeRecordPath("shared", event));
});

test("a log event naming a tombstoned preference is not found", async () => {
  const local = fx.open(LOCAL_DEVICE);
  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "preference-set",
      agent: "t",
      body: {
        authority: "human",
        preference: "pref-numbat-push-rule",
        fields: { principle: "Numbat push rule", status: "tombstoned" },
      },
    },
    { now: () => T0 },
  );
  const event = logEvent(
    local,
    "promote",
    { preference: "[[pref-numbat-push-rule]]", topic: "numbat push" },
    T0 + 10,
  );
  const other = logEvent(
    local,
    "promote",
    { preference: "[[pref-numbat-pull-rule]]", topic: "numbat pull" },
    T0 + 20,
  );
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "numbat");
  expect(paths).not.toContain(storeRecordPath("shared", event));
  expect(paths).toContain(storeRecordPath("shared", other));
});

test("a forgotten lane entry hides only the events that reference it, never one that shares a word", async () => {
  const local = fx.open(LOCAL_DEVICE);
  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "human",
        lane: "lists",
        entry: "groceries",
        fields: { kind: "brain-list", _status: "tombstoned" },
        text: "Kiwi pantry list",
      },
    },
    { now: () => T0 },
  );
  capture(local, "sig-2026-11-02-kiwi-budget", "Kiwi pantry budget rule", T0 + 5);
  const live = logEvent(
    local,
    "feedback",
    { signal: "[[sig-2026-11-02-kiwi-budget]]", topic: "groceries budget kiwi pantry" },
    T0 + 10,
  );
  const byPath = logEvent(
    local,
    "tombstone",
    { path: "Brain/lists/groceries.md", reason: "kiwi pantry" },
    T0 + 20,
  );
  const byLink = logEvent(local, "note", { text: "kiwi pantry see [[groceries]]" }, T0 + 30);
  const byLanePath = logEvent(local, "note", { text: "kiwi pantry [[lists/groceries]]" }, T0 + 40);
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "kiwi pantry");
  expect(paths).toContain(storeRecordPath("shared", live));
  expect(paths).not.toContain(storeRecordPath("shared", byPath));
  expect(paths).not.toContain(storeRecordPath("shared", byLink));
  expect(paths).not.toContain(storeRecordPath("shared", byLanePath));
});

test("4650588457: a forgotten signal's own page path hides an event that names only that path", async () => {
  const local = fx.open(LOCAL_DEVICE);
  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id: "sig-2026-11-02-moved-by-hand",
        path: "Brain/inbox/custom-alias.md",
        staged: false,
        frontmatter: {
          kind: "brain-signal",
          id: "sig-2026-11-02-moved-by-hand",
          principle: "Tapir rule",
        },
        raw: "Tapir rule",
      },
    },
    { now: () => T0 },
  );
  tombstoneSignal(local, "sig-2026-11-02-moved-by-hand", T0 + 5);
  const byPath = logEvent(
    local,
    "note",
    { text: "tapir note about Brain/inbox/custom-alias.md" },
    T0 + 10,
  );
  const other = logEvent(
    local,
    "note",
    { text: "tapir note about Brain/inbox/other-alias.md" },
    T0 + 20,
  );
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "tapir note");
  expect(paths).not.toContain(storeRecordPath("shared", byPath));
  expect(paths).toContain(storeRecordPath("shared", other));
});

function tombstoneLane(handle: StoreHandle, lane: string, entry: string, at: number): void {
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: { authority: "human", lane, entry, fields: { _status: "tombstoned" }, text: "x" },
    },
    { now: () => at },
  );
}

test("4650588462: a qualified link to another page of the same name is not hidden", async () => {
  const local = fx.open(LOCAL_DEVICE);
  tombstoneLane(local, "lists", "groceries", T0);
  const other = logEvent(local, "note", { text: "okapi see [[projects/groceries]]" }, T0 + 10);
  const own = logEvent(local, "note", { text: "okapi see [[lists/groceries]]" }, T0 + 20);
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "okapi");
  expect(paths).toContain(storeRecordPath("shared", other));
  expect(paths).not.toContain(storeRecordPath("shared", own));
});

test("4650588466: a forgotten lane path with a space is matched in plain text", async () => {
  const local = fx.open(LOCAL_DEVICE);
  tombstoneLane(local, "lists", "weekly groceries", T0);
  const own = logEvent(
    local,
    "tombstone",
    { path: "Brain/lists/weekly groceries.md", reason: "quoll" },
    T0 + 10,
  );
  const other = logEvent(local, "note", { text: "quoll weekly groceries budget" }, T0 + 20);
  const config = fx.config();
  await reindexVault(config);
  const paths = await found(config, "quoll");
  expect(paths).not.toContain(storeRecordPath("shared", own));
  expect(paths).toContain(storeRecordPath("shared", other));
});
