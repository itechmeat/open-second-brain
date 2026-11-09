/**
 * The doctor's brain store section (task 1.11): silent while the store is
 * not in use, and when it is, the dual-write counters, state-digest
 * findings and same-id conflicts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  STORE_CLOCK_AHEAD_CODE,
  STORE_DIGEST_DIVERGENT_CODE,
  STORE_DUAL_WRITE_FAILURES_CODE,
  STORE_DUAL_WRITE_NO_STORE_CODE,
  STORE_MISSING_CODE,
  STORE_DIGEST_SILENT_CODE,
  STORE_PARTITION_LOST_CODE,
  STORE_PARTITION_UNREADABLE_CODE,
  STORE_RECORD_ID_CONFLICT_CODE,
  STORE_ROOT_INVALID_CODE,
  STORE_SHARD_TAIL_HELD_CODE,
  STORE_SHARD_UNREADABLE_CODE,
  STORE_REMOVED_AWAITING_COMPACTION_CODE,
} from "../../../src/core/brain/doctor/store-check.ts";
import {
  reservedDeviceDirIssues,
  STORE_DEVICE_DIR_RESERVED_CODE,
  STORE_MODE_LOOSE_CODE,
  STORE_RECORD_ID_CROSS_PARTITION_CODE,
} from "../../../src/core/brain/doctor/store-trust-check.ts";
import { STORE_DEVICE_RETIRED_RETURNED_CODE } from "../../../src/core/brain/doctor/device-retire-check.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { bodyChecksum } from "../../../src/core/store/envelope.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { publishStateDigest } from "../../../src/core/store/state-digest.ts";
import { inspectStore, openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { ensureStore } from "../store/fixtures/temp-store.ts";
import { dualWriteStatusPath, shardPath } from "../../../src/core/store/store-paths.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
] as const;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-doctor-store-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["XDG_DATA_HOME"] = join(parent, "data");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  delete process.env[STORE_DUAL_WRITE_ENV];
  delete process.env[STORE_ROOT_ENV];
  resetVaultIdentityPins();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetVaultIdentityPins();
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function storeCodes(): string[] {
  const report = runDoctor(vault, { now: new Date(NOW + 10) });
  return [...report.warnings, ...report.errors]
    .map((issue) => issue.code)
    .filter((code) => code.startsWith("store-"));
}

function writeFailureCounter(failures: number): void {
  const path = dualWriteStatusPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ failures, skipped_no_device: 0, last_error: "disk full" }));
}

/** Open the store as `device`, with that machine's own device-local state. */
function machine(device: string): StoreHandle {
  ensureStore(storeRoot);
  return openStore({
    root: storeRoot,
    device,
    dirs: {
      platform: process.platform,
      home: join(parent, "home", device),
      env: {
        XDG_STATE_HOME: join(parent, "state", device),
        LOCALAPPDATA: join(parent, "state", device),
      },
    },
  });
}

const at = (ms: number) => () => ms;

describe("store not in use", () => {
  test("no flag and no store root: the section says nothing, even about old counters", () => {
    writeFailureCounter(4);
    expect(storeCodes()).toEqual([]);
    // Read-only: the default store root was not created by looking.
    expect(existsSync(join(parent, "data"))).toBe(false);
  });

  test("a configured root with no store and the flag off asks for no init", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    expect(storeCodes()).toEqual([]);
    expect(existsSync(storeRoot)).toBe(false);
  });
});

