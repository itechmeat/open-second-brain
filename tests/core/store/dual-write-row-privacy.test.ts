/**
 * Dual-written ledger rows that name pages (idempotency receipts,
 * recurrence events, continuity turns, verifier rejections) follow the
 * fail-closed reference-privacy rule: a row that names a private page, or
 * a preference whose page cannot be judged, goes to `private` only; any
 * other row keeps the partition its ledger states.
 *
 * Every test runs against its own temp HOME, state base, vault and store
 * root under one named parent, removed in teardown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { applyWriteBatch } from "../../../src/core/brain/write-batch.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  applyRecurrenceEvidence,
  purgeRecurrenceSource,
} from "../../../src/core/brain/recurrence.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { readDualWriteStatus } from "../../../src/core/store/dual-write.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { rowNamesPrivatePage } from "../../../src/core/store/reference-privacy.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-row-privacy-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_DUAL_WRITE_ENV] = "1";
  initStore({ root: storeRoot });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ledgerRows(partition: "shared" | "private", ledger: string): StoreRecord[] {
  return readPartition(join(storeRoot, partition))
    .filter((s) => s.rel.startsWith(`ledgers/${ledger}/`))
    .flatMap((s) => s.records);
}

function seedPreference(slug: string, extra: Record<string, unknown> = {}): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
    ...extra,
  });
}

/** The Brain log events dual-written to one partition. */
function logEvents(partition: "shared" | "private"): StoreRecord[] {
  return readPartition(join(storeRoot, partition))
    .filter((s) => s.rel.startsWith("log/"))
    .flatMap((s) => s.records);
}

/** The client keys of the idempotency receipts in one partition. */
function receiptKeys(partition: "shared" | "private"): unknown[] {
  return ledgerRows(partition, "idempotency").map(
    (r) => (r.body["row"] as Record<string, unknown>)["key"],
  );
}

/** One batch operation recording evidence against `prefId`. */
function evidence(prefId: string) {
  return {
    kind: "apply_evidence",
    input: { pref_id: prefId, artifact: "[[some-note]]", result: "applied", agent: "claude" },
  } as const;
}

