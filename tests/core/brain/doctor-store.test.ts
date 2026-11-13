/**
 * The doctor's brain store section (task 1.11): silent while the store is
 * not in use, and when it is, the dual-write counters, state-digest
 * findings and same-id conflicts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { nextCommandField } from "../../../src/core/brain/next-step.ts";
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
  STORE_WRITE_FAIL_OPEN_CODE,
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
import {
  STORE_SHARD_BLOB_PENDING_CODE,
  STORE_SHARD_CORRUPT_LINE_CODE,
  STORE_SHARD_LINE_TOO_LONG_CODE,
  STORE_SHARD_NEWER_FORMAT_CODE,
  storeGapFindings,
} from "../../../src/core/brain/doctor/store-gap-check.ts";
import type { DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import {
  lineSha256At,
  QUARANTINE_HASH_CAP_BYTES,
} from "../../../src/core/store/shard-quarantine.ts";
import { ledgerRowRecord } from "../../../src/core/store/dual-write-records.ts";
import { routeWrite } from "../../../src/core/store/store-write.ts";
import { SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { dualWriteStatusPath, shardPath } from "../../../src/core/store/store-paths.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
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

/** Run the gap findings over one shard named as read only in part. */
function gapFindingsOf(rel: string): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  storeGapFindings(inspectStore(storeRoot)!, [{ partition: "shared", rel }], NOW + 10, out);
  return out;
}

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
    expect(finding?.message).toContain("o2b store partition leave private");
    expect(storeCodes()).toEqual([STORE_PARTITION_LOST_CODE]);
  });

  test("below local reach a lost partition is still an error but never names private", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    ensureStore(storeRoot);
    openStore({ root: storeRoot, device: "dev-a" });
    rmSync(join(storeRoot, "private", "store.json"));
    const lostOf = (opts: { withholdsPrivate?: true; reach?: "remote" }) =>
      runDoctor(vault, { now: new Date(NOW), ...opts }).errors.filter(
        (i) => i.code === STORE_PARTITION_LOST_CODE,
      );
    for (const opts of [{ withholdsPrivate: true } as const, { reach: "remote" } as const]) {
      const lost = lostOf(opts);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.message).toContain("a partition of the brain store");
      expect(lost[0]!.message).not.toContain("private");
    }
    rmSync(join(storeRoot, "shared", "store.json"));
    expect(lostOf({})[0]!.message).toContain("private/store.json");
    const both = lostOf({ withholdsPrivate: true });
    expect(both).toHaveLength(1);
    expect(both[0]!.message).toContain("the shared partition and another partition");
    expect(both[0]!.message).not.toContain("private");
  });

  test("below local reach a store that does not open keeps its finding without the cause", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    ensureStore(storeRoot);
    openStore({ root: storeRoot, device: "dev-a" });
    const privateIdentity = join(storeRoot, "private", "store.json");
    const sharedId = (
      JSON.parse(readFileSync(join(storeRoot, "shared", "store.json"), "utf8")) as {
        store_id: string;
      }
    ).store_id;
    const otherId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const invalidOf = (opts: { withholdsPrivate?: true; reach?: "remote" }) =>
      runDoctor(vault, { now: new Date(NOW), ...opts }).warnings.filter(
        (i) => i.code === STORE_ROOT_INVALID_CODE,
      );
    const original = readFileSync(privateIdentity, "utf8");
    for (const broken of ["{ not json", original.replace(sharedId, otherId)]) {
      writeFileSync(privateIdentity, broken);
      const local = invalidOf({});
      expect(local).toHaveLength(1);
      expect(local[0]!.message).toContain("private");
      for (const opts of [{ withholdsPrivate: true } as const, { reach: "remote" } as const]) {
        const remote = invalidOf(opts);
        expect(remote).toHaveLength(1);
        expect(remote[0]!.path).toBe(local[0]!.path);
        expect(remote[0]!.message).toContain("could not be opened");
        expect(remote[0]!.message).not.toContain("private");
        expect(remote[0]!.message).not.toContain(sharedId);
        expect(remote[0]!.message).not.toContain(otherId);
      }
    }
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

describe("shards read only in part", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Three notes of dev-b in one shard, written at `when`; returns its path. */
  function threeNotes(when = NOW): string {
    machine("dev-a");
    const b = machine("dev-b");
    let path = "";
    for (const n of [1, 2, 3]) {
      path = appendRecord(
        b,
        { partition: "shared", stream: "events", kind: "note", agent: "t", body: { n } },
        { now: at(when) },
      ).path;
    }
    return path;
  }

  /** Rewrite the middle line of the shard at `path`; returns its offset. */
  function editMiddle(path: string, edit: (line: string) => string): number {
    const lines = readFileSync(path, "utf8").split("\n");
    lines[1] = edit(lines[1]!);
    writeFileSync(path, lines.join("\n"));
    return Buffer.byteLength(lines[0]!) + 1;
  }

  const relOf = (path: string): string =>
    path
      .slice(join(storeRoot, "shared").length + 1)
      .split("\\")
      .join("/");

  function findings(code: string, now = NOW + 10) {
    const report = runDoctor(vault, { now: new Date(now) });
    return {
      errors: report.errors.filter((i) => i.code === code),
      warnings: report.warnings.filter((i) => i.code === code),
    };
  }

  test("a corrupt middle line is an error naming the offset and the quarantine command", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = threeNotes();
    const offset = editMiddle(path, (line) => line.replace('"n":2', '"n":20'));
    const { errors } = findings(STORE_SHARD_CORRUPT_LINE_CODE);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(`shared/${relOf(path)}`);
    expect(errors[0]!.message).toContain(`byte ${offset}`);
    expect(errors[0]!.message).toContain(
      `o2b store shard quarantine shared/${relOf(path)} --offset ${offset}`,
    );
  });

  test("a corrupt line too long to hash names source repair, no quarantine command", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = threeNotes();
    // Past the hash cap the verb always refuses (`line-too-long`).
    const offset = editMiddle(path, () => "x".repeat(QUARANTINE_HASH_CAP_BYTES + 10));
    expect(findings(STORE_SHARD_CORRUPT_LINE_CODE).errors).toEqual([]);
    const { errors } = findings(STORE_SHARD_LINE_TOO_LONG_CODE);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(`shared/${relOf(path)}`);
    expect(errors[0]!.message).toContain(`byte ${offset}`);
    expect(errors[0]!.message).toContain("repair or remove it at its source");
    expect(errors[0]!.message).not.toContain("o2b store shard quarantine");
    expect(nextCommandField(errors[0]!.code)).toEqual({});
  });

  test("a newer-format line is a warning to upgrade, with no command", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = threeNotes();
    editMiddle(path, (line) => line.replace('"v":1', '"v":99'));
    const { warnings, errors } = findings(STORE_SHARD_NEWER_FORMAT_CODE);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("upgrade Open Second Brain");
    expect(warnings[0]!.message).not.toContain("o2b store shard quarantine");
  });

  /** A dev-b record in `stream` whose blob has not arrived, written at `when`. */
  function pendingBlob(stream: "events" | "settings", when: number): string {
    machine("dev-a");
    const path = appendRecord(
      machine("dev-b"),
      stream === "events"
        ? {
            partition: "shared",
            stream,
            kind: "note",
            agent: "t",
            body: { n: 1, text: "x".repeat(20_000) },
          }
        : {
            partition: "shared",
            stream,
            kind: SETTING_SET_KIND,
            agent: "t",
            body: { authority: "human", key: "brain.x.y", value: "x".repeat(20_000) },
          },
      { now: at(when) },
    ).path;
    rmSync(join(storeRoot, "shared", "blobs"), { recursive: true, force: true });
    return path;
  }

  test("a young pending blob is a warning with no command, an old one an error with it", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = pendingBlob("events", NOW - DAY);
    const young = findings(STORE_SHARD_BLOB_PENDING_CODE);
    expect(young.errors).toEqual([]);
    expect(young.warnings).toHaveLength(1);
    expect(young.warnings[0]!.message).not.toContain("o2b store shard quarantine");
    const old = findings(STORE_SHARD_BLOB_PENDING_CODE, NOW + 8 * DAY);
    expect(old.warnings).toEqual([]);
    expect(old.errors).toHaveLength(1);
    expect(old.errors[0]!.message).toContain(
      `o2b store shard quarantine shared/${relOf(path)} --offset 0`,
    );
  });

  test("an old pending blob in a settings shard names no command", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    pendingBlob("settings", NOW - DAY);
    const { errors } = findings(STORE_SHARD_BLOB_PENDING_CODE, NOW + 8 * DAY);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).not.toContain("o2b store shard quarantine");
  });

  // A clock stamp that verifies but names no instant a date can hold.
  const UNREADABLE_HLC = `"hlc":"${Number.MAX_SAFE_INTEGER}.0"`;

  test("a pending blob whose clock stamp does not parse says so and offers no quarantine by age", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = pendingBlob("events", NOW - 8 * DAY);
    const lines = readFileSync(path, "utf8").split("\n");
    lines[0] = lines[0]!.replace(/"hlc":"[^"]*"/, UNREADABLE_HLC);
    writeFileSync(path, lines.join("\n"));
    for (const now of [NOW + 10, NOW + 30 * DAY]) {
      const { errors, warnings } = findings(STORE_SHARD_BLOB_PENDING_CODE, now);
      expect(warnings).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("its clock stamp does not parse");
      expect(errors[0]!.message).not.toContain("has not arrived since");
      expect(errors[0]!.message).not.toContain("o2b store shard quarantine");
    }
  });

  test("a shard gone since the partition read is skipped, not thrown", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const path = threeNotes();
    const rel = relOf(path);
    rmSync(path);
    expect(gapFindingsOf(rel).issues).toEqual([]);
  });

  test.skipIf(IS_WINDOWS)(
    "a shard swapped for a link is an error with no quarantine command",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      const path = threeNotes();
      const aside = join(parent, "aside.jsonl");
      writeFileSync(aside, readFileSync(path));
      rmSync(path);
      symlinkSync(aside, path);
      const { issues } = gapFindingsOf(relOf(path));
      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe(STORE_SHARD_UNREADABLE_CODE);
      expect(issues[0]!.message).toContain("could not be read");
      expect(issues[0]!.message).not.toContain("o2b store shard quarantine");
      // The next step the doctor attaches by code names no command either.
      expect(nextCommandField(issues[0]!.code)).toEqual({});
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a shard that fails the second read for another reason than its removal is named with the error code",
    () => {
      process.env[STORE_ROOT_ENV] = storeRoot;
      const path = threeNotes();
      chmodSync(path, 0o000);
      try {
        const { issues } = gapFindingsOf(relOf(path));
        expect(issues).toHaveLength(1);
        expect(issues[0]!.severity).toBe("error");
        expect(issues[0]!.code).toBe(STORE_SHARD_UNREADABLE_CODE);
        expect(issues[0]!.path).toBe(`shared/${relOf(path)}`);
        expect(issues[0]!.message).toContain("EACCES");
        expect(nextCommandField(issues[0]!.code)).toEqual({});
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  test("below local reach no store finding names the private partition, and the counts are those of a store without it", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    threeNotes();
    const doctor = (opts: { withholdsPrivate?: true; reach?: "remote" } = {}) =>
      runDoctor(vault, { now: new Date(NOW + 10), ...opts });
    const before = doctor();
    // A private shard with a clock far ahead and a corrupt middle line: a
    // clock-ahead warning and a corrupt-line error, both naming `private`.
    const b = machine("dev-b");
    let path = "";
    for (const n of [1, 2, 3]) {
      path = appendRecord(
        b,
        { partition: "private", stream: "events", kind: "note", agent: "t", body: { n } },
        { now: at(NOW + 30 * DAY) },
      ).path;
    }
    editMiddle(path, (line) => line.replace('"n":2', '"n":20'));
    const local = doctor();
    const named = (r: typeof local) =>
      [...r.errors, ...r.warnings].filter(
        (i) => (i.path ?? "").includes("private") || i.message.includes("private"),
      );
    expect(named(local).map((i) => i.code)).toEqual(
      expect.arrayContaining([STORE_SHARD_CORRUPT_LINE_CODE, STORE_CLOCK_AHEAD_CODE]),
    );
    for (const remote of [doctor({ withholdsPrivate: true }), doctor({ reach: "remote" })]) {
      expect(named(remote)).toEqual([]);
      expect(remote.errors.length).toBe(before.errors.length);
      expect(remote.warnings.length).toBe(before.warnings.length);
      expect(remote.trust_verdict).toEqual(before.trust_verdict);
    }
  });

  test("a torn line and a quarantined line give no finding", () => {
    process.env[STORE_ROOT_ENV] = storeRoot;
    const torn = threeNotes();
    editMiddle(torn, (line) => line.slice(0, Math.floor(line.length / 2)));
    expect(findings(STORE_SHARD_CORRUPT_LINE_CODE).errors).toEqual([]);
    const offset = editMiddle(torn, () =>
      readFileSync(torn, "utf8").split("\n")[0]!.replace('"n":1', '"n":10'),
    );
    expect(findings(STORE_SHARD_CORRUPT_LINE_CODE).errors).toHaveLength(1);
    addQuarantine(storeRoot, {
      partition: "shared",
      shard: relOf(torn),
      offset,
      sha256: lineSha256At(torn, offset, join(storeRoot, "shared"))!,
      kind: "corrupt-line",
      reason: "test",
    });
    expect(findings(STORE_SHARD_CORRUPT_LINE_CODE).errors).toEqual([]);
  });
});