describe("store in use", () => {
  test("the flag on with failed dual writes reports the failure count", () => {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    process.env[STORE_ROOT_ENV] = storeRoot;
    writeFailureCounter(3);
    const report = runDoctor(vault, { now: new Date(NOW) });
    const finding = report.warnings.find((i) => i.code === STORE_DUAL_WRITE_FAILURES_CODE);
    expect(finding?.message).toContain("3 brain store dual write(s) failed");
    expect(finding?.message).toContain("disk full");
    // No store was created, so the only other finding is the init hint.
    expect(storeCodes()).toEqual([STORE_DUAL_WRITE_FAILURES_CODE, STORE_MISSING_CODE]);
    expect(existsSync(storeRoot)).toBe(false);
  });

  test("no store yet: doctor says to run o2b store init, and creates nothing", () => {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    process.env[STORE_ROOT_ENV] = storeRoot;
    const report = runDoctor(vault, { now: new Date(NOW) });
    const finding = report.warnings.find((i) => i.code === STORE_MISSING_CODE);
    expect(finding?.message).toContain("o2b store init");
    expect(existsSync(storeRoot)).toBe(false);
  });

  test("dual writes skipped for lack of a store are counted and point at the init", () => {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = dualWriteStatusPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ failures: 0, skipped_no_store: 4 }));
    machine("dev-a"); // the store exists now; the skipped records are still missing
    const report = runDoctor(vault, { now: new Date(NOW) });
    const finding = report.warnings.find((i) => i.code === STORE_DUAL_WRITE_NO_STORE_CODE);
    expect(finding?.message).toContain("4 brain store dual write(s) were skipped");
    expect(finding?.message).toContain("o2b store init");
    expect(storeCodes()).not.toContain(STORE_MISSING_CODE);
  });

  test("a partition this machine has held that lost its identity file is named as an error", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    ensureStore(storeRoot);
    openStore({ root: storeRoot, device: "dev-a" });
    rmSync(join(storeRoot, "private", "store.json"));
    const report = runDoctor(vault, { now: new Date(NOW) });
    const finding = report.errors.find((i) => i.code === STORE_PARTITION_LOST_CODE);
    expect(finding?.message).toContain("private partition");
    expect(finding?.message).toContain("private/store.json");
    expect(storeCodes()).toEqual([STORE_PARTITION_LOST_CODE]);
  });

  test("a store that never held private on this machine is no finding", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    initStore({ root: storeRoot, partitions: ["shared"] });
    openStore({ root: storeRoot, device: "dev-a" });
    expect(storeCodes()).not.toContain(STORE_PARTITION_LOST_CODE);
  });

  test("a configured root inside the vault is reported, not thrown", () => {
    process.env[STORE_ROOT_ENV] = join(vault, "store");
    expect(storeCodes()).toEqual([STORE_ROOT_INVALID_CODE]);
  });

  test("a root inside the vault is reported when the vault is reached through a link", () => {
    // A directory junction needs no privilege on Windows; elsewhere the type is ignored.
    const linked = join(parent, "linked-vault");
    symlinkSync(vault, linked, "junction");
    process.env[STORE_ROOT_ENV] = join(vault, "store");
    const report = runDoctor(linked, { now: new Date(NOW) });
    expect(report.warnings.map((i) => i.code)).toContain(STORE_ROOT_INVALID_CODE);
  });

  // An unreadable shard file needs POSIX permissions and a user they bind.
  const canDenyRead = !CHMOD_CANNOT_DENY;
  test.if(canDenyRead)(
    "a partition that cannot be read is reported and the others are still checked",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      const a = machine("dev-a");
      const written = appendRecord(
        a,
        { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "one" } },
        { now: at(NOW - 1000) },
      );
      const body = { text: "edited" };
      const forged = { ...written.record, body, sum: bodyChecksum(body) };
      const copy = shardPath(storeRoot, "shared", { stream: "events" }, "dev-a", "2026-10");
      mkdirSync(dirname(copy), { recursive: true });
      appendFileSync(copy, `${JSON.stringify(forged)}\n`);
      // A private shard this user may not read.
      const hidden = appendRecord(
        a,
        { partition: "private", stream: "events", kind: "note", agent: "t", body: { text: "two" } },
        { now: at(NOW - 1000) },
      );
      chmodSync(hidden.path, 0o000);
      let codes: string[];
      try {
        codes = storeCodes();
      } finally {
        chmodSync(hidden.path, 0o600);
      }
      expect(codes).toContain(STORE_SHARD_UNREADABLE_CODE);
      expect(codes).toContain(STORE_RECORD_ID_CONFLICT_CODE);
    },
  );

  test.if(canDenyRead)(
    "one shard that cannot be read is named, and the partition's other shards are still checked",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      const a = machine("dev-a");
      const written = appendRecord(
        a,
        { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "one" } },
        { now: at(NOW - 1000) },
      );
      const body = { text: "edited" };
      const forged = { ...written.record, body, sum: bodyChecksum(body) };
      const copy = shardPath(storeRoot, "shared", { stream: "events" }, "dev-a", "2026-10");
      mkdirSync(dirname(copy), { recursive: true });
      appendFileSync(copy, `${JSON.stringify(forged)}\n`);
      // A shard of the same partition, locked by a sync client.
      const locked = appendRecord(
        a,
        { partition: "shared", stream: "log", kind: "log-event", agent: "t", body: { n: 1 } },
        { now: at(NOW - 1000) },
      );
      chmodSync(locked.path, 0o000);
      let report: ReturnType<typeof runDoctor>;
      try {
        report = runDoctor(vault, { now: new Date(NOW + 10) });
      } finally {
        chmodSync(locked.path, 0o600);
      }
      const unreadable = report.warnings.find((i) => i.code === STORE_SHARD_UNREADABLE_CODE);
      expect(unreadable?.path).toBe(locked.path);
      expect(report.warnings.map((i) => i.code)).toContain(STORE_RECORD_ID_CONFLICT_CODE);
      expect(report.warnings.map((i) => i.code)).not.toContain(STORE_PARTITION_UNREADABLE_CODE);
    },
  );

  test.if(canDenyRead)(
    "a shared shard that cannot be read stops silent-device findings, which need its retirements",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      const old = machine("dev-old");
      appendRecord(
        old,
        { partition: "private", stream: "events", kind: "note", agent: "t", body: { n: 1 } },
        { now: at(NOW - 10 * 24 * 60 * 60 * 1000) },
      );
      const locked = appendRecord(
        machine("dev-a"),
        { partition: "shared", stream: "settings", kind: "note", agent: "t", body: { n: 2 } },
        { now: at(NOW - 1000) },
      );
      expect(storeCodes()).toContain(STORE_DIGEST_SILENT_CODE);
      chmodSync(locked.path, 0o000);
      let codes: string[];
      try {
        codes = storeCodes();
      } finally {
        chmodSync(locked.path, 0o600);
      }
      expect(codes).toContain(STORE_SHARD_UNREADABLE_CODE);
      expect(codes).not.toContain(STORE_DIGEST_SILENT_CODE);
    },
  );

  test("a shard tail that has not verified for an hour is reported, a fresh one is not", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const written = appendRecord(
      machine("dev-a"),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "one" } },
      { now: at(NOW - 1000) },
    );
    // A crash mid-append left half a line with no newline.
    appendFileSync(written.path, '{"v":1,"id":"01');
    const touch = (ms: number) => utimesSync(written.path, new Date(ms), new Date(ms));
    touch(NOW - 60_000);
    expect(storeCodes()).not.toContain(STORE_SHARD_TAIL_HELD_CODE);
    touch(NOW - 2 * 60 * 60 * 1000);
    const report = runDoctor(vault, { now: new Date(NOW) });
    const held = report.warnings.find((i) => i.code === STORE_SHARD_TAIL_HELD_CODE);
    expect(held?.path).toBe(written.path);
    expect(held?.message).toContain("dev-a");
  });

  test("a healthy store with matching digests reports nothing", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const a = machine("dev-a");
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "events",
        kind: "pinned-set",
        agent: "t",
        body: { authority: "human", content: "x" },
      },
      { now: at(NOW - 1000) },
    );
    publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) });
    expect(storeCodes()).toEqual([]);
  });

  test("a fold that diverges over the same cut is reported", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const a = machine("dev-a");
    const b = machine("dev-b");
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "events",
        kind: "pinned-set",
        agent: "t",
        body: { authority: "human", content: "x" },
      },
      { now: at(NOW - 1000) },
    );
    const good = publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) });
    appendRecord(
      b,
      {
        partition: "shared",
        stream: "digests",
        kind: "state-digest",
        agent: "doctor",
        body: { ...good.body, folds: { ...good.body.folds, pinned: "0".repeat(64) } },
      },
      { now: at(NOW + 5) },
    );
    expect(storeCodes()).toEqual([STORE_DIGEST_DIVERGENT_CODE]);
  });

  test("one record id delivered with different content is reported", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const a = machine("dev-a");
    const written = appendRecord(
      a,
      {
        partition: "shared",
        stream: "events",
        kind: "note",
        agent: "t",
        body: { text: "original" },
      },
      { now: at(NOW - 1000) },
    );
    // The same id, re-delivered with an edited body (and a checksum that
    // matches the edit), as a hand-edited copy of the shard would carry.
    const body = { text: "edited" };
    const forged = { ...written.record, body, sum: bodyChecksum(body) };
    const copy = shardPath(storeRoot, "shared", { stream: "events" }, "dev-a", "2026-10");
    mkdirSync(dirname(copy), { recursive: true });
    appendFileSync(copy, `${JSON.stringify(forged)}\n`);
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const finding = report.warnings.find((i) => i.code === STORE_RECORD_ID_CONFLICT_CODE);
    expect(finding?.message).toContain(written.record.id);
  });
});

