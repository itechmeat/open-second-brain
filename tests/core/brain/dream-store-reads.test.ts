/**
 * A dream pass over a store-only (migrated) vault reads each store stream a
 * bounded number of times and writes in batches, however many entities it
 * changes. A first pass after a migration retires, notes and assigns
 * hundreds of entities, and each write moved the stamp the entity fold is
 * cached on, so every later read parsed and verified the whole `events`
 * stream again (a retire read it three times), the receipts ledger was
 * re-read per receipt, and every log event and topic assignment was its own
 * synced write: on a real store the pass ran for most of an hour.
 */
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";

import { dream } from "../../../src/core/brain/dream.ts";
import { readStoreEntities } from "../../../src/core/store/read/store-entities.ts";
import { SafeguardTimeoutError, type Safeguard } from "../../../src/core/brain/safeguard.ts";
import * as appender from "../../../src/core/store/appender.ts";
import * as reader from "../../../src/core/store/reader.ts";
import * as preferenceModule from "../../../src/core/brain/preference.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { catchUpSettings } from "../../../src/core/view/catch-up.ts";
import { claimSettled, claimViewWriter } from "../../../src/core/view/writer.ts";
import { foldViewWriter } from "../../../src/core/view/writer-fold.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "../store-migration/fixtures/fleet.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOW = new Date("2026-11-20T12:00:00.000Z");
/** Preferences with no evidence for months: the pass retires every one. */
const STALE = 24;
/** Inbox signals on the pinned preference's topic: each is noted redundant. */
const NOTED = 30;
const SUBJECT = "Shard compaction keeps monthly shard files small";

/** How many of a batch's records are of `kind`. */
function count(kinds: ReadonlyArray<string>, kind: string): number {
  return kinds.filter((k) => k === kind).length;
}

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function page(fields: Record<string, string>, body = "Body."): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

function preference(
  a: Machine,
  slug: string,
  topic: string,
  extra: Record<string, string> = {},
): void {
  a.write(
    `Brain/preferences/pref-${slug}.md`,
    page({
      id: `pref-${slug}`,
      kind: "brain-preference",
      principle: `Rule ${slug}`,
      status: "confirmed",
      confidence: "medium",
      applied_count: "3",
      violated_count: "0",
      created_at: "2026-06-01T00:00:00.000Z",
      confirmed_at: "2026-06-10T00:00:00.000Z",
      unconfirmed_until: "2026-07-01T00:00:00.000Z",
      tags: "[]",
      last_evidence_at: "2026-06-15T00:00:00.000Z",
      topic,
      revision: "1",
      ...extra,
    }),
  );
}

/** A migrated, switched machine that holds the view writer role. */
function migrated(brainYaml?: string, pinned = 1, alternate = false): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  if (brainYaml !== undefined) a.write("Brain/_brain.yaml", brainYaml);
  // With `alternate` off by default every stale preference is confirmed;
  // on, every other one is still unconfirmed past its window, which the
  // retire gate never holds, so landed retires and gated reads alternate.
  for (let i = 0; i < STALE; i++) {
    preference(
      a,
      `stale-${i}`,
      `stale-${i}`,
      alternate && i % 2 === 0 ? { status: "unconfirmed" } : {},
    );
  }
  preference(a, "keep", "keep", { pinned: "true" });
  for (let i = 1; i < pinned; i++) preference(a, `keep-${i}`, `keep-${i}`, { pinned: "true" });

  for (let i = 0; i < NOTED; i++) {
    const day = `2026-11-${String(10 + (i % 9)).padStart(2, "0")}`;
    a.write(
      `Brain/inbox/${day}-keep-${i}.md`,
      page(
        {
          kind: "brain-signal",
          id: `sig-${day}-keep-${i}`,
          created_at: `${day}T08:00:00.000Z`,
          topic: "keep",
          signal: "positive",
          agent: "solo",
          principle: `Keep rule ${i}`,
        },
        "Raw.",
      ),
    );
  }
  for (let i = 0; i < 6; i++) {
    const day = `2026-11-0${i + 1}`;
    const payload = { text: `${SUBJECT} ${i}`, project: "o2b", agent: "solo" };
    a.write(
      `Brain/log/${day}.dev-z.jsonl`,
      JSON.stringify({
        ts: `${day}T10:00:00Z`,
        kind: "note",
        payload,
        prev: null,
        h: "0".repeat(64),
      }) + "\n",
    );
  }
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  const store = a.store();
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  return a;
}

