/**
 * The decision ledger store (write-side-trust, Task 2).
 *
 * One row per non-allow verdict (plus resolution rows), month/device
 * JSONL shards under `Brain/logs/decisions/` on the idempotency-ledger
 * model: the per-device shard keeps two Syncthing peers from ever writing
 * one file, and the merged read orders by (timestamp, shard id) so every
 * device sees the same sequence regardless of arrival order.
 *
 * The append half has one absolute contract: a failed append NEVER
 * throws. The ledger rides behind gates that must refuse or stage a
 * write even when accountability cannot be recorded, so every failure
 * comes back as `{ logged: false, audit_reason }` instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import {
  appendDecisionLedger,
  decisionLedgerDir,
  queryDecisionLedger,
} from "../../../../src/core/brain/permissions/ledger.ts";
import type { DecisionLedgerRow } from "../../../../src/core/brain/permissions/ledger.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let vault: string;
const savedDeviceId = process.env["O2B_DEVICE_ID"];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-decisions-ledger-"));
  // The suite preload pins the empty shard; tests that simulate a device
  // set their own and restore this one.
  process.env["O2B_DEVICE_ID"] = "";
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  if (savedDeviceId === undefined) delete process.env["O2B_DEVICE_ID"];
  else process.env["O2B_DEVICE_ID"] = savedDeviceId;
});

function row(overrides: Partial<DecisionLedgerRow> = {}): DecisionLedgerRow {
  return {
    ts: "2026-10-10T10:00:00Z",
    actor: "codex",
    via: "token",
    action: "write",
    target: "notes/foo.md",
    verdict: "deny",
    source: "entry:freeze-notes",
    reason: "target-scoped entry freeze-notes",
    ...overrides,
  };
}

describe("appendDecisionLedger", () => {
  test("a row lands on one line of the month shard of the empty device id", () => {
    const result = appendDecisionLedger(vault, row());
    expect(result).toEqual({ logged: true });
    const shard = join(decisionLedgerDir(vault), "2026-10.jsonl");
    expect(existsSync(shard)).toBe(true);
    const lines = readFileSync(shard, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(row());
  });

  test("the shard month comes from the row's own ts, not the wall clock", () => {
    appendDecisionLedger(vault, row({ ts: "2025-01-02T03:04:05Z" }));
    expect(existsSync(join(decisionLedgerDir(vault), "2025-01.jsonl"))).toBe(true);
  });

  test("a device id writes its own shard and never the legacy name", () => {
    process.env["O2B_DEVICE_ID"] = "lane-a";
    appendDecisionLedger(vault, row({ ts: "2026-10-10T10:00:00Z" }));
    expect(existsSync(join(decisionLedgerDir(vault), "2026-10.jsonl"))).toBe(false);
    expect(existsSync(join(decisionLedgerDir(vault), "2026-10.lane-a.jsonl"))).toBe(true);
  });

  test("two simulated devices appending in alternation never lose a row", () => {
    for (let i = 0; i < 10; i++) {
      process.env["O2B_DEVICE_ID"] = i % 2 === 0 ? "device-one" : "device-two";
      const result = appendDecisionLedger(
        vault,
        row({ ts: `2026-10-10T10:00:${String(i).padStart(2, "0")}Z`, actor: `agent-${i}` }),
      );
      expect(result.logged).toBe(true);
    }
    const rows = queryDecisionLedger(vault, {});
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.actor)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
      "agent-7",
      "agent-8",
      "agent-9",
    ]);
  });

  test("an invalid row refuses with an audit reason instead of throwing", () => {
    const badTs = appendDecisionLedger(vault, row({ ts: "not-a-timestamp" }));
    expect(badTs.logged).toBe(false);
    expect(badTs.audit_reason).toBeDefined();

    const emptyTs = appendDecisionLedger(vault, row({ ts: "" }));
    expect(emptyTs.logged).toBe(false);
    expect(emptyTs.audit_reason).toBeDefined();
    // Nothing was written by either refusal.
    expect(existsSync(decisionLedgerDir(vault))).toBe(false);
  });

  test(
    "a held shard lock is a failed append with an audit reason, never a throw",
    () => {
      appendDecisionLedger(vault, row());
      const shard = join(decisionLedgerDir(vault), "2026-10.jsonl");
      const release = lockfile.lockSync(shard, { stale: 10_000, realpath: false });
      try {
        const result = appendDecisionLedger(vault, row({ actor: "second" }));
        expect(result.logged).toBe(false);
        expect(result.audit_reason).toBeDefined();
      } finally {
        void release();
      }
      // The released lock lets the next append through, and the shard
      // keeps the first row plus the retry.
      const retried = appendDecisionLedger(vault, row({ actor: "second" }));
      expect(retried.logged).toBe(true);
      expect(queryDecisionLedger(vault, {})).toHaveLength(2);
    },
    { timeout: 20_000 },
  );
});

test.skipIf(CHMOD_CANNOT_DENY)("an unwritable ledger directory fails with an audit reason", () => {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "Brain", "logs"));
  // A file where the decisions directory belongs: every append must
  // refuse by reason rather than throw.
  writeFileSync(join(vault, "Brain", "logs", "decisions"), "occupied", "utf8");
  const result = appendDecisionLedger(vault, row());
  expect(result.logged).toBe(false);
  expect(result.audit_reason).toBeDefined();
});

test.skipIf(CHMOD_CANNOT_DENY)("an unreadable shard is never read as an empty one", () => {
  appendDecisionLedger(vault, row());
  const shard = join(decisionLedgerDir(vault), "2026-10.jsonl");
  chmodSync(shard, 0o000);
  try {
    expect(() => queryDecisionLedger(vault, {})).toThrow();
  } finally {
    chmodSync(shard, 0o644);
  }
});

describe("queryDecisionLedger", () => {
  test("an empty vault yields zero rows and no directory", () => {
    expect(queryDecisionLedger(vault, {})).toEqual([]);
    expect(existsSync(decisionLedgerDir(vault))).toBe(false);
  });

  test("the merged read is ordered by (ts, shardId) across device shards", () => {
    process.env["O2B_DEVICE_ID"] = "b-device";
    appendDecisionLedger(vault, row({ ts: "2026-10-10T09:00:00Z", actor: "early-on-b" }));
    appendDecisionLedger(vault, row({ ts: "2026-10-10T10:00:00Z", actor: "tie-on-b" }));
    process.env["O2B_DEVICE_ID"] = "a-device";
    appendDecisionLedger(vault, row({ ts: "2026-10-10T10:00:00Z", actor: "tie-on-a" }));
    process.env["O2B_DEVICE_ID"] = "";
    appendDecisionLedger(vault, row({ ts: "2026-10-10T11:00:00Z", actor: "late-legacy" }));

    expect(queryDecisionLedger(vault, {}).map((r) => r.actor)).toEqual([
      "early-on-b",
      "tie-on-a",
      "tie-on-b",
      "late-legacy",
    ]);
  });

  test("rows within one shard keep their append order at equal timestamps", () => {
    appendDecisionLedger(vault, row({ ts: "2026-10-10T10:00:00Z", actor: "first" }));
    appendDecisionLedger(vault, row({ ts: "2026-10-10T10:00:00Z", actor: "second" }));
    expect(queryDecisionLedger(vault, {}).map((r) => r.actor)).toEqual(["first", "second"]);
  });

  test("filters narrow by actor, action, verdict and target", () => {
    process.env["O2B_DEVICE_ID"] = "";
    appendDecisionLedger(vault, row({ actor: "codex", action: "write", verdict: "deny" }));
    appendDecisionLedger(vault, row({ actor: "gemini", action: "ingest", verdict: "ask" }));
    appendDecisionLedger(
      vault,
      row({ actor: "codex", action: "owner_write", verdict: "allow", target: "notes/bar.md" }),
    );

    expect(queryDecisionLedger(vault, { actor: "codex" })).toHaveLength(2);
    expect(queryDecisionLedger(vault, { action: "ingest" })).toHaveLength(1);
    expect(queryDecisionLedger(vault, { verdict: "deny" })).toHaveLength(1);
    expect(queryDecisionLedger(vault, { target: "notes/bar.md" })).toHaveLength(1);
    expect(queryDecisionLedger(vault, { actor: "codex", verdict: "deny" })).toHaveLength(1);
    expect(queryDecisionLedger(vault, { actor: "nobody" })).toEqual([]);
  });

  test("since and until bound the window inclusively", () => {
    appendDecisionLedger(vault, row({ ts: "2026-10-01T00:00:00Z", actor: "first-day" }));
    appendDecisionLedger(vault, row({ ts: "2026-10-15T12:00:00Z", actor: "mid-month" }));
    appendDecisionLedger(vault, row({ ts: "2026-11-01T00:00:00Z", actor: "next-month" }));

    expect(
      queryDecisionLedger(vault, { since: "2026-10-10T00:00:00Z" }).map((r) => r.actor),
    ).toEqual(["mid-month", "next-month"]);
    expect(
      queryDecisionLedger(vault, { until: "2026-10-15T12:00:00Z" }).map((r) => r.actor),
    ).toEqual(["first-day", "mid-month"]);
    expect(
      queryDecisionLedger(vault, { since: "2026-10-15T12:00:00Z", until: "2026-10-15T12:00:00Z" }),
    ).toHaveLength(1);
  });

  test("a query spanning months reads every shard, oldest first", () => {
    appendDecisionLedger(vault, row({ ts: "2026-09-01T00:00:00Z", actor: "september" }));
    appendDecisionLedger(vault, row({ ts: "2026-10-01T00:00:00Z", actor: "october" }));
    expect(queryDecisionLedger(vault, {}).map((r) => r.actor)).toEqual(["september", "october"]);
  });

  test("limit caps the merged result after ordering", () => {
    for (let i = 0; i < 5; i++) {
      appendDecisionLedger(vault, row({ ts: `2026-10-10T10:0${i}:00Z`, actor: `agent-${i}` }));
    }
    const limited = queryDecisionLedger(vault, { limit: 2 });
    expect(limited.map((r) => r.actor)).toEqual(["agent-0", "agent-1"]);
  });

  test("a malformed line is skipped and the readable rows around it survive", () => {
    appendDecisionLedger(vault, row({ actor: "before" }));
    const shard = join(decisionLedgerDir(vault), "2026-10.jsonl");
    writeFileSync(shard, "{not json}\n", { encoding: "utf8", flag: "a" });
    appendDecisionLedger(vault, row({ actor: "after" }));
    expect(queryDecisionLedger(vault, {}).map((r) => r.actor)).toEqual(["before", "after"]);
  });
});