describe("what a synced peer can deliver", () => {
  test("a record id in both partitions is reported", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const a = machine("dev-a");
    const written = appendRecord(
      a,
      { partition: "private", stream: "events", kind: "note", agent: "t", body: { text: "x" } },
      { now: at(NOW - 1000) },
    );
    const copy = shardPath(storeRoot, "shared", { stream: "events" }, "dev-a", "2026-11");
    mkdirSync(dirname(copy), { recursive: true });
    appendFileSync(copy, `${JSON.stringify(written.record)}\n`);
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const finding = report.warnings.find((i) => i.code === STORE_RECORD_ID_CROSS_PARTITION_CODE);
    expect(finding?.message).toContain(written.record.id);
  });

  // A file symlink needs a privilege on Windows.
  test.skipIf(IS_WINDOWS)(
    "a shard name that is a symbolic link is reported, not passed over",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      machine("dev-a");
      const outside = join(parent, "outside.jsonl");
      writeFileSync(outside, "");
      const link = shardPath(storeRoot, "shared", { stream: "events" }, "dev-b", "2026-10");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(outside, link);
      const report = runDoctor(vault, { now: new Date(NOW + 10) });
      const finding = report.warnings.find((i) => i.code === STORE_SHARD_UNREADABLE_CODE);
      expect(finding?.path).toBe(link);
      expect(finding?.message).toContain("not a regular file");
    },
  );

  test("a shard this machine read and that is gone now is reported by its path", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    machine("dev-a");
    const shard = appendRecord(
      machine("dev-b"),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { n: 1 } },
      { now: at(NOW) },
    ).path;
    expect(storeCodes()).not.toContain(STORE_SHARD_UNREADABLE_CODE);
    // A store read of this machine saw it (the doctor itself records nothing).
    expect(readStreamRecords(storeRoot, "shared", { stream: "events" }).unreadable).toEqual([]);
    rmSync(shard);
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const found = report.warnings.filter((i) => i.code === STORE_SHARD_UNREADABLE_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(shard);
    expect(found[0]!.message).toContain("gone now");
  });

  test("a record whose blob has not arrived is not reported as an unreadable shard", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    machine("dev-a");
    appendRecord(
      machine("dev-b"),
      {
        partition: "shared",
        stream: "events",
        kind: "note",
        agent: "t",
        body: { n: 1, text: "x".repeat(20_000) },
      },
      { now: at(NOW) },
    );
    rmSync(join(storeRoot, "shared", "blobs"), { recursive: true, force: true });
    // A protection read names the shard; the doctor's shard check does not.
    expect(readStreamRecords(storeRoot, "shared", { stream: "events" }).unreadable).toHaveLength(1);
    expect(storeCodes()).not.toContain(STORE_SHARD_UNREADABLE_CODE);
  });

  test("on Windows a device folder named like a Windows device is reported, elsewhere not", () => {
    machine("dev-a");
    for (const dir of [
      join(storeRoot, "shared", "events", "nul"),
      join(storeRoot, "private", "ledgers", "continuity", "com1"),
      join(storeRoot, "shared", "events", "nul-box"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    const store = inspectStore(storeRoot)!;
    const issues = reservedDeviceDirIssues(store, "win32");
    expect(issues.map((i) => i.code)).toEqual([
      STORE_DEVICE_DIR_RESERVED_CODE,
      STORE_DEVICE_DIR_RESERVED_CODE,
    ]);
    expect(issues[0]!.message).toContain(join(storeRoot, "shared", "events", "nul"));
    expect(issues[0]!.message).not.toContain("nul-box");
    expect(issues[1]!.message).toContain(
      join(storeRoot, "private", "ledgers", "continuity", "com1"),
    );
    expect(reservedDeviceDirIssues(store, "linux")).toEqual([]);
  });
});

describe.skipIf(IS_WINDOWS)("modes of the store", () => {
  test("a shard other accounts can read is reported; the owner-only store is not", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const written = appendRecord(
      machine("dev-a"),
      { partition: "private", stream: "events", kind: "note", agent: "t", body: { text: "x" } },
      { now: at(NOW - 1000) },
    );
    expect(storeCodes()).not.toContain(STORE_MODE_LOOSE_CODE);
    chmodSync(written.path, 0o644);
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const finding = report.warnings.find((i) => i.code === STORE_MODE_LOOSE_CODE);
    expect(finding?.message).toContain(written.path);
    expect(finding?.message).toContain(`chmod -R go-rwx '${join(storeRoot, "private")}'`);
  });
});