test("a pass that changes many entities reads the events stream a bounded number of times and writes in batches", () => {
  const a = migrated();
  const wholeEventReads: string[] = [];
  const wholeReceiptReads: string[] = [];
  const batches: string[][] = [];
  const realRead = reader.readShard;
  const readSpy = spyOn(reader, "readShard").mockImplementation((path, options) => {
    const whole = (options?.offset ?? 0) === 0;
    if (whole && /[\\/]events[\\/]/.test(path)) wholeEventReads.push(path);
    if (whole && /[\\/]decision-receipts[\\/]/.test(path)) wholeReceiptReads.push(path);
    return realRead(path, options);
  });
  const realAppend = appender.appendRecords;
  const appendSpy = spyOn(appender, "appendRecords").mockImplementation(
    (store, inputs, options) => {
      batches.push(inputs.map((input) => input.kind));
      return realAppend(store, inputs, options);
    },
  );
  let summary: ReturnType<typeof dream>;
  try {
    summary = dream(a.vault, { now: NOW });
  } finally {
    readSpy.mockRestore();
    appendSpy.mockRestore();
  }
  // The pass did the work the bounds are about.
  expect(summary.retired.length).toBe(STALE);
  expect(summary.topics?.report.status).toBe("planned");
  const report = summary.topics?.report;
  const created = report?.status === "planned" ? report.created : [];
  expect(created.length).toBeGreaterThan(0);

  // Reads: a constant, not three per retire (before: more than 3 * STALE).
  expect(wholeEventReads.length).toBeLessThanOrEqual(16);
  // The receipts ledger once for the pass's confidence receipts, plus the
  // whole-store reads of the tail steps; not once per receipt (one per stale
  // preference here, before).
  expect(wholeReceiptReads.length).toBeLessThanOrEqual(8);

  // Writes: the run's own log events (one per noted signal, and more) go
  // in one batch (before: one synced write per event), and a topic's
  // members in one batch after its create (before: one per member).
  expect(batches.some((kinds) => count(kinds, "log-event") >= NOTED)).toBe(true);
  for (const topic of created) {
    expect(batches.some((kinds) => count(kinds, "assign") === topic.members)).toBe(true);
  }
  expect(created.every((topic) => topic.members > 1)).toBe(true);
});

test("a pass past its deadline stops between retires, keeps them, and the next pass finishes the work", () => {
  const a = migrated();
  // The deadline passes as the first retire lands: the next checkpoint
  // is the one before the second retire.
  let retiredWrites = 0;
  const realAppend = appender.appendRecords;
  const appendSpy = spyOn(appender, "appendRecords").mockImplementation(
    (store, inputs, options) => {
      for (const input of inputs) {
        const fields = input.body["fields"] as Record<string, unknown> | undefined;
        if (input.kind === "preference-set" && fields?.["status"] === "retired") retiredWrites += 1;
      }
      return realAppend(store, inputs, options);
    },
  );
  const guard: Safeguard = Object.freeze({
    operation: "dream",
    timeoutMs: 1,
    checkpoint: () => {
      if (retiredWrites > 0) throw new SafeguardTimeoutError("dream", 1);
    },
  });
  try {
    expect(() => dream(a.vault, { now: NOW, safeguard: guard })).toThrow(SafeguardTimeoutError);
  } finally {
    appendSpy.mockRestore();
  }
  // Stopped right after the first retire (before: every retire landed,
  // and only then did the pass look at its deadline).
  expect(retiredWrites).toBe(1);
  const next = dream(a.vault, { now: NOW });
  expect(next.retired.length).toBe(STALE - 1);
  expect(next.topics?.report.status).toBe("planned");
});

test("a migrated history whose records name no project says why it made no topic", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  // Notes as `brain_note` writes them: text and agent, no project.
  for (let i = 0; i < 6; i++) {
    const day = `2026-11-0${i + 1}`;
    a.write(
      `Brain/log/${day}.dev-z.jsonl`,
      JSON.stringify({
        ts: `${day}T10:00:00Z`,
        kind: "note",
        payload: { text: `${SUBJECT} ${i}`, agent: "solo" },
        prev: null,
        h: "0".repeat(64),
      }) + "\n",
    );
  }
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  const store = a.store();
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  const topics = dream(a.vault, { now: NOW }).topics;
  expect(topics?.report.status).toBe("planned");
  if (topics?.report.status !== "planned") return;
  expect(topics.report.created).toEqual([]);
  expect(topics.report.unheldWithoutProject).toBe(topics.report.unheld);
  expect(topics.report.unheld).toBeGreaterThanOrEqual(6);
  expect(topics.summary).toContain("names a project");
});

