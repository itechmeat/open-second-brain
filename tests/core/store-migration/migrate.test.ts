/**
 * The migration on the first machine (task 2.3): a clean run, a run killed
 * half way and resumed, a write attempted during the run, two legacy items
 * with identical content, a file that grows during conversion, a
 * verification gap and a backup failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { frozenMarkerPath, resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import {
  holdMigrationGate,
  MigrationInProgressError,
  readMigrationGate,
} from "../../../src/core/migration-gate.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { STORE_DUAL_WRITE_ENV } from "../../../src/core/store/constants.ts";
import { MigrationBackupError } from "../../../src/core/store-migration/backup.ts";
import {
  migrationDir,
  readMigrationState,
  writeMigrationState,
} from "../../../src/core/store-migration/journal.ts";
import { MigrationRefusedError, runMigration } from "../../../src/core/store-migration/migrate.ts";
import { MigrationGateBusyError } from "../../../src/core/store-migration/quiesce.ts";
import {
  DEVICE_SWITCHED_KIND,
  isDeviceSwitched,
  MIGRATION_COHORT_KIND,
  MIGRATION_DONE_KIND,
  MIGRATION_STREAM,
  migrationDoneBody,
} from "../../../src/core/store-migration/migration-records.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  readVaultBindings,
  vaultBindingPath,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { readViewWriter } from "../../../src/core/view/writer.ts";
import { BENCH_DEVICE, makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";
import {
  addProviderProfile,
  loadProviderRegistry,
  type ProviderProfile,
} from "../../../src/core/search/embeddings/registry.ts";
import {
  addRerankProviderProfile,
  loadRerankRegistry,
  type RerankProviderProfile,
} from "../../../src/core/search/rerank/registry.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench();
});
afterEach(() => bench.cleanup());

const FAST = { settleMs: 0 } as const;
const KILL_CHILD = join(import.meta.dir, "fixtures", "kill-child.ts");

/** The legacy item keys of the fixture vault with nothing unmapped. */
const FIXTURE_ITEM_KEYS = [
  ".open-second-brain/hook-audit/2026-W45.dev-b.jsonl#1",
  "Brain/inbox/2026-11-01-tabs.md",
  "Brain/inbox/processed/2026-10-01-old.md",
  "Brain/log/2026-10-01.jsonl#1",
  "Brain/log/2026-11-01.dev-a.jsonl#1",
  "Brain/log/2026-11-01.dev-a.jsonl#2",
  "Brain/log/2026-11-01.dev-b.jsonl#1",
  "Brain/log/2026-11-01.dev-b.jsonl#3",
  "Brain/log/continuity/2026-09.dev-c.jsonl#1",
  "Brain/log/continuity/2026-11.dev-a.jsonl#1",
  "Brain/log/pref-audit/pref-secret/device.dev-a.jsonl#1",
  "Brain/logs/idempotency/2026-11.dev-b.jsonl#1",
  "Brain/metrics/recall.dev-a.jsonl#1",
  "Brain/obligations/archive/obl-old.md",
  "Brain/pending/2026-11-02-staged.md",
  "Brain/pinned.md",
  "Brain/preferences/pref-open.history.dev-a.jsonl#1",
  "Brain/preferences/pref-open.md",
  "Brain/preferences/pref-secret.md",
  "Brain/procedures/deploy.md",
  "Brain/retired/ret-gone.md",
  "Brain/standing-rules.md",
  "Brain/standing-rules/project/osb.md",
  "Brain/state/current-focus.md",
];

function kinds(): string[] {
  return bench.records().map((r) => r.kind);
}