describe("clocks ahead of now", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const write = (store: StoreHandle, ms: number) =>
    appendRecord(
      store,
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { at: ms } },
      { now: at(ms) },
    ).record;

  test("records more than the drift bound ahead are reported per device with the newest stamp", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const broken = machine("dev-broken");
    write(broken, NOW + 2 * DAY);
    const newest = write(broken, NOW + 3 * DAY);
    write(machine("dev-ok"), NOW - 1000);
    const report = runDoctor(vault, { now: new Date(NOW) });
    const finding = report.warnings.find((i) => i.code === STORE_CLOCK_AHEAD_CODE);
    expect(finding?.message).toContain("2 record(s) in the shared partition");
    expect(finding?.message).toContain(`dev-broken (2, newest ${newest.hlc}`);
    expect(finding?.message).not.toContain("dev-ok");
  });

  test("a record ahead by less than the bound is not reported", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    write(machine("dev-a"), NOW + DAY - 60_000);
    const report = runDoctor(vault, { now: new Date(NOW) });
    expect(report.warnings.map((i) => i.code)).not.toContain(STORE_CLOCK_AHEAD_CODE);
  });
});

describe("retired devices", () => {
  function retire(device: string, ms: number): void {
    appendRecord(
      machine("dev-a"),
      {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device },
      },
      { now: at(ms) },
    );
  }
  const note = (device: string, ms: number) =>
    appendRecord(
      machine(device),
      { partition: "shared", stream: "log", kind: "note", agent: "t", body: { n: ms } },
      { now: at(ms) },
    );

  test("a retired device that writes again is named, with its retirement", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    note("dev-b", NOW - 60_000);
    retire("dev-b", NOW - 30_000);
    expect(storeCodes()).not.toContain(STORE_DEVICE_RETIRED_RETURNED_CODE);
    note("dev-b", NOW - 1000);
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const finding = report.warnings.find((i) => i.code === STORE_DEVICE_RETIRED_RETURNED_CODE);
    expect(finding?.message).toContain("dev-b");
    expect(finding?.message).toContain("o2b store device retire dev-b");
  });
});

describe("removed content awaiting compaction", () => {
  test("a store with no removed content says nothing; a forgotten signal's lines are counted as awaiting compaction", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const a = machine("dev-a");
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "t",
        body: {
          id: "sig-x",
          path: "Brain/inbox/sig-x.md",
          staged: false,
          frontmatter: {},
          raw: "x",
        },
      },
      { now: at(NOW - 3000) },
    );
    expect(storeCodes()).not.toContain(STORE_REMOVED_AWAITING_COMPACTION_CODE);
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "events",
        kind: "signal-removed",
        agent: "t",
        body: { authority: "human", signal: "sig-x" },
      },
      { now: at(NOW - 2000) },
    );
    const report = runDoctor(vault, { now: new Date(NOW + 10) });
    const issue = report.warnings.find((i) => i.code === STORE_REMOVED_AWAITING_COMPACTION_CODE);
    expect(issue?.message).toContain("1 record(s) of removed content");
    expect(issue?.message).toContain("1 of forgotten signals");
  });
});
