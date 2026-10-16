/**
 * The shared per-session mining record (session-mining-economy,
 * t_93617709). Claims pinned here:
 *
 *  1. The ledger lives in the derived store beside the session import
 *     ledger, keyed on the portable session id, and an entry carries the
 *     mined-content hash, the outcome breakdown and the record time.
 *  2. A corrupt or unknown-schema ledger refuses with a named error and is
 *     never reset by a read.
 *  3. The write takes the file lock, writes atomically, and is a
 *     byte-identical no-op when nothing changed.
 *  4. A write prunes entries whose sessions no longer hold imported turns.
 *  5. The mined-turn hash is a stable SHA-256 over (turn id, text,
 *     timestamp) and changes when any turn changes.
 *  6. The tombstone read answers the recorded entry only while the hash
 *     still matches the session's current turn material.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  minedTurnsHash,
  readMiningTombstone,
  readSessionMiningLedger,
  recordSessionMiningOutcome,
  SESSION_MINING_LEDGER_SCHEMA_VERSION,
  sessionMiningLedgerPath,
  type SessionMiningEntry,
} from "../../../src/core/brain/session-mining-ledger.ts";
import { DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";
import {
  importSessionRecall,
  listSessionRawTurns,
} from "../../../src/core/brain/session-recall.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { acquireLockSync, LOCK_WAIT_BUDGET_ENV } from "../../../src/core/brain/sync-lockfile.ts";

const NOW = new Date("2026-10-15T08:09:08Z");
const SESSION = "sess-alpha";

let vault: string;

function turnMaterial(
  overrides: Partial<{ turnId: string; text: string; timestamp: string }> = {},
) {
  return {
    turnId: "t1",
    text: "Always name the release theme.",
    timestamp: "2026-10-15T07:00:00Z",
    ...overrides,
  };
}

const OUTCOME = { written: 0, staged: 0, deduped: 3, durabilityRejected: 1 };

function seedLedger(entries: Record<string, unknown>): void {
  mkdirSync(join(vault, DERIVED_STORE_DIR), { recursive: true });
  atomicWriteFileSync(
    sessionMiningLedgerPath(vault),
    `${JSON.stringify({ schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries }, null, 2)}\n`,
  );
}

function seedTurns(sessionId: string): void {
  importSessionRecall(vault, {
    sessionId,
    turns: [
      {
        turnId: "t1",
        timestamp: "2026-10-15T07:00:00Z",
        role: "user",
        text: "Always name the release theme.",
      },
    ],
    createdAt: NOW.toISOString(),
  });
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mining-ledger-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("the ledger path is in the derived store beside the import ledger", () => {
  expect(sessionMiningLedgerPath(vault)).toBe(
    join(vault, DERIVED_STORE_DIR, "session-mining-ledger.json"),
  );
});

test("a missing ledger reads as empty", () => {
  expect(readSessionMiningLedger(vault)).toEqual({
    schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION,
    entries: {},
  });
});

test("an entry round-trips with the full breakdown and the record time", () => {
  seedTurns(SESSION);
  const wrote = recordSessionMiningOutcome(
    vault,
    { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME },
    NOW,
  );
  expect(wrote).toBe(true);
  const ledger = readSessionMiningLedger(vault);
  expect(ledger.schema_version).toBe(SESSION_MINING_LEDGER_SCHEMA_VERSION);
  const entry = ledger.entries[SESSION]!;
  expect(entry.sessionId).toBe(SESSION);
  expect(entry.minedContentHash).toBe("a".repeat(64));
  expect(entry.outcome).toEqual(OUTCOME);
  expect(entry.recordedAt).toBe("2026-10-15T08:09:08Z");
});

test("a corrupt ledger refuses by name and is never reset", () => {
  seedLedger({});
  const path = sessionMiningLedgerPath(vault);
  writeFileSync(path, "not json at all");
  expect(() => readSessionMiningLedger(vault)).toThrow(/session mining ledger is corrupted JSON/);
  expect(() => readSessionMiningLedger(vault)).toThrow(/session-mining-ledger\.json/);
  // The refused read rewrote nothing: the file is exactly as corrupt as before.
  expect(readFileSync(path, "utf8")).toBe("not json at all");
});

test("an unknown schema_version refuses by name", () => {
  seedLedger({});
  writeFileSync(
    sessionMiningLedgerPath(vault),
    `${JSON.stringify({ schema_version: 99, entries: {} }, null, 2)}\n`,
  );
  expect(() => readSessionMiningLedger(vault)).toThrow(/schema_version 99 not supported/);
  expect(() => readSessionMiningLedger(vault)).toThrow(/expected 1/);
});

test("a non-object ledger refuses by name", () => {
  seedLedger({});
  writeFileSync(sessionMiningLedgerPath(vault), "[]\n");
  expect(() => readSessionMiningLedger(vault)).toThrow(/not an object/);
});

test("a wrong-shaped entries container refuses by name, never reads as empty", () => {
  // Container-shape malformation is file-level corruption like a corrupt
  // JSON body or an unknown schema: reading it as an empty ledger would
  // silently unsuppress every barren session at once. Per-entry damage
  // stays different (dropped, never guessed) and is pinned above.
  const cases: ReadonlyArray<unknown> = [
    { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION }, // entries absent
    { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: null },
    { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: [] },
    { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: "nope" },
    { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: 7 },
  ];
  for (const body of cases) {
    seedLedger({});
    writeFileSync(sessionMiningLedgerPath(vault), `${JSON.stringify(body)}\n`);
    expect(() => readSessionMiningLedger(vault)).toThrow(/entries is not an object/);
    expect(() => readSessionMiningLedger(vault)).toThrow(/session-mining-ledger\.json/);
  }
});

test("an entry this build cannot read is dropped, never guessed at", () => {
  seedTurns(SESSION);
  const good: SessionMiningEntry = {
    sessionId: SESSION,
    minedContentHash: "b".repeat(64),
    outcome: OUTCOME,
    recordedAt: "2026-10-15T08:09:08Z",
  };
  seedLedger({
    [SESSION]: good,
    "sess-broken-outcome": {
      sessionId: "sess-broken-outcome",
      minedContentHash: "c".repeat(64),
      outcome: { written: 0, deduped: 0 },
      recordedAt: "2026-10-15T08:09:08Z",
    },
    "sess-misfiled": { ...good, sessionId: "sess-elsewhere" },
  });
  const ledger = readSessionMiningLedger(vault);
  expect(Object.keys(ledger.entries)).toEqual([SESSION]);
});

test("recording is a byte-identical no-op when nothing changed", () => {
  seedTurns(SESSION);
  const record = { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME };
  recordSessionMiningOutcome(vault, record, NOW);
  const before = readFileSync(sessionMiningLedgerPath(vault), "utf8");
  const second = recordSessionMiningOutcome(vault, record, NOW);
  expect(second).toBe(false);
  expect(readFileSync(sessionMiningLedgerPath(vault), "utf8")).toBe(before);
});

test("recording rewrites when the breakdown or the content hash changes", () => {
  seedTurns(SESSION);
  const record = { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME };
  recordSessionMiningOutcome(vault, record, NOW);
  const rewrote = recordSessionMiningOutcome(
    vault,
    { ...record, outcome: { ...OUTCOME, deduped: 4 } },
    NOW,
  );
  expect(rewrote).toBe(true);
  expect(readSessionMiningLedger(vault).entries[SESSION]!.outcome.deduped).toBe(4);
});

test("a write prunes entries whose sessions no longer have turns", () => {
  seedTurns(SESSION);
  seedLedger({
    "sess-gone": {
      sessionId: "sess-gone",
      minedContentHash: "d".repeat(64),
      outcome: OUTCOME,
      recordedAt: "2026-10-15T08:09:08Z",
    },
  });
  recordSessionMiningOutcome(
    vault,
    { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME },
    NOW,
  );
  const entries = readSessionMiningLedger(vault).entries;
  expect(Object.keys(entries)).toEqual([SESSION]);
});

test("a recorded session with no turns leaves nothing behind", () => {
  // No turns are imported for this session: the entry is pruned in the
  // same pass that would write it, because a session the plan refuses has
  // nothing for the gate to suppress.
  const wrote = recordSessionMiningOutcome(
    vault,
    { sessionId: "sess-never-imported", minedContentHash: "a".repeat(64), outcome: OUTCOME },
    NOW,
  );
  expect(readSessionMiningLedger(vault).entries).toEqual({});
  expect(existsSync(sessionMiningLedgerPath(vault))).toBe(wrote);
});

test("a tombstone whose turns are visible only through lineage scope survives the prune", () => {
  // A root ref mined over segment-recorded turns: the turn records carry
  // the segment id, and the plan reaches them through the lineage scope.
  // The prune must consult that same scope, so a cheap session-id set
  // alone is not the whole answer - the entry is kept here.
  importSessionRecall(vault, {
    sessionId: "seg-b",
    turns: [
      {
        turnId: "b1",
        timestamp: "2026-10-15T07:00:00Z",
        role: "user",
        text: "Always name the release theme.",
      },
    ],
    createdAt: NOW.toISOString(),
    lineage: { rootId: "root-r", parentId: "seg-a", depth: 1, source: "payload" },
  });
  const scoped = listSessionRawTurns(vault, "root-r");
  expect(scoped.length).toBe(1);
  recordSessionMiningOutcome(
    vault,
    {
      sessionId: "root-r",
      minedContentHash: minedTurnsHash(
        scoped.map((t) => ({ turnId: t.turn_id, text: t.text.trim(), timestamp: t.timestamp })),
      ),
      outcome: OUTCOME,
    },
    NOW,
  );
  expect(readSessionMiningLedger(vault).entries["root-r"]).toBeDefined();
});

test("a contended lock refuses by name instead of writing unlocked", () => {
  seedTurns(SESSION);
  mkdirSync(join(vault, DERIVED_STORE_DIR), { recursive: true });
  const previous = process.env[LOCK_WAIT_BUDGET_ENV];
  process.env[LOCK_WAIT_BUDGET_ENV] = "50";
  const lock = acquireLockSync(sessionMiningLedgerPath(vault));
  try {
    expect(() =>
      recordSessionMiningOutcome(
        vault,
        { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME },
        NOW,
      ),
    ).toThrow(/lock busy/);
  } finally {
    lock.release();
    if (previous === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
    else process.env[LOCK_WAIT_BUDGET_ENV] = previous;
  }
  // Once the lock is free the same record lands.
  expect(
    recordSessionMiningOutcome(
      vault,
      { sessionId: SESSION, minedContentHash: "a".repeat(64), outcome: OUTCOME },
      NOW,
    ),
  ).toBe(true);
});

test("the mined-turn hash is stable and order-sensitive", () => {
  const a = [turnMaterial(), turnMaterial({ turnId: "t2", text: "Never abbreviate modules." })];
  expect(minedTurnsHash(a)).toBe(
    minedTurnsHash([
      turnMaterial(),
      turnMaterial({ turnId: "t2", text: "Never abbreviate modules." }),
    ]),
  );
  expect(minedTurnsHash(a)).not.toBe(minedTurnsHash([a[1]!, a[0]!]));
});

test("the mined-turn hash changes when any turn changes", () => {
  const base = [turnMaterial()];
  expect(minedTurnsHash(base)).not.toBe(minedTurnsHash([turnMaterial({ turnId: "t9" })]));
  expect(minedTurnsHash(base)).not.toBe(minedTurnsHash([turnMaterial({ text: "Changed." })]));
  expect(minedTurnsHash(base)).not.toBe(
    minedTurnsHash([turnMaterial({ timestamp: "2026-10-15T07:01:00Z" })]),
  );
});

test("the tombstone read answers only while the hash still matches", () => {
  seedTurns(SESSION);
  const turns = [turnMaterial()];
  recordSessionMiningOutcome(
    vault,
    { sessionId: SESSION, minedContentHash: minedTurnsHash(turns), outcome: OUTCOME },
    NOW,
  );
  const hit = readMiningTombstone(vault, SESSION, turns);
  expect(hit).not.toBeNull();
  expect(hit!.outcome).toEqual(OUTCOME);
  // Unchanged content on a later scan stays suppressed.
  expect(readMiningTombstone(vault, SESSION, [turnMaterial()])).not.toBeNull();
  // A re-import that changed the turns re-opens the session.
  expect(readMiningTombstone(vault, SESSION, [turnMaterial({ text: "Edited turn." })])).toBeNull();
  expect(readMiningTombstone(vault, "sess-other", turns)).toBeNull();
});

test("a record with a yield is not a tombstone, but stays in the ledger", () => {
  // The distilled state: the same record shape, read through two
  // contracts. The gate must not suppress a session whose recorded mine
  // produced accepted yield; the census reads the yield from the same
  // entry.
  seedTurns(SESSION);
  const turns = [turnMaterial()];
  recordSessionMiningOutcome(
    vault,
    {
      sessionId: SESSION,
      minedContentHash: minedTurnsHash(turns),
      outcome: { written: 2, staged: 1, deduped: 0, durabilityRejected: 0 },
    },
    NOW,
  );
  expect(readMiningTombstone(vault, SESSION, turns)).toBeNull();
  const entry = readSessionMiningLedger(vault).entries[SESSION]!;
  expect(entry.outcome).toEqual({ written: 2, staged: 1, deduped: 0, durabilityRejected: 0 });
});
