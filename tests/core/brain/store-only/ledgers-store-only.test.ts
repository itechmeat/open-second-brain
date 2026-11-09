/**
 * The dual-written ledgers on a store-only machine (task 2.10, design D14
 * item 1): each writer appends one `ledger-row` record to its store
 * ledger and writes no byte anywhere in the vault (`Brain/`, the derived
 * store or any other file), and the ledger's own reader returns the row from the store. On
 * an unswitched machine the same writer keeps its legacy file and the
 * reader returns the row from it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  appendDecisionChangeReceipt,
  readDecisionChangeReceipts,
} from "../../../../src/core/brain/decisions/receipts.ts";
import {
  appendContinuityRecords,
  listContinuityRecords,
} from "../../../../src/core/brain/continuity/store.ts";
import {
  appendGitRecords,
  listGitCommits,
  listGitRepos,
  readGitState,
  writeGitState,
} from "../../../../src/core/brain/git/store.ts";
import { lookupKey, rememberKey } from "../../../../src/core/brain/idempotency-ledger.ts";
import {
  lineageGapSessionIds,
  readLineageLedger,
  recordLineageObservation,
  sessionLineageGapsPath,
} from "../../../../src/core/brain/lineage/ledger.ts";
import {
  appendJournal,
  listJournal,
  MAINTENANCE_VERDICT,
  sweepJournal,
} from "../../../../src/core/brain/maintenance/journal.ts";
import { appendMetric, listMetrics } from "../../../../src/core/brain/metrics.ts";
import {
  appendDecisionLedger,
  queryDecisionLedger,
} from "../../../../src/core/brain/permissions/ledger.ts";
import { appendPrefAudit, readPrefAudit } from "../../../../src/core/brain/pref-audit.ts";
import { readQueryDemand, recordQueryDemand } from "../../../../src/core/brain/query-demand.ts";
import {
  applyRecurrenceEvidence,
  listRecurrenceEntries,
} from "../../../../src/core/brain/recurrence.ts";
import {
  appendClaimEvent,
  readClaimEvents,
  readTruthState,
  sweepClaimEvents,
} from "../../../../src/core/brain/truth/store.ts";
import { handleCaptureUpdate } from "../../../../src/core/brain/capture/telegram-capture.ts";
import { openWorkrun, scanDanglingWorkruns } from "../../../../src/core/brain/dream-workrun.ts";
import {
  activationStatePath,
  readActivationState,
  recordAccessEvent,
} from "../../../../src/core/search/activation/store.ts";
import {
  learnedWeightsFile,
  loadFeedbackEvents,
  readLearnedWeights,
  recordRecallFeedback,
} from "../../../../src/core/search/feedback.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import {
  loadReinforceEvents,
  recordReinforce,
  reinforceFingerprint,
  resetReinforce,
} from "../../../../src/core/search/reinforce.ts";
import { StoreWriteError } from "../../../../src/core/store/store-write.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
import { ledgerRows, partitionRecords, switchDevice } from "./fixtures.ts";

const TS = "2026-06-01T10:00:00Z";
const SHA = "a".repeat(40);

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/** Every row of `name`, both partitions. */
function rowsOf(name: string): unknown[] {
  return [
    ...ledgerRows(env!.storeRoot, "shared", name),
    ...ledgerRows(env!.storeRoot, "private", name),
  ];
}

/**
 * The whole vault, directories included: `Brain/`, the derived store
 * `.open-second-brain/` and every other top-level file a switched machine
 * must leave alone.
 */
function vaultDigest(vault: string): string {
  return digestVaultTree(vault);
}

interface LedgerCase {
  readonly name: string;
  readonly ledger: string;
  /** Write one row. */
  readonly write: (vault: string) => void;
  /** Read it back through the ledger's own reader; returns how many rows it sees. */
  readonly read: (vault: string) => number;
}