describe("runMigration", () => {
  test("accepted skills under Brain/skills move to the vault's skills/ as files, not records", () => {
    const legacy = join(bench.vault, "Brain", "skills", "release-ritual", "SKILL.md");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, "---\nname: release-ritual\ndescription: d\n---\nBody.\n");
    const taken = join(bench.vault, "skills", "mine", "SKILL.md");
    mkdirSync(join(taken, ".."), { recursive: true });
    writeFileSync(taken, "the user's own\n");
    const clash = join(bench.vault, "Brain", "skills", "mine", "SKILL.md");
    mkdirSync(join(clash, ".."), { recursive: true });
    writeFileSync(clash, "the legacy copy\n");
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(bench.vault, "skills", "release-ritual", "SKILL.md"), "utf8"),
    ).toContain("release-ritual");
    expect(result.vault_files).toContain("Brain/skills/release-ritual/SKILL.md");
    // A different file already there is the user's: kept and named.
    expect(readFileSync(taken, "utf8")).toBe("the user's own\n");
    expect(result.vault_files_kept).toEqual(["Brain/skills/mine/SKILL.md"]);
    expect(bench.records().some((r) => String(r.body["entry"] ?? "").includes("skills"))).toBe(
      false,
    );
  });

  test("a custom search provider registered before the switch still resolves after it", () => {
    const embed: ProviderProfile = {
      name: "my-embed",
      baseUrl: "http://127.0.0.1:9/v1",
      defaultModel: "m",
      envKey: "O2B_TEST_EMBED_KEY",
    };
    const rerank: RerankProviderProfile = {
      name: "my-rerank",
      baseUrl: "http://127.0.0.1:9/v1",
      defaultModel: "r",
      envKey: "O2B_TEST_RERANK_KEY",
    };
    addProviderProfile(bench.vault, embed);
    addRerankProviderProfile(bench.vault, rerank);
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    forgetMachineStateCache();
    expect(loadProviderRegistry(bench.vault).map((p) => p.name)).toEqual(["my-embed"]);
    expect(loadRerankRegistry(bench.vault).map((p) => p.name)).toEqual(["my-rerank"]);
    // Device-local, never a shared record.
    expect(bench.records().some((r) => JSON.stringify(r.body).includes("my-embed"))).toBe(false);
  });

  test("a clean run imports every item once, backs up, archives and records the switch", () => {
    const prefsBefore = digestVaultTree(join(bench.vault, "Brain", "preferences"), { mtime: true });
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(result.gaps).toEqual([]);

    const byKey = bench.byKey();
    for (const [key, records] of byKey) expect([key, records.length]).toEqual([key, 1]);
    // Every item the fixture plants (legacy-vault.ts), by its own key; the
    // malformed dev-b line 2 is archived, not imported. The one key beyond
    // them is the run's own log row of today (the snapshot audit).
    const runOwn = [...byKey.keys()].filter(
      (k) =>
        /^Brain\/log\/\d{4}-\d{2}-\d{2}\.dev-a\.jsonl#1$/.test(k) &&
        !k.startsWith("Brain/log/2026-11-01."),
    );
    expect(runOwn).toHaveLength(1);
    expect([...byKey.keys()].filter((k) => k !== runOwn[0]).toSorted()).toEqual(FIXTURE_ITEM_KEYS);
    expect(byKey.get("Brain/inbox/2026-11-01-tabs.md")?.[0]?.kind).toBe("signal");
    expect(byKey.get("Brain/log/2026-11-01.dev-b.jsonl#3")?.[0]?.kind).toBe("log-event");
    expect(byKey.get("Brain/standing-rules.md")?.[0]?.body["authority"]).toBe("human");
    expect(byKey.get("Brain/preferences/pref-secret.md")?.[0]?.partition).toBe("private");

    expect(kinds().filter((k) => k === MIGRATION_COHORT_KIND)).toHaveLength(1);
    expect(kinds().filter((k) => k === MIGRATION_DONE_KIND)).toHaveLength(1);
    expect(kinds().filter((k) => k === DEVICE_SWITCHED_KIND)).toHaveLength(1);
    expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(true);
    expect(isDeviceSwitched(bench.store(), "dev-b")).toBe(false);
    expect(result.cohort).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(result.view_writer).toBe(BENCH_DEVICE);
    expect(readViewWriter(bench.store()).writer).toBe(BENCH_DEVICE);

    // Backups: the snapshot copy and the explicit backup of the secrets.
    expect(result.backup?.snapshot).toMatch(/^store-migration-/);
    expect(result.backup?.files.map((f) => f.path)).toContain(".open-second-brain/secrets/keyfile");
    // The malformed line is kept with its path, line and bytes.
    const archived = readFileSync(result.unparseable_archive, "utf8").trim().split("\n");
    const row = JSON.parse(archived[0]!) as Record<string, unknown>;
    expect(row).toMatchObject({
      path: "Brain/log/2026-11-01.dev-b.jsonl",
      line: 2,
      reason: "not JSON",
    });
    expect(Buffer.from(row["bytes_base64"] as string, "base64").toString()).toBe("{not json");

    expect(existsSync(frozenMarkerPath(bench.vault))).toBe(false);
    expect(readMigrationGate()).toBeNull();
    expect(digestVaultTree(join(bench.vault, "Brain", "preferences"), { mtime: true })).toBe(
      prefsBefore,
    );
    expect(readMigrationState(migrationDir(bench.store()))?.phase).toBe("done");
    expect(() => runMigration(bench.vault, FAST)).toThrow("already switched");
    // Device-local state: the backup-class secrets live in `local/` after
    // the switch; the vault's search index is not copied (it is rebuilt).
    const local = join(migrationDir(bench.store()), "local", ".open-second-brain");
    expect(readFileSync(join(local, "secrets", "keyfile"), "utf8")).toBe("secret-bytes");
    expect(existsSync(join(local, "brain.sqlite"))).toBe(false);
  });

  test("a run killed half way keeps the gate, refuses writers and resumes with --resume once", () => {
    // A real kill: the child SIGKILLs itself after the fifth item's records
    // are appended and before its journal row, so no `finally` lifts the
    // gate and no state is saved on the way out.
    const child = Bun.spawnSync(
      [process.execPath, "run", KILL_CHILD, "migrate", bench.vault, "5"],
      { env: { ...process.env, ...bench.env }, stdout: "ignore", stderr: "pipe" },
    );
    expect(child.success).toBe(false);
    expect(child.exitCode).not.toBe(3);
    if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
    resetFreezeMarkerCache();

    // What the kill left: an interrupted run that still holds the gate,
    // and part of the vault in the store.
    const state = readMigrationState(migrationDir(bench.store()));
    expect(state?.phase).toBe("in-progress");
    expect(readMigrationGate()?.run_id).toBe(state!.run_id);
    const partial = bench.byKey().size;
    expect(partial).toBeGreaterThanOrEqual(5);

    // Between the crash and the resume this machine's writers are refused
    // and nothing lands in the legacy tree.
    const inbox = join(bench.vault, "Brain", "inbox");
    const inboxBefore = readdirSync(inbox).toSorted();
    expect(() =>
      writeSignal(bench.vault, {
        topic: "after-crash",
        signal: "positive",
        agent: "@late",
        principle: "Written after the crash",
        created_at: "2026-11-06T10:00:00Z",
        date: "2026-11-06",
        slug: "after-crash",
      }),
    ).toThrow(MigrationInProgressError);
    expect(readdirSync(inbox).toSorted()).toEqual(inboxBefore);
    // A fresh run is refused: only --resume continues the interrupted one.
    expect(() => runMigration(bench.vault, FAST)).toThrow(MigrationRefusedError);

    const result = runMigration(bench.vault, { ...FAST, resume: true });
    expect(result.ok).toBe(true);
    expect(result.run_id).toBe(state!.run_id);
    expect(bench.byKey().size).toBeGreaterThan(partial);
    for (const [key, records] of bench.byKey()) expect([key, records.length]).toEqual([key, 1]);
    expect(kinds().filter((k) => k === MIGRATION_COHORT_KIND)).toHaveLength(1);
    expect(readMigrationGate()).toBeNull();
  });

  test("a write attempted during the migration is refused and leaves no legacy file", () => {
    const inbox = join(bench.vault, "Brain", "inbox");
    const before = readdirSync(inbox).toSorted();
    let refused: unknown = null;
    const result = runMigration(bench.vault, {
      ...FAST,
      hooks: {
        afterBackup: () => {
          try {
            writeSignal(bench.vault, {
              topic: "late",
              signal: "positive",
              agent: "@late",
              principle: "Written while migrating",
              created_at: "2026-11-06T10:00:00Z",
              date: "2026-11-06",
              slug: "late",
            });
          } catch (error) {
            refused = error;
          }
        },
      },
    });
    expect(refused).toBeInstanceOf(MigrationInProgressError);
    expect(readdirSync(inbox).toSorted()).toEqual(before);
    // The refused write left the run itself whole.
    expect(result.ok).toBe(true);
  });

  test("two legacy items with identical content stay two records", () => {
    const line = JSON.stringify({
      ts: "2026-11-02T00:00:00Z",
      kind: "note",
      payload: { text: "same" },
    });
    bench.fx.write("Brain/log/2026-11-02.dev-a.jsonl", `${line}\n${line}\n`);
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const byKey = bench.byKey();
    const a = byKey.get("Brain/log/2026-11-02.dev-a.jsonl#1")!;
    const b = byKey.get("Brain/log/2026-11-02.dev-a.jsonl#2")!;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });

  test("a legacy file that grows during conversion is imported by the delta pass", () => {
    const shard = join(bench.vault, "Brain", "log", "2026-11-01.dev-a.jsonl");
    const late = JSON.stringify({
      ts: "2026-11-01T23:00:00Z",
      kind: "note",
      payload: { text: "late" },
    });
    let grown = false;
    const result = runMigration(bench.vault, {
      ...FAST,
      hooks: {
        afterItemAppended: () => {
          if (grown) return;
          grown = true;
          appendFileSync(shard, `${late}\n`);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.passes).toBeGreaterThan(1);
    const lines = readFileSync(shard, "utf8").trim().split("\n").length;
    const imported = bench.byKey().get(`Brain/log/2026-11-01.dev-a.jsonl#${lines}`);
    expect(imported?.[0]?.body["body"]).toMatchObject({ text: "late" });
  });

  test("a verification gap fails the run, names the item and leaves the legacy tree", () => {
    const signal = join(bench.vault, "Brain", "inbox", "2026-11-01-tabs.md");
    const before = readFileSync(signal, "utf8");
    const result = runMigration(bench.vault, {
      ...FAST,
      hooks: {
        beforeVerify: () => {
          // Lose the signal's record, as a damaged shard would.
          const dir = join(bench.storeRoot, "shared", "events", BENCH_DEVICE);
          for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            const kept = readFileSync(path, "utf8")
              .split("\n")
              .filter((l) => !l.includes('"sig-tabs"'));
            writeFileSync(path, kept.join("\n"));
          }
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.gaps.map((g) => g.key)).toContain("Brain/inbox/2026-11-01-tabs.md");
    expect(result.migration_done).toBeNull();
    expect(kinds()).not.toContain(MIGRATION_DONE_KIND);
    expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(readFileSync(signal, "utf8")).toBe(before);
    expect(readMigrationState(migrationDir(bench.store()))?.phase).toBe("failed");
  });

  test("a backup failure stops the run before anything is imported", () => {
    const dir = migrationDir(bench.store());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "backup"), "a file where the backup folder goes");
    expect(() => runMigration(bench.vault, FAST)).toThrow(MigrationBackupError);
    expect(bench.byKey().size).toBe(0);
    expect(kinds()).not.toContain(MIGRATION_COHORT_KIND);
    expect(readMigrationState(dir)?.phase).toBe("failed");
    expect(existsSync(frozenMarkerPath(bench.vault))).toBe(false);
  });

  test("imported records name the device of their legacy shard", () => {
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const byKey = bench.byKey();
    expect(byKey.get("Brain/log/2026-11-01.dev-b.jsonl#3")?.[0]?.body["legacy_device"]).toBe(
      "dev-b",
    );
    expect(byKey.get("Brain/log/2026-10-01.jsonl#1")?.[0]?.body["legacy_device"]).toBe("");
    expect(byKey.get("Brain/inbox/2026-11-01-tabs.md")?.[0]?.body["legacy_device"]).toBe("");
  });

  test("an item cut off between its two records is completed on resume", () => {
    bench.fx.write(
      "Brain/preferences/pref-mine.md",
      "---\nid: pref-mine\nprinciple: Mine\norigin_channel: cli\nstatus: active\n---\n",
    );
    expect(() =>
      runMigration(bench.vault, {
        ...FAST,
        hooks: {
          afterPartAppended: (part, parts) => {
            if (parts === 2 && part === 0) throw new Error("killed between parts");
          },
        },
      }),
    ).toThrow("killed between parts");
    expect(runMigration(bench.vault, { ...FAST, resume: true }).ok).toBe(true);
    const records = bench.byKey().get("Brain/preferences/pref-mine.md")!;
    expect(records.map((r) => (r.body["migrated"] as { part: number }).part).toSorted()).toEqual([
      0, 1,
    ]);
    expect(records.map((r) => r.body["authority"]).toSorted()).toEqual(["agent", "human"]);
  });

  test("copies a dual write already stored are matched, not imported again", () => {
    const prior = process.env[STORE_DUAL_WRITE_ENV];
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    try {
      const event = {
        timestamp: "2026-11-03T10:00:00Z",
        eventType: "note",
        agent: "@dw",
        body: { text: "dw" },
      } as const;
      appendLogEvent(bench.vault, event);
      appendLogEvent(bench.vault, event);
      writeSignal(bench.vault, {
        topic: "dw",
        signal: "positive",
        agent: "@dw",
        principle: "Dual written",
        created_at: "2026-11-03T10:00:00Z",
        date: "2026-11-03",
        slug: "dw-sig",
      });
    } finally {
      if (prior === undefined) delete process.env[STORE_DUAL_WRITE_ENV];
      else process.env[STORE_DUAL_WRITE_ENV] = prior;
    }
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const all = bench.records();
    const dwEvents = all.filter(
      (r) => r.kind === "log-event" && (r.body["body"] as { text?: string })?.text === "dw",
    );
    expect(dwEvents).toHaveLength(2);
    expect(dwEvents.every((r) => r.body["migrated"] === undefined)).toBe(true);
    const dwSignals = all.filter(
      (r) => r.kind === "signal" && String(r.body["id"]).includes("dw-sig"),
    );
    expect(dwSignals).toHaveLength(1);
  });

  test("a run that recorded its own completion before a kill stays the first machine", () => {
    // What a kill between `migration-done` and `device-switched` leaves.
    const own = appendRecord(bench.store(), {
      partition: "shared",
      stream: MIGRATION_STREAM,
      kind: MIGRATION_DONE_KIND,
      agent: "test",
      body: migrationDoneBody({ vaultId: null, device: BENCH_DEVICE, cuts: {}, imported: 0 }),
    }).record.id;
    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(result.role).toBe("first");
    expect(result.migration_done).toBe(own);
    expect(kinds().filter((k) => k === MIGRATION_DONE_KIND)).toHaveLength(1);
    expect(readViewWriter(bench.store()).writer).toBe(BENCH_DEVICE);
  });

  test("a run killed after its switch record is finished by the next migrate-store", () => {
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    // What a kill right after `device-switched` leaves: the run still
    // in progress, the gate held and the vault not bound yet.
    const dir = migrationDir(bench.store());
    const state = readMigrationState(dir)!;
    writeMigrationState(dir, { ...state, phase: "in-progress" });
    holdMigrationGate(bench.vault, state.run_id);
    rmSync(vaultBindingPath(), { force: true });

    const outcome = migrateStore(bench.vault, FAST);
    expect(outcome.mode).toBe("transition");
    expect(readMigrationState(dir)?.phase).toBe("done");
    expect(readMigrationGate()).toBeNull();
    expect(readVaultBindings().map((b) => b.device)).toEqual([BENCH_DEVICE]);
  });

  // POSIX modes only, and root reads a 0000 file anyway.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a store shard this machine cannot read refuses the run before anything is imported",
    () => {
      const shard = appendRecord(bench.store(), {
        partition: "shared",
        stream: "events",
        kind: "note",
        agent: "test",
        body: { text: "x" },
      }).path;
      chmodSync(shard, 0o000);
      try {
        expect(() => runMigration(bench.vault, FAST)).toThrow(MigrationRefusedError);
        expect(readMigrationState(migrationDir(bench.store()))).toBeNull();
      } finally {
        chmodSync(shard, 0o644);
      }
    },
  );

  /** A peer's events shard with two records, which this machine has read. */
  function peerShard(): string {
    const peer = openStore({ root: bench.storeRoot, device: "dev-p" });
    let shard = "";
    for (const text of ["peer one", "peer two"]) {
      shard = appendRecord(peer, {
        partition: "shared",
        stream: "events",
        kind: "note",
        agent: "test",
        body: { text },
      }).path;
    }
    expect(bench.records().length).toBeGreaterThan(0);
    return shard;
  }

  test("a store shard read only in part refuses the run before anything is imported", () => {
    const shard = peerShard();
    writeFileSync(shard, readFileSync(shard, "utf8").replace("peer one", "peer 0ne"));
    expect(() => runMigration(bench.vault, FAST)).toThrow(/shared\/events\/dev-p\//);
    expect(readMigrationState(migrationDir(bench.store()))).toBeNull();
    expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(false);
  });

  test("a store shard gone during the run refuses the switch, and a later run switches", () => {
    const shard = peerShard();
    const bytes = readFileSync(shard);
    expect(() =>
      runMigration(bench.vault, { ...FAST, hooks: { beforeVerify: () => rmSync(shard) } }),
    ).toThrow(/shared\/events\/dev-p\//);
    expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(readMigrationState(migrationDir(bench.store()))?.phase).toBe("failed");
    expect(readMigrationGate()).toBeNull();
    writeFileSync(shard, bytes);
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(true);
  });

  test("a log line that is not UTF-8 is archived with its exact bytes, never imported", () => {
    const good = JSON.stringify({
      ts: "2026-11-04T10:00:00Z",
      kind: "note",
      payload: { text: "ok" },
      prev: null,
      h: "0".repeat(64),
    });
    // Valid JSON once a lenient decoder turns 0xff into U+FFFD.
    const bad = Buffer.concat([
      Buffer.from('{"ts":"2026-11-04T11:00:00Z","kind":"note","payload":{"text":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"},"prev":null,"h":"' + "0".repeat(64) + '"}'),
    ]);
    const path = join(bench.vault, "Brain", "log", "2026-11-04.dev-b.jsonl");
    writeFileSync(path, Buffer.concat([Buffer.from(`${good}\n`), bad, Buffer.from("\n")]));

    const result = runMigration(bench.vault, FAST);
    expect(result.ok).toBe(true);
    expect(bench.byKey().has("Brain/log/2026-11-04.dev-b.jsonl#1")).toBe(true);
    expect(bench.byKey().has("Brain/log/2026-11-04.dev-b.jsonl#2")).toBe(false);
    const rows = readFileSync(result.unparseable_archive, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const row = rows.find((r) => r["path"] === "Brain/log/2026-11-04.dev-b.jsonl");
    expect(row).toMatchObject({ line: 2, reason: "not UTF-8 text" });
    expect(Buffer.from(row!["bytes_base64"] as string, "base64").equals(bad)).toBe(true);
  });

  // A directory symlink needs a privilege Windows CI does not grant.
  test.skipIf(process.platform === "win32")(
    "a link planted at the vault's skills/ refuses the move and writes nothing outside the vault",
    () => {
      const legacy = join(bench.vault, "Brain", "skills", "release-ritual", "SKILL.md");
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "---\nname: release-ritual\ndescription: d\n---\nBody.\n");
      const outside = join(bench.fx.parent, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(bench.vault, "skills"));
      expect(() => runMigration(bench.vault, FAST)).toThrow(/leads out of the vault/);
      expect(readdirSync(outside)).toEqual([]);
      expect(isDeviceSwitched(bench.store(), BENCH_DEVICE)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a dangling link planted at the vault's skills/ refuses the move and writes nothing outside the vault",
    () => {
      const legacy = join(bench.vault, "Brain", "skills", "release-ritual", "SKILL.md");
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "---\nname: release-ritual\ndescription: d\n---\nBody.\n");
      // The link's destination does not exist yet: the copy would create it.
      const outside = join(bench.fx.parent, "outside-not-yet");
      symlinkSync(outside, join(bench.vault, "skills"));
      expect(() => runMigration(bench.vault, FAST)).toThrow(/leads out of the vault/);
      expect(existsSync(outside)).toBe(false);
    },
  );

  test("a gate another vault's interrupted run holds is never taken or released", () => {
    const other = join(bench.fx.parent, "other-vault");
    mkdirSync(other);
    holdMigrationGate(other, "migrate-other");
    expect(() => runMigration(bench.vault, FAST)).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe("migrate-other");
    // Refused before it started: no interrupted run is left to resume.
    expect(readMigrationState(migrationDir(bench.store()))).toBeNull();
  });
});
