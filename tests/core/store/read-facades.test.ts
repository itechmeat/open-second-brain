/**
 * The read facades (task 2.10, design D14): for one fixture written by the
 * real legacy writers with dual writes on, each facade returns the same
 * data from the store as from the legacy files. The legacy side is what an
 * unswitched machine reads; the store side is what the same machine reads
 * once switched (injected here so the fixture stays identical).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { writePinnedContext, appendPinnedContext } from "../../../src/core/brain/pinned.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { readQueryDemand, recordQueryDemand } from "../../../src/core/brain/query-demand.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { readLedgerRows } from "../../../src/core/store/read/ledger-rows.ts";
import { readLogEvents, readLogEventsReport } from "../../../src/core/store/read/log-events.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { readPinned } from "../../../src/core/store/read/pinned.ts";
import { readPreferences, readRetired } from "../../../src/core/store/read/preferences.ts";
import { readSource, type ReadContext } from "../../../src/core/store/read/read-context.ts";
import { readSignals, signalPagePath } from "../../../src/core/store/read/signals.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv;

function legacy(): ReadContext {
  return { vault: env.vault };
}

function store(): ReadContext {
  return { vault: env.vault, storeOnly: { readSwitched: () => true } };
}

function writePref(slug: string, extra: Record<string, unknown> = {}): string {
  return writePreference(env.vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
    scope: "writing",
    ...extra,
  }).path;
}

beforeEach(() => {
  env = makeStoreEnv("osb-read-facades-");
  writePref("alpha");
  writePref("beta");
  const gamma = writePref("gamma");
  moveToRetired(env.vault, gamma, "user-rejected", {
    now: new Date("2026-11-06T12:00:00Z"),
    retired_by: "[[operator]]",
  });
  writeSignal(env.vault, {
    topic: "facades",
    signal: "positive",
    agent: "claude",
    principle: "Read through one facade",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "facades",
    scope: "coding",
    raw: "the user said so",
  });
  writePinnedContext(env.vault, "first line");
  appendPinnedContext(env.vault, "second line");
  appendLogEvent(env.vault, {
    timestamp: "2026-11-06T10:01:00Z",
    eventType: "note",
    agent: "claude",
    body: { text: "a milestone" },
  });
  // A fixed clock: on the wall clock the event would land on whatever day
  // the suite runs, and on 2026-11-07 that is inside the range below that
  // must read empty.
  appendApplyEvidence(
    env.vault,
    { pref_id: "pref-alpha", artifact: "[[some-note]]", result: "applied", agent: "claude" },
    { now: new Date("2026-11-06T10:02:00Z") },
  );
  recordQueryDemand(env.vault, { query: "salary negotiation", resultCount: 1 });
});

afterEach(() => {
  env.cleanup();
});

describe("the read source", () => {
  test("an unswitched machine reads the legacy tree, a switched one the store", () => {
    expect(readSource(legacy())).toEqual({ kind: "legacy", vault: env.vault });
    expect(readSource(store()).kind).toBe("store");
  });
});

describe("each facade returns the same data from the store as from the legacy files", () => {
  test("preferences", () => {
    const fromLegacy = readPreferences(legacy());
    const fromStore = readPreferences(store());
    expect(fromLegacy.map((p) => p.id)).toEqual(["pref-alpha", "pref-beta"]);
    const strip = (entries: typeof fromLegacy) => entries.map(({ counters: _c, ...rest }) => rest);
    expect(strip(fromStore)).toEqual(strip(fromLegacy));
    expect(fromStore.map((p) => p.private)).toEqual(fromLegacy.map((p) => p.private));
  });

  test("evidence counters are derived in the fold", () => {
    const alpha = readPreferences(store()).find((p) => p.id === "pref-alpha")!;
    expect(alpha.counters.applied_count).toBe(1);
  });

  test("retired preferences", () => {
    const fromLegacy = readRetired(legacy());
    const fromStore = readRetired(store());
    expect(fromLegacy.map((p) => p.id)).toEqual(["pref-gamma"]);
    expect(fromStore.map(({ fields: _f, ...rest }) => rest)).toEqual(
      fromLegacy.map(({ fields: _f, ...rest }) => rest),
    );
    // The fold keeps every field a record set; the retired page shows a subset of them.
    const storeFields = fromStore[0]!.fields;
    for (const [name, value] of Object.entries(fromLegacy[0]!.fields)) {
      expect([name, storeFields[name]]).toEqual([name, value]);
    }
  });

  test("signals", () => {
    const fromLegacy = readSignals(legacy());
    expect(fromLegacy).toHaveLength(1);
    expect(readSignals(store())).toEqual(fromLegacy);
  });

  test("pinned context", () => {
    const fromLegacy = readPinned(legacy());
    expect(fromLegacy.present).toBe(true);
    expect(readPinned(store())).toEqual(fromLegacy);
  });

  test("log events", () => {
    const range = { from: "2026-11-05", to: "2026-11-07" };
    const fromLegacy = readLogEvents(range, legacy());
    expect(fromLegacy.length).toBeGreaterThanOrEqual(2);
    expect(readLogEvents(range, store())).toEqual(fromLegacy);
    // Days outside the fixture's events (all on 2026-11-06, none on the
    // wall clock) hold none, on either side of the range.
    expect(readLogEvents({ from: "2026-11-04", to: "2026-11-04" }, store())).toEqual([]);
    for (const source of [legacy(), store()]) {
      expect(readLogEvents({ from: "2026-11-07", to: "2099-12-31" }, source)).toEqual([]);
    }
  });

  test("ledger rows", () => {
    const fromLegacy = readLedgerRows("query-demand", (v) => readQueryDemand(v), legacy());
    expect(fromLegacy).toHaveLength(1);
    expect(readLedgerRows("query-demand", (v) => readQueryDemand(v), store())).toEqual(fromLegacy);
  });
});

describe("a store-only machine with no store reads as empty", () => {
  test("every facade", () => {
    env.cleanup();
    env = makeStoreEnv("osb-read-facades-empty-", { legacyTree: false, partitions: [] });
    const ctx: ReadContext = { vault: null };
    expect(readPreferences(ctx)).toEqual([]);
    expect(readSignals(ctx)).toEqual([]);
    expect(readPinned(ctx)).toEqual({ present: false, content: "" });
    expect(readLogEvents({ from: "2026-11-01", to: "2026-11-30" }, ctx)).toEqual([]);
    expect(readRetired(ctx)).toEqual([]);
    expect(readLedgerRows("metrics", () => [1], ctx)).toEqual([]);
  });
});

describe("read facades over an imperfect store", () => {
  test("a ledger-row record without a row is no row", () => {
    appendRecord(openStore({ root: env.storeRoot, device: "dev-z" }), {
      partition: "shared",
      stream: "ledgers",
      ledger: "query-demand",
      kind: "ledger-row",
      agent: "t",
      body: { note: "no row field" },
    });
    expect(readLedgerRows("query-demand", () => [], store()).every((r) => r !== undefined)).toBe(
      true,
    );
  });

  // POSIX modes only, and root reads a 0000 file anyway.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a log shard that cannot be read is named, and a folder that cannot be listed does not throw",
    () => {
      const at = Date.UTC(2026, 10, 6, 9);
      const shard = appendRecord(
        openStore({ root: env.storeRoot, device: "dev-z" }),
        {
          partition: "shared",
          stream: "log",
          kind: "log-event",
          agent: "t",
          body: { timestamp: new Date(at).toISOString(), event_type: "note", body: {} },
        },
        { now: () => at },
      ).path;
      const range = { from: "2026-11-01", to: "2026-11-30" };
      chmodSync(shard, 0o000);
      try {
        expect(readLogEventsReport(range, store()).unreadable).toHaveLength(1);
      } finally {
        chmodSync(shard, 0o644);
      }
      const folder = join(env.storeRoot, "shared", "log");
      chmodSync(folder, 0o000);
      try {
        expect(readLogEventsReport(range, store()).unreadable).toEqual(["shared/log"]);
      } finally {
        chmodSync(folder, 0o755);
      }
    },
  );
});

describe("the signal facade", () => {
  test("a page left in two folders is one signal, in the later folder", () => {
    const inbox = join(env.vault, "Brain", "inbox");
    const processed = join(inbox, "processed");
    mkdirSync(processed, { recursive: true });
    const page = readdirSync(inbox).find((n) => n.startsWith("sig-"))!;
    copyFileSync(join(inbox, page), join(processed, page));
    const all = readSignals(legacy(), { states: "all" }).filter((s) => s.path.endsWith(page));
    expect(all.map((s) => [s.state, s.path])).toEqual([
      ["consumed", `Brain/inbox/processed/${page}`],
    ]);
  });

  test("a store signal's path is where its state puts the page", () => {
    expect(signalPagePath("Brain/inbox/sig-x.md", "consumed")).toBe(
      "Brain/inbox/processed/sig-x.md",
    );
    expect(signalPagePath("Brain/inbox/sig-x.md", "active")).toBe("Brain/inbox/sig-x.md");
    expect(signalPagePath("Brain/pending/sig-x.md", "active")).toBe("Brain/inbox/sig-x.md");
    expect(signalPagePath("Brain/pending/sig-x.md", "rejected")).toBe("Brain/retired/sig-x.md");
    expect(signalPagePath("Brain/inbox/sig-x.md", "expired")).toBe("Brain/inbox/sig-x.md");
  });
});