const CASES: ReadonlyArray<LedgerCase> = [
  {
    name: "query demand",
    ledger: "query-demand",
    write: (vault) => void recordQueryDemand(vault, { query: "alpha beta", resultCount: 1 }),
    read: (vault) => readQueryDemand(vault).length,
  },
  {
    name: "recurrence",
    ledger: "recurrence",
    write: (vault) =>
      void applyRecurrenceEvidence(vault, {
        contentHash: "h1",
        scope: "coding",
        sourceId: "s1",
        action: "learn",
        at: TS,
      }),
    read: (vault) => listRecurrenceEntries(vault).length,
  },
  {
    name: "metrics",
    ledger: "metrics",
    write: (vault) => appendMetric(vault, { surface: "dream_run", runAt: TS, payload: { n: 1 } }),
    read: (vault) => listMetrics(vault, { surface: "dream_run" }).length,
  },
  {
    name: "preference audit",
    ledger: "preference-audit",
    write: (vault) =>
      void appendPrefAudit(vault, {
        pref_id: "pref-tabs",
        op: "create",
        agent: "@tester",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "h",
      }),
    read: (vault) => readPrefAudit(vault, "pref-tabs").records.length,
  },
  {
    name: "idempotency",
    ledger: "idempotency",
    write: (vault) => void rememberKey(vault, { key: "k1", contentHash: "c1", createdAt: TS }),
    read: (vault) => (lookupKey(vault, "k1") === null ? 0 : 1),
  },
  {
    name: "maintenance journal",
    ledger: "maintenance-journal",
    write: (vault) =>
      appendJournal(vault, {
        ts: TS,
        holder: "test",
        verdict: MAINTENANCE_VERDICT.run,
        task: "t",
        ok: true,
      }),
    read: (vault) => listJournal(vault).length,
  },
  {
    name: "lineage",
    ledger: "lineage",
    write: (vault) =>
      void recordLineageObservation(vault, { sessionId: "s1", at: TS, event: "SessionStart" }),
    read: (vault) => readLineageLedger(vault).size,
  },
  {
    name: "decision receipts",
    ledger: "decision-receipts",
    write: (vault) =>
      void appendDecisionChangeReceipt(vault, {
        subject: "tabs",
        before: "spaces",
        after: "tabs",
        actor: "@tester",
        reasonCode: "user",
        ts: TS,
      }),
    read: (vault) => readDecisionChangeReceipts(vault).receipts.length,
  },
  {
    name: "continuity",
    ledger: "continuity",
    write: (vault) =>
      void appendContinuityRecords(vault, [
        { kind: "recall_telemetry", createdAt: "2026-06-01T10:00:00.000Z", payload: { n: 1 } },
      ]),
    read: (vault) => listContinuityRecords(vault).length,
  },
  {
    name: "truth claims",
    ledger: "truth-claims",
    write: (vault) =>
      void appendClaimEvent(vault, {
        entity: "api",
        aspect: "port",
        value: "8080",
        agent: "@tester",
        source: "chat",
        ts: TS,
      }),
    read: (vault) => readClaimEvents(vault).events.length,
  },
  {
    name: "git commits",
    ledger: "git-commits",
    write: (vault) =>
      void appendGitRecords(vault, "repo-a", [
        {
          kind: "commit",
          sha: SHA,
          authorName: "a",
          authorEmail: "a@example.org",
          committedAt: TS,
          subject: "init",
          body: "",
          files: ["x.ts"],
          release: null,
        },
      ]),
    read: (vault) => listGitCommits(vault, "repo-a").length,
  },
  {
    name: "permissions",
    ledger: "permissions",
    write: (vault) =>
      void appendDecisionLedger(vault, {
        ts: TS,
        actor: "@tester",
        via: "mcp",
        action: "resolution",
        target: "Notes/x.md",
        verdict: "allow",
        source: "test",
        reason: "test",
      }),
    read: (vault) => queryDecisionLedger(vault).length,
  },
];