describe("failed writes below local reach", () => {
  /** Make `<partition>/ledgers` a file, so every ledger-row append there fails naming its path. */
  function blockAppends(partition: "shared" | "private"): string {
    const blocked = join(storeRoot, partition, "ledgers");
    writeFileSync(blocked, "not a folder\n");
    return blocked;
  }

  /** One dual write (the vault keeps its legacy tree) and one fail-open store-only write. */
  function writeRow(partition: "shared" | "private"): void {
    const store = () => ledgerRowRecord("metrics", { n: 1 }, partition);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      routeWrite({ legacy: () => null, store, context: { vault } });
      routeWrite({ legacy: () => null, store, context: { vault: null }, failOpen: true });
    } finally {
      quiet.mockRestore();
    }
  }

  const CODES = [STORE_DUAL_WRITE_FAILURES_CODE, STORE_WRITE_FAIL_OPEN_CODE];
  const failuresOf = (opts: { withholdsPrivate?: true; reach?: "remote" } = {}) =>
    runDoctor(vault, { now: new Date(NOW), ...opts }).warnings.filter((i) =>
      CODES.includes(i.code),
    );

  test("a failed private write shows nothing below local reach; a failed shared one still shows", () => {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    process.env[STORE_ROOT_ENV] = storeRoot;
    process.env["O2B_DEVICE_ID"] = "dev-a";
    ensureStore(storeRoot);
    const blocked = blockAppends("private");
    writeRow("private");
    const local = failuresOf();
    expect(local.map((i) => i.code).toSorted()).toEqual(CODES.toSorted());
    // The error text names the private folder the append could not use.
    expect(local.every((i) => i.message.includes(blocked))).toBe(true);
    for (const opts of [{ withholdsPrivate: true } as const, { reach: "remote" } as const]) {
      expect(failuresOf(opts)).toEqual([]);
    }

    const sharedBlocked = blockAppends("shared");
    writeRow("shared");
    for (const opts of [{ withholdsPrivate: true } as const, { reach: "remote" } as const]) {
      const remote = failuresOf(opts);
      expect(remote.map((i) => i.code).toSorted()).toEqual(CODES.toSorted());
      for (const issue of remote) {
        expect(issue.message.startsWith("1 ")).toBe(true);
        expect(issue.message).toContain("to the shared partition");
        expect(issue.message).toContain(sharedBlocked);
        expect(issue.message).not.toContain(blocked);
        expect(issue.message).not.toContain("private");
      }
    }
    // The operator's own doctor still counts both.
    expect(failuresOf().every((i) => i.message.startsWith("2 "))).toBe(true);
  });
});