test("the retire evidence gate reads the loop's snapshot, not the loader once per retire", () => {
  const a = migrated(
    "schema_version: 1\nretire:\n  confirmed_evidence_min_threshold: 1\n",
    1,
    true,
  );
  // Loading a preference reads the entity fold again, and after the
  // previous retire's append that is a rebuild: the gate reads the loop's
  // snapshot instead.
  let loads = 0;
  const realLoad = preferenceModule.loadPreference;
  const readSpy = spyOn(preferenceModule, "loadPreference").mockImplementation((...args) => {
    loads += 1;
    return realLoad(...args);
  });
  let summary: ReturnType<typeof dream>;
  try {
    summary = dream(a.vault, { now: NOW });
  } finally {
    readSpy.mockRestore();
  }
  expect(summary.retired.length).toBe(STALE / 2);
  expect(summary.gated_retires?.length).toBe(STALE / 2);
  // Before: one load, and so one fold rebuild after any earlier retire,
  // per gated retire (25 here); now one, outside the retire loop.
  expect(loads).toBeLessThanOrEqual(1);
});

test("a pass stopped between rewrites keeps the confidence receipt of each rewrite it wrote", () => {
  // Two pinned preferences: each is rewritten (not retired) and drops a band.
  const a = migrated(undefined, 2);
  const receipts: string[] = [];
  let rewrites = 0;
  const realAppend = appender.appendRecords;
  const appendSpy = spyOn(appender, "appendRecords").mockImplementation(
    (store, inputs, options) => {
      for (const input of inputs) {
        const fields = input.body["fields"] as Record<string, unknown> | undefined;
        if (input.kind === "preference-set" && fields?.["status"] !== "retired") rewrites += 1;
        if (input.kind === "ledger-row" && input.ledger === "decision-receipts") {
          receipts.push(String((input.body["row"] as Record<string, unknown>)["subject"]));
        }
      }
      return realAppend(store, inputs, options);
    },
  );
  // The deadline passes once the first rewrite has landed.
  const guard: Safeguard = Object.freeze({
    operation: "dream",
    timeoutMs: 1,
    checkpoint: () => {
      if (rewrites > 0) throw new SafeguardTimeoutError("dream", 1);
    },
  });
  try {
    expect(() => dream(a.vault, { now: NOW, safeguard: guard })).toThrow(SafeguardTimeoutError);
  } finally {
    appendSpy.mockRestore();
  }
  // The one rewrite that landed changed its band, and its receipt landed
  // with it (before: the receipts were written after the whole loop, so
  // the stop before the second rewrite lost it).
  expect(rewrites).toBe(1);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatch(/^pref-keep/);
});

test("a removal that lands while the retire loop runs is not undone by a later retire", () => {
  const a = migrated();
  const store = a.store();
  let removedSlug: string | null = null;
  const realAppend = appender.appendRecords;
  const appendSpy = spyOn(appender, "appendRecords").mockImplementation((s, inputs, options) => {
    const results = realAppend(s, inputs, options);
    const retired = inputs.find(
      (input) =>
        input.kind === "preference-set" &&
        (input.body["fields"] as Record<string, unknown> | undefined)?.["status"] === "retired",
    );
    if (retired !== undefined && removedSlug === null) {
      // Another agent removes a stale preference the loop has not reached
      // yet, after the loop read its snapshot (an agent's removal: a later
      // agent record about the preference would win over it by clock).
      const first = String(retired.body["preference"]);
      removedSlug = first === "pref-stale-23" ? "pref-stale-22" : "pref-stale-23";
      realAppend(store, [
        {
          partition: "shared",
          stream: "events",
          kind: "preference-remove",
          agent: "someone",
          body: { authority: "agent", preference: removedSlug },
        },
      ]);
    }
    return results;
  });
  let summary: ReturnType<typeof dream>;
  try {
    summary = dream(a.vault, { now: NOW });
  } finally {
    appendSpy.mockRestore();
  }
  expect(removedSlug).not.toBeNull();
  // The removed preference stays removed (before: the retire's records,
  // built from the snapshot, proposed that it exists again).
  expect(summary.retired.length).toBe(STALE);
  const entry = readStoreEntities()?.preferences.get(removedSlug!);
  expect(entry?.state.exists ?? false).toBe(false);
});