describe("a switched machine writes every ledger to the store only", () => {
  for (const c of CASES) {
    test(`${c.name}: one ${c.ledger} row, no byte under the vault, read back`, () => {
      env = makeStoreEnv("osb-wp3-ledger-", { dualWrite: false });
      switchDevice(env.storeRoot);
      const before = vaultDigest(env.vault);
      c.write(env.vault);
      expect(vaultDigest(env.vault)).toBe(before);
      expect(rowsOf(c.ledger)).toHaveLength(1);
      expect(c.read(env.vault)).toBe(1);
    });
  }

  test("an idempotency key remembered in the store is honoured on a retry", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    expect(rememberKey(env.vault, { key: "k", contentHash: "c" }).status).toBe("inserted");
    expect(rememberKey(env.vault, { key: "k", contentHash: "c" }).status).toBe("duplicate_match");
    expect(rememberKey(env.vault, { key: "k", contentHash: "d" }).status).toBe("payload_mismatch");
    expect(rowsOf("idempotency")).toHaveLength(1);
  });

  test("git dedups against the store and keeps its watermark device-local", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    const before = vaultDigest(env.vault);
    CASES.find((c) => c.ledger === "git-commits")!.write(env.vault);
    CASES.find((c) => c.ledger === "git-commits")!.write(env.vault);
    writeGitState(env.vault, "repo-a", { repoPath: "/r", lastSha: SHA, lastIngestedAt: TS });
    expect(vaultDigest(env.vault)).toBe(before);
    expect(rowsOf("git-commits")).toHaveLength(1);
    expect(readGitState(env.vault, "repo-a").state?.lastSha).toBe(SHA);
    expect(listGitRepos(env.vault).map((r) => r.key)).toEqual(["repo-a"]);
  });

  test("the truth state is folded from the store rows, and a sweep is refused", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    CASES.find((c) => c.ledger === "truth-claims")!.write(env.vault);
    expect(readTruthState(env.vault)?.slots).toHaveLength(1);
    expect(() => sweepClaimEvents(env!.vault, { maxEvents: 0 })).toThrow(/store only/);
  });

  test("the maintenance journal sweep rewrites nothing", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    const before = vaultDigest(env.vault);
    sweepJournal(env.vault, 0);
    expect(vaultDigest(env.vault)).toBe(before);
  });

  test("a store failure fails a ledger write with its reason", () => {
    env = makeStoreEnv("osb-wp3-ledger-", { partitions: [], legacyTree: false });
    expect(() =>
      appendDecisionChangeReceipt(env!.vault, {
        subject: "tabs",
        before: "spaces",
        after: "tabs",
        actor: "@tester",
        reasonCode: "user",
        ts: TS,
      }),
    ).toThrow(StoreWriteError);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("telemetry and the lineage hook path stay fail-open", () => {
    env = makeStoreEnv("osb-wp3-ledger-", { partitions: [], legacyTree: false });
    expect(recordQueryDemand(env.vault, { query: "alpha beta", resultCount: 1 })).not.toBeNull();
    expect(() =>
      appendMetric(env!.vault, { surface: "dream_run", runAt: TS, payload: { n: 1 } }),
    ).not.toThrow();
    const lineage = recordLineageObservation(env.vault, {
      sessionId: "s1",
      at: TS,
      event: "SessionStart",
    });
    expect(lineage.status).toBe("dropped");
    // The drop is recorded where a store-only read finds it.
    expect(lineageGapSessionIds(env.vault).has("s1")).toBe(true);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("a gap recorded before the switch is still reported after it", () => {
    env = makeStoreEnv("osb-lineage-gap-switch-", { dualWrite: false });
    // Recorded while unswitched: the sidecar sits under the vault's state.
    const legacyGaps = sessionLineageGapsPath(env.vault);
    mkdirSync(dirname(legacyGaps), { recursive: true });
    const recordedAt = new Date().toISOString();
    writeFileSync(
      legacyGaps,
      `${JSON.stringify({ sid: "s-before", at: recordedAt, rat: recordedAt, event: "SessionStart", reason: "store_write_failed" })}\n`,
    );
    switchDevice(env.storeRoot);
    expect(lineageGapSessionIds(env.vault).has("s-before")).toBe(true);
  });
});

describe("an unswitched machine keeps its legacy ledgers", () => {
  for (const c of CASES) {
    test(`${c.name}: the legacy file and the dual write`, () => {
      env = makeStoreEnv("osb-wp3-ledger-");
      const before = vaultDigest(env.vault);
      c.write(env.vault);
      expect(vaultDigest(env.vault)).not.toBe(before);
      expect(c.read(env.vault)).toBe(1);
      expect(rowsOf(c.ledger)).toHaveLength(1);
    });
  }
});

const FEEDBACK = {
  ts: Date.parse(TS),
  queryHash: "abcd1234",
  resultPath: "Notes/x.md",
  verdict: "up" as const,
  contributions: { keyword: 0.5, semantic: 0.5, entity: 0, recency: 0 },
};

function malformedUpdate(vault: string): void {
  handleCaptureUpdate(
    vault,
    { update_id: 7 },
    { allowlist: new Set(), agent: "@bot", now: () => new Date(TS) },
  );
}

describe("the ledgers the migration names get their first store writers", () => {
  test("capture decisions, search feedback and search reinforce land in the store only", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    const before = vaultDigest(env.vault);
    malformedUpdate(env.vault);
    recordRecallFeedback(env.vault, FEEDBACK);
    recordRecallFeedback(env.vault, FEEDBACK);
    recordReinforce(env.vault, ["Notes/x.md"], { nowMs: Date.parse(TS) });
    expect(vaultDigest(env.vault)).toBe(before);
    expect(rowsOf("capture-decisions")).toHaveLength(1);
    expect(rowsOf("search-feedback")).toHaveLength(2);
    expect(rowsOf("search-reinforce")).toHaveLength(1);
    // The identical event recorded twice counts once, as its file name made it one file.
    expect(loadFeedbackEvents(env.vault)).toHaveLength(1);
    expect(learnedWeightsFile(env.vault).startsWith(env.vault)).toBe(false);
    expect(existsSync(learnedWeightsFile(env.vault))).toBe(true);
    expect(loadReinforceEvents(env.vault)).toHaveLength(1);
  });

  test("learned weights are folded from the feedback rows when the cache is missing or behind", () => {
    env = makeStoreEnv("osb-wp3-weights-");
    switchDevice(env.storeRoot);
    recordRecallFeedback(env.vault, FEEDBACK);
    // As after the migration, which drops the cache: the rows are there.
    rmSync(learnedWeightsFile(env.vault));
    expect(readLearnedWeights(env.vault)?.events).toBe(1);
    // A row another device recorded, synced in: the cache follows it.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "ledgers",
      ledger: "search-feedback",
      kind: "ledger-row",
      agent: "t",
      body: { row: { ...FEEDBACK, ts: FEEDBACK.ts + 1, resultPath: "Notes/y.md" } },
    });
    expect(readLearnedWeights(env.vault)?.events).toBe(2);
  });

  test("a weights cache cut short is folded again from the rows", () => {
    env = makeStoreEnv("osb-wp3-weights-torn-");
    switchDevice(env.storeRoot);
    recordRecallFeedback(env.vault, FEEDBACK);
    // A crash during the cache's plain write left half a file.
    writeFileSync(learnedWeightsFile(env.vault), '{"keywordMul": 1.0');
    expect(readLearnedWeights(env.vault)?.events).toBe(1);
  });

  test("a reinforce reset is a store row that hides every earlier event", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    switchDevice(env.storeRoot);
    recordReinforce(env.vault, ["Notes/x.md"], { nowMs: 1 });
    const before = reinforceFingerprint(env.vault);
    expect(before).not.toBe("off");
    resetReinforce(env.vault, { nowMs: 2 });
    expect(loadReinforceEvents(env.vault)).toEqual([]);
    expect(reinforceFingerprint(env.vault)).toBe("off");
    recordReinforce(env.vault, ["Notes/y.md"], { nowMs: 3 });
    expect(loadReinforceEvents(env.vault).map((e) => e.paths)).toEqual([["Notes/y.md"]]);
    // The reset names no page: it lands in `shared`, so a device without
    // the private partition applies the same cutoff.
    const resets = ledgerRows(env.storeRoot, "shared", "search-reinforce").filter(
      (r) => (r as { reset?: boolean }).reset === true,
    );
    expect(resets).toHaveLength(1);
  });

  test("an unswitched machine keeps their legacy files and writes no store row", () => {
    env = makeStoreEnv("osb-wp3-ledger-");
    malformedUpdate(env.vault);
    recordRecallFeedback(env.vault, FEEDBACK);
    recordReinforce(env.vault, ["Notes/x.md"], { nowMs: Date.parse(TS) });
    expect(rowsOf("capture-decisions")).toEqual([]);
    expect(rowsOf("search-feedback")).toEqual([]);
    expect(rowsOf("search-reinforce")).toEqual([]);
    expect(loadFeedbackEvents(env.vault)).toHaveLength(1);
    expect(loadReinforceEvents(env.vault)).toHaveLength(1);
    expect(existsSync(join(env.vault, "Brain", "search", "feedback"))).toBe(true);
  });
});

