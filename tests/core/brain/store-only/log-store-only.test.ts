/**
 * The Brain log on a store-only machine (task 2.10, design D14 items 1
 * and 10): `appendLogEvent` appends one `log-event` record and writes no
 * Markdown day page and no JSONL day file; a store failure fails the
 * append unless the caller is fail-open; an unswitched machine keeps the
 * legacy day files plus the dual write; the log reader facade returns the
 * event either way.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import { collectKnownSessionIds } from "../../../../src/core/brain/doctor/orphan-session-check.ts";
import { STORE_WRITE_FAIL_OPEN_CODE } from "../../../../src/core/brain/doctor/store-check.ts";
import { appendLogEvent, LOG_CHAIN_FIELDS } from "../../../../src/core/brain/log.ts";
import { appendBrainNote } from "../../../../src/core/brain/note.ts";
import { appendMetric } from "../../../../src/core/brain/metrics.ts";
import {
  appendJournal,
  MAINTENANCE_VERDICT,
} from "../../../../src/core/brain/maintenance/journal.ts";
import { buildForgetPlan } from "../../../../src/core/brain/governance/forget-plan.ts";
import { hookAuditDir, logJsonlPath, logPath } from "../../../../src/core/brain/paths.ts";
import {
  AUDIT_STORE_LEDGER_NAME,
  appendAuditRecord,
} from "../../../../src/core/reliability/audit.ts";
import { readLogEvents } from "../../../../src/core/store/read/log-events.ts";
import { readStoreWriteStatus, StoreWriteError } from "../../../../src/core/store/store-write.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainTreeDigest, ledgerRows, partitionRecords, switchDevice } from "./fixtures.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";

const DATE = "2026-06-01";
const TS = `${DATE}T10:00:00Z`;

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function note(text: string) {
  return { timestamp: TS, eventType: "note" as const, body: { text, agent: "@tester" } };
}

function logRecords(root: string, partition: "shared" | "private") {
  return partitionRecords(root, partition).filter((r) => r.kind === "log-event");
}

describe("appendLogEvent on a store-only machine", () => {
  test("one log-event record and no byte under Brain/", () => {
    env = makeStoreEnv("osb-wp3-log-", { dualWrite: false });
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const res = appendLogEvent(env.vault, note("hello"));
    expect(brainTreeDigest(env.vault)).toBe(before);
    expect(existsSync(logPath(env.vault, DATE))).toBe(false);
    expect(existsSync(logJsonlPath(env.vault, DATE))).toBe(false);
    const records = logRecords(env.storeRoot, "shared");
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toMatchObject({
      timestamp: TS,
      event_type: "note",
      body: { text: "hello", agent: "@tester" },
    });
    expect(res.stored).toBe("store");
    expect(res.recordId).toBe(records[0]!.id);
    expect(res.storeShard).toMatch(/^shared\/log\/dev-a\/\d{4}-\d{2}\.jsonl$/);
    expect(res.logPath.startsWith(env.storeRoot)).toBe(true);
  });

  test("a store record carries no per-record hash chain (D14 item 10)", () => {
    env = makeStoreEnv("osb-wp3-log-");
    switchDevice(env.storeRoot);
    appendLogEvent(env.vault, note("one"));
    appendLogEvent(env.vault, note("two"));
    for (const record of logRecords(env.storeRoot, "shared")) {
      const inner = record.body["body"] as Record<string, unknown>;
      expect(inner[LOG_CHAIN_FIELDS.prev]).toBeUndefined();
      expect(inner[LOG_CHAIN_FIELDS.h]).toBeUndefined();
      expect(record.body[LOG_CHAIN_FIELDS.h]).toBeUndefined();
    }
  });

  test("an event of a private operation lands in private only", () => {
    env = makeStoreEnv("osb-wp3-log-");
    switchDevice(env.storeRoot);
    appendLogEvent(env.vault, note("secret"), { storePrivate: true });
    expect(logRecords(env.storeRoot, "shared")).toHaveLength(0);
    expect(logRecords(env.storeRoot, "private")).toHaveLength(1);
  });

  test("the reader facade returns the store events", () => {
    env = makeStoreEnv("osb-wp3-log-");
    switchDevice(env.storeRoot);
    appendLogEvent(env.vault, note("first"));
    appendLogEvent(env.vault, { ...note("second"), timestamp: `${DATE}T10:00:01Z` });
    const events = readLogEvents({ from: DATE, to: DATE }, { vault: env.vault });
    expect(events.map((e) => e.body["text"])).toEqual(["first", "second"]);
  });

  test("with no vault at all the event still lands in the store", () => {
    env = makeStoreEnv("osb-wp3-log-", { legacyTree: false, configureVault: false });
    const res = appendLogEvent(null, note("vault-free"));
    expect(res.stored).toBe("store");
    expect(logRecords(env.storeRoot, "shared")).toHaveLength(1);
  });

  test("telemetry writers are fail-open: counted, never thrown", () => {
    env = makeStoreEnv("osb-wp3-telemetry-", { partitions: [], legacyTree: false });
    const before = readStoreWriteStatus().failures;
    appendMetric(env.vault, { surface: "search", runAt: TS, payload: { n: 1 } });
    appendJournal(env.vault, { ts: TS, holder: "h", verdict: MAINTENANCE_VERDICT.run, task: "t" });
    expect(readStoreWriteStatus().failures).toBe(before + 2);
  });

  test("no store fails the append with the init remedy", () => {
    env = makeStoreEnv("osb-wp3-log-", { partitions: [], legacyTree: false });
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    let caught: unknown;
    try {
      appendLogEvent(env.vault, note("lost?"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreWriteError);
    expect((caught as StoreWriteError).reason).toBe("no-store");
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("a fail-open caller is counted and continues", () => {
    env = makeStoreEnv("osb-wp3-log-", { partitions: [], legacyTree: false });
    const before = readStoreWriteStatus().failures;
    const res = appendLogEvent(env.vault, note("hook"), { failOpen: true });
    expect(res).toMatchObject({ stored: "store", recordId: null, logPath: "" });
    expect(res.failed?.reason).toBe("no-store");
    expect(readStoreWriteStatus().failures).toBe(before + 1);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("brain_note reports the store shard and the record id", () => {
    env = makeStoreEnv("osb-wp3-log-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const res = appendBrainNote({ vault: env.vault, text: "shipped", agent: "@tester" });
    expect(brainTreeDigest(env.vault)).toBe(before);
    expect(res.log_path).toMatch(/^shared\/log\/dev-a\//);
    expect(res.record_id).toBe(logRecords(env.storeRoot, "shared")[0]!.id);
  });
});

describe("the forget plan over store log days", () => {
  test("a source with a backslash or a quote matches the log events that cite it", () => {
    env = makeStoreEnv("osb-forget-log-");
    switchDevice(env.storeRoot);
    const source = 'C:\\notes\\the "x".md';
    appendLogEvent(env.vault, {
      timestamp: TS,
      eventType: "note",
      body: { text: `read ${source}`, agent: "@t" },
    });
    const kinds = buildForgetPlan(env.vault, { source }).entries.map((e) => e.kind);
    expect(kinds).toContain("log");
  });
});

describe("a note's shared-namespace mirror once switched", () => {
  test("is not written: the note is one store record, nothing lands in the shared vault", () => {
    env = makeStoreEnv("osb-note-mirror-");
    switchDevice(env.storeRoot);
    const shared = join(env.parent, "shared-vault");
    mkdirSync(shared, { recursive: true });
    writeFileSync(env.configPath, `vault: ${env.vault}\nshared_namespace: ${shared}\n`);
    const res = appendBrainNote({
      vault: env.vault,
      text: "shipped",
      agent: "@tester",
      configPath: env.configPath,
    });
    expect(res.log_path).toMatch(/^shared\/log\/dev-a\//);
    const notes = logRecords(env.storeRoot, "shared").filter((r) =>
      JSON.stringify(r.body).includes("shipped"),
    );
    expect(notes).toHaveLength(1);
    expect(readdirSync(shared)).toEqual([]);
  });
});

describe("appendLogEvent on an unswitched machine", () => {
  test("the legacy day files and the dual write, as before", () => {
    env = makeStoreEnv("osb-wp3-log-");
    const res = appendLogEvent(env.vault, note("legacy"));
    expect(res).toMatchObject({ stored: "legacy", recordId: null, storeShard: null });
    expect(res.logPath).toBe(logPath(env.vault, DATE).replace(/\.md$/, ".dev-a.md"));
    expect(existsSync(res.logPath)).toBe(true);
    expect(logRecords(env.storeRoot, "shared")).toHaveLength(1);
    const events = readLogEvents({ from: DATE, to: DATE }, { vault: env.vault });
    expect(events.map((e) => e.body["text"])).toEqual(["legacy"]);
  });

  test("with dual writes off the store is untouched", () => {
    env = makeStoreEnv("osb-wp3-log-", { dualWrite: false });
    appendLogEvent(env.vault, note("legacy"));
    expect(logRecords(env.storeRoot, "shared")).toHaveLength(0);
  });
});

describe("audit trails on a store-only machine", () => {
  test("one reliability-audit row, nothing under the vault", () => {
    env = makeStoreEnv("osb-wp3-audit-");
    switchDevice(env.storeRoot);
    const before = digestVaultTree(env.vault);
    const root = join(env.vault, "Brain", "log", "hygiene-audit");
    const path = appendAuditRecord(root, {
      timestamp: TS,
      actor: "@tester",
      action: "hygiene_apply",
      target: "Brain/x",
      ok: true,
    });
    expect(digestVaultTree(env.vault)).toBe(before);
    expect(existsSync(root)).toBe(false);
    // The ledger's store name, never the device path of a store shard.
    expect(path).toBe(AUDIT_STORE_LEDGER_NAME);
    const rows = [
      ...ledgerRows(env.storeRoot, "shared", "reliability-audit"),
      ...ledgerRows(env.storeRoot, "private", "reliability-audit"),
    ];
    expect(rows).toEqual([
      {
        audit_dir: "hygiene-audit",
        record: {
          timestamp: TS,
          actor: "@tester",
          action: "hygiene_apply",
          target: "Brain/x",
          ok: true,
        },
      },
    ]);
  });

  test("a trail outside the vault stays a device-local file", () => {
    env = makeStoreEnv("osb-wp3-audit-");
    switchDevice(env.storeRoot);
    const root = join(env.parent, "state", "hook-audit");
    const path = appendAuditRecord(root, {
      timestamp: TS,
      actor: "hook",
      action: "view_render",
      target: "view",
      ok: true,
    });
    expect(path.startsWith(root)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(ledgerRows(env.storeRoot, "shared", "reliability-audit")).toEqual([]);
    expect(ledgerRows(env.storeRoot, "private", "reliability-audit")).toEqual([]);
  });

  test("a failed store write is fail-open for an audit marked so, and throws otherwise", () => {
    env = makeStoreEnv("osb-wp3-audit-", { partitions: [], legacyTree: false });
    // A bare vault is store-only, so the hook audit is device-local machine
    // state: it lands as a file and needs no store.
    const hookRoot = hookAuditDir(env.vault);
    expect(hookRoot.startsWith(env.vault)).toBe(false);
    const hookPath = appendAuditRecord(hookRoot, {
      timestamp: TS,
      actor: "hook",
      action: "x",
      target: "y",
      ok: true,
    });
    expect(existsSync(hookPath)).toBe(true);
    const inVault = join(env.vault, "Brain", "log", "hygiene-audit");
    const record = { timestamp: TS, actor: "o2b", action: "x", target: "y", ok: true } as const;
    expect(appendAuditRecord(inVault, record, undefined, { failOpen: true })).toBe("");
    expect(() => appendAuditRecord(inVault, record)).toThrow(StoreWriteError);
  });
});

describe("o2b brain log verify on a store-only machine", () => {
  test("it says the store records carry no chain and walks the legacy day files only", async () => {
    env = makeStoreEnv("osb-wp3-verify-");
    appendLogEvent(env.vault, note("legacy, chained"));
    switchDevice(env.storeRoot);
    appendLogEvent(env.vault, { ...note("store"), timestamp: `${DATE}T10:00:05Z` });
    const res = await runCli(["brain", "log", "verify", "--vault", env.vault, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, covers: "legacy-day-files", store_only: true });
    expect(String(out["store_integrity"])).toContain("no hash chain");
    const shards = out["shards"] as Array<{ chained: number }>;
    expect(shards.map((x) => x.chained)).toEqual([1]);
    const plain = await runCli(["brain", "log", "verify", "--vault", env.vault]);
    expect(plain.stdout).toContain("this machine writes the brain store only");
  });
});

describe("the orphan-session check on a store-only machine", () => {
  test("sessions known only to the store are known", () => {
    env = makeStoreEnv("osb-wp3-orphan-");
    switchDevice(env.storeRoot);
    appendLogEvent(env.vault, {
      timestamp: TS,
      eventType: "session-lifecycle",
      body: { agent: "@tester", event: "SessionStart", session_id: "s-log" },
    });
    appendContinuityRecord(env.vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-01T10:00:00.000Z",
      payload: { session_id: "s-continuity" },
    });
    const universe = collectKnownSessionIds(env.vault);
    expect(universe.complete).toBe(true);
    expect(universe.ids.has("s-log")).toBe(true);
    expect(universe.ids.has("s-continuity")).toBe(true);
  });
});

describe("doctor on a machine whose fail-open writes did not land", () => {
  test("names the count and the last reason", () => {
    env = makeStoreEnv("osb-wp3-doctor-", { partitions: [], legacyTree: false });
    appendLogEvent(env.vault, note("lost"), { failOpen: true });
    // The doctor reads a vault with a legacy tree; the counter is device-local.
    mkdirSync(join(env.vault, "Brain"), { recursive: true });
    const report = runDoctor(env.vault, { now: new Date(TS) });
    const finding = report.warnings.find((i) => i.code === STORE_WRITE_FAIL_OPEN_CODE);
    expect(finding?.message).toContain("fail-open brain store write(s)");
    expect(finding?.message).toContain("o2b store init");
  });
});