function writePage(rel: string, frontmatter: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\nbody\n`);
}

describe("idempotency receipts", () => {
  test("a private preference's receipt stays out of shared, an open one lands there", () => {
    seedPreference("hush", { visibility: ["private"], idempotency_key: "k-hush" });
    seedPreference("open", { idempotency_key: "k-open" });
    const sharedKeys = ledgerRows("shared", "idempotency").map(
      (r) => (r.body["row"] as Record<string, unknown>)["key"],
    );
    expect(sharedKeys).toEqual(["k-open"]);
    const privateKeys = ledgerRows("private", "idempotency").map(
      (r) => (r.body["row"] as Record<string, unknown>)["key"],
    );
    expect(privateKeys).toEqual(["k-hush"]);
  });

  test("evidence on a private preference keeps its receipt out of shared", () => {
    seedPreference("hush", { visibility: ["private"] });
    appendApplyEvidence(vault, {
      pref_id: "pref-hush",
      artifact: "[[some-note]]",
      result: "applied",
      agent: "claude",
      idempotency_key: "k-evidence",
    });
    expect(ledgerRows("shared", "idempotency")).toEqual([]);
    expect(ledgerRows("private", "idempotency").length).toBe(1);
  });

  test("a batch receipt carries the batch's privacy verdict", () => {
    seedPreference("hush", { visibility: ["private"] });
    seedPreference("open");
    applyWriteBatch(vault, [evidence("pref-hush")], { requestId: "batch-hush" });
    applyWriteBatch(vault, [evidence("pref-open")], { requestId: "batch-open" });
    expect(receiptKeys("shared")).toEqual(["batch-open"]);
    expect(receiptKeys("private")).toEqual(["batch-hush"]);
  });

  test("a batch receipt is judged under the flag its own dual write reads, not the batch's config", () => {
    // The machine config turns dual writes on; the config the batch is
    // handed turns them off. The receipt is still dual-written (under the
    // machine config), so its privacy must still be judged.
    delete process.env[STORE_DUAL_WRITE_ENV];
    const machineConfig = join(parent, "machine.yaml");
    const batchConfig = join(parent, "batch.yaml");
    writeFileSync(machineConfig, "store_dual_write: true\n");
    writeFileSync(batchConfig, "store_dual_write: false\n");
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = machineConfig;
    seedPreference("hush", { visibility: ["private"] });
    applyWriteBatch(vault, [evidence("pref-hush")], {
      requestId: "batch-hush",
      configPath: batchConfig,
    });
    expect(receiptKeys("shared")).toEqual([]);
    expect(receiptKeys("private")).toEqual(["batch-hush"]);
  });

  test("a log line naming a bare private preference id keeps its batch receipt out of shared", () => {
    seedPreference("hush", { visibility: ["private"] });
    applyWriteBatch(vault, [{ kind: "append_log_line", input: { text: "pref-hush" } }], {
      requestId: "batch-log",
    });
    // The log writer routes the event to private; the receipt follows it.
    expect(logEvents("private").length).toBe(1);
    expect(logEvents("shared")).toEqual([]);
    expect(receiptKeys("shared")).toEqual([]);
    expect(receiptKeys("private")).toEqual(["batch-log"]);
  });

  test("evidence whose artifact names a private page keeps its batch receipt out of shared", () => {
    seedPreference("open");
    writePage("Notes/secret.md", "visibility: [private]");
    applyWriteBatch(
      vault,
      [
        {
          kind: "apply_evidence",
          input: {
            pref_id: "pref-open",
            artifact: "[[Notes/secret]]",
            result: "applied",
            agent: "claude",
          },
        },
      ],
      { requestId: "batch-secret-artifact" },
    );
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
    expect(receiptKeys("shared")).toEqual([]);
    expect(receiptKeys("private")).toEqual(["batch-secret-artifact"]);
  });

  test("an opaque key or hash that looks like a reference does not make a receipt private", () => {
    seedPreference("open");
    appendApplyEvidence(vault, {
      pref_id: "pref-open",
      artifact: "[[some-note]]",
      result: "applied",
      agent: "claude",
      idempotency_key: "pref-unused",
    });
    applyWriteBatch(
      vault,
      [
        {
          kind: "apply_evidence",
          input: { pref_id: "pref-open", artifact: "[[x]]", result: "violated", agent: "claude" },
        },
      ],
      { requestId: "ret-unused" },
    );
    expect(receiptKeys("shared")).toEqual(["pref-unused", "ret-unused"]);
    expect(ledgerRows("private", "idempotency")).toEqual([]);
  });

  test("a private receipt is refused on a machine without the private partition", () => {
    rmSync(join(storeRoot, "private"), { recursive: true, force: true });
    seedPreference("hush", { visibility: ["private"], idempotency_key: "k-hush" });
    expect(ledgerRows("shared", "idempotency")).toEqual([]);
    expect(readDualWriteStatus().failures).toBeGreaterThan(0);
  });
});

describe("recurrence events", () => {
  test("a source naming a private page, or a page link that names none, stays out of shared", () => {
    writePage("Notes/secret.md", "visibility: [private]");
    writePage("Notes/open.md", "topic: x");
    const learn = (sourceId: string): void => {
      applyRecurrenceEvidence(vault, {
        contentHash: "h1",
        scope: "coding",
        sourceId,
        action: "learn",
      });
    };
    learn("[[Notes/secret]]");
    learn("[[Notes/missing]]");
    purgeRecurrenceSource(vault, "Notes/secret.md");
    learn("[[Notes/open]]");
    learn("session-42");
    const sources = (partition: "shared" | "private"): unknown[] =>
      ledgerRows(partition, "recurrence").map(
        (r) => (r.body["row"] as Record<string, unknown>)["sourceId"],
      );
    expect(sources("shared")).toEqual(["[[Notes/open]]", "session-42"]);
    expect(sources("private")).toEqual([
      "[[Notes/secret]]",
      "[[Notes/missing]]",
      "Notes/secret.md",
    ]);
  });
});

describe("continuity turns", () => {
  test("a turn that links a private page stays out of shared", () => {
    writePage("Notes/secret.md", "visibility: [private]");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-11-06T10:00:00.000Z",
      payload: { text: "worked on [[Notes/secret]]" },
    });
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-11-06T10:01:00.000Z",
      payload: { text: "plain turn" },
    });
    expect(ledgerRows("shared", "continuity").length).toBe(1);
    expect(ledgerRows("private", "continuity").length).toBe(1);
  });
});

describe("the row judge", () => {
  test("judges strings at any depth and fails closed past its depth bound", () => {
    seedPreference("hush", { visibility: ["private"] });
    expect(rowNamesPrivatePage(vault, { a: [{ b: "see [[pref-hush]]" }] })).toBe(true);
    expect(rowNamesPrivatePage(vault, { a: ["x <private>y</private>"] })).toBe(true);
    expect(rowNamesPrivatePage(vault, { ref: "pref-never-written" })).toBe(true);
    expect(rowNamesPrivatePage(vault, { n: 1, text: "plain", list: ["a", "b"] })).toBe(false);
    let deep: unknown = "plain";
    for (let i = 0; i < 10_000; i++) deep = [deep];
    expect(rowNamesPrivatePage(vault, deep)).toBe(true);
  });
});