describe("device-local surfaces of a store-only machine (D14 item 11)", () => {
  test("search activation and dream workruns live in device-local state", () => {
    env = makeStoreEnv("osb-wp3-local-");
    switchDevice(env.storeRoot);
    const before = vaultDigest(env.vault);
    const storeBefore = allStoreRecords().length;
    recordAccessEvent(env.vault, { ts: Date.parse(TS), queryHash: "q", paths: ["Notes/x.md"] });
    const run = openWorkrun(env.vault, "run-1");
    expect(vaultDigest(env.vault)).toBe(before);
    expect(activationStatePath(env.vault).startsWith(env.vault)).toBe(false);
    expect(readActivationState(env.vault)).not.toBeNull();
    expect(run.path.startsWith(env.vault)).toBe(false);
    expect(scanDanglingWorkruns(env.vault)).toEqual([run.path]);
    run.finalize();
    expect(scanDanglingWorkruns(env.vault)).toEqual([]);
    // Device-local only: neither surface wrote a record to the store.
    expect(allStoreRecords()).toHaveLength(storeBefore);
  });
});

/** Every record either partition holds, so a test can prove it wrote none. */
function allStoreRecords(): unknown[] {
  return [
    ...partitionRecords(env!.storeRoot, "shared"),
    ...partitionRecords(env!.storeRoot, "private"),
  ];
}
