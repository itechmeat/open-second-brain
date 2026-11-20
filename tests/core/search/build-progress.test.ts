/**
 * The progress a rebuild records beside the index, and the words the
 * readers that answer while it runs use for it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProgressPath,
  describeIndexBuild,
  IndexBuildRecorder,
  enterStagingRead,
  readIndexBuild,
  sweepStagingClaims,
  waitForStagingReaders,
} from "../../../src/core/search/build-progress.ts";
import { acquireWriterLease } from "../../../src/core/search/store/writer-lock.ts";

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osb-build-progress-"));
  dbPath = join(dir, "brain.sqlite");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a build reads as running only while its writer lock is held", async () => {
  let now = Date.parse("2026-11-20T08:00:00.000Z");
  const lease = await acquireWriterLease(dbPath);
  const recorder = new IndexBuildRecorder(dbPath, () => now);
  try {
    // Until the rebuild accepted or recreated its staging file, no read.
    expect(readIndexBuild(dbPath)?.phase).toBe("preparing");
    expect(recorder.ready()).toBe(true);
    expect(readIndexBuild(dbPath)?.phase).toBe("notes");
    now += 2000;
    recorder.store(100, 400, 90);
    expect(readIndexBuild(dbPath)).toMatchObject({
      phase: "store",
      storeBytesDone: 100,
      storeBytesTotal: 400,
      storeRecords: 90,
    });
  } finally {
    lease.release();
  }
  // A file left behind by a build whose lock is gone is no build.
  expect(existsSync(buildProgressPath(dbPath))).toBe(true);
  expect(readIndexBuild(dbPath)).toBeNull();
  recorder.end();
  expect(existsSync(buildProgressPath(dbPath))).toBe(false);
});

test("a file a killed rebuild left is no build, also under another writer's lock", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    const dead = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]).pid;
    writeFileSync(
      buildProgressPath(dbPath),
      JSON.stringify({
        pid: dead,
        token: "t0",
        startedAt: new Date().toISOString(),
        phase: "notes",
      }),
    );
    expect(readIndexBuild(dbPath)).toBeNull();
  } finally {
    lease.release();
  }
});

test("an unreadable progress file is no build", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    writeFileSync(buildProgressPath(dbPath), "{not json");
    expect(readIndexBuild(dbPath)).toBeNull();
  } finally {
    lease.release();
  }
});

test("the description names the phase, the share read and the time left", () => {
  const startedAt = "2026-11-20T08:00:00.000Z";
  const at = (min: number): number => Date.parse(startedAt) + min * 60_000;
  expect(
    describeIndexBuild(
      {
        pid: process.pid,
        token: "t0",
        startedAt,
        phase: "notes",
        storeStartedAt: null,
        storeBytesDone: 0,
        storeBytesTotal: 0,
        storeRecords: 0,
      },
      at(0.2),
    ),
  ).toBe(
    "the search index is being built (started less than a minute ago; indexing the vault's notes, the brain store comes next)",
  );
  expect(
    describeIndexBuild(
      {
        pid: process.pid,
        token: "t0",
        startedAt,
        phase: "store",
        storeStartedAt: "2026-11-20T08:01:00.000Z",
        storeBytesDone: 250,
        storeBytesTotal: 1000,
        storeRecords: 94_000,
      },
      at(2),
    ),
  ).toBe(
    "the search index is being built (started about 2 minutes ago; " +
      "25% of the brain store read, 94,000 records indexed; about 3 minutes to go)",
  );
});

test("a barrier that cannot be published reports it, so the build does not swap", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    const recorder = new IndexBuildRecorder(dbPath);
    expect(recorder.finish()).toBe(true);
    expect(readIndexBuild(dbPath)?.phase).toBe("finishing");
    // A directory where the progress file goes: it can be neither written nor removed.
    rmSync(buildProgressPath(dbPath));
    mkdirSync(buildProgressPath(dbPath));
    expect(new IndexBuildRecorder(dbPath).finish()).toBe(false);
  } finally {
    lease.release();
  }
});

test("a build start sweeps the claims of searches that died while reading", () => {
  const dead = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]).pid;
  const deadClaim = `brain.sqlite.building.reader-${dead}-0a1b2c3d`;
  const liveClaim = `brain.sqlite.building.reader-${process.pid}-0a1b2c3d`;
  writeFileSync(join(dir, deadClaim), String(dead));
  writeFileSync(join(dir, liveClaim), String(process.pid));
  sweepStagingClaims(dbPath);
  expect(readdirSync(dir).filter((n) => n.includes(".building.reader-"))).toEqual([liveClaim]);
});

test("a rebuild that lost its lease never removes or overwrites the record of the one that took over", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    const stale = new IndexBuildRecorder(dbPath);
    // Another rebuild took the lock over and published its own record.
    const active = new IndexBuildRecorder(dbPath);
    active.store(10, 100, 7);
    const theirs = readFileSync(buildProgressPath(dbPath), "utf8");
    // The stale one goes on: its progress writes, its barrier and its
    // cleanup all leave the active record alone.
    stale.store(90, 100, 900);
    stale.store(95, 100, 950);
    expect(stale.finish()).toBe(false);
    stale.end();
    expect(readFileSync(buildProgressPath(dbPath), "utf8")).toBe(theirs);
    expect(readIndexBuild(dbPath)?.storeRecords).toBe(7);
    // The active rebuild's own end still removes it.
    active.end();
    expect(existsSync(buildProgressPath(dbPath))).toBe(false);
  } finally {
    lease.release();
  }
});

test("a rebuild that lost its lease publishes nothing after the successor ended", async () => {
  let held = true;
  const lease = await acquireWriterLease(dbPath);
  try {
    const stale = new IndexBuildRecorder(dbPath, Date.now, () => held);
    // Its lease is taken over; the successor publishes, then ends and
    // removes its record.
    held = false;
    const successor = new IndexBuildRecorder(dbPath);
    successor.store(10, 100, 7);
    successor.end();
    expect(existsSync(buildProgressPath(dbPath))).toBe(false);
    // The stale rebuild resumes: an absent record is not its to fill.
    stale.store(50, 100, 500);
    stale.store(60, 100, 600);
    expect(stale.finish()).toBe(false);
    stale.end();
    expect(existsSync(buildProgressPath(dbPath))).toBe(false);
  } finally {
    lease.release();
  }
});

test("a recorder whose lease is gone from the start publishes nothing", () => {
  const recorder = new IndexBuildRecorder(dbPath, Date.now, () => false);
  recorder.store(1, 2, 3);
  expect(recorder.finish()).toBe(false);
  expect(existsSync(buildProgressPath(dbPath))).toBe(false);
});

test("a first publication that failed is retried while the lease is held, over a dead build's record", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    // The first write fails: a directory stands where the record goes.
    mkdirSync(buildProgressPath(dbPath));
    const recorder = new IndexBuildRecorder(dbPath);
    rmSync(buildProgressPath(dbPath), { recursive: true });
    // A record a dead build left is there by the time the disk recovers.
    const dead = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]).pid;
    writeFileSync(
      buildProgressPath(dbPath),
      JSON.stringify({
        pid: dead,
        token: "t0",
        startedAt: new Date().toISOString(),
        phase: "store",
      }),
    );
    expect(recorder.ready()).toBe(true);
    expect(readIndexBuild(dbPath)).toMatchObject({ pid: process.pid, phase: "notes" });
    expect(recorder.finish()).toBe(true);
  } finally {
    lease.release();
  }
});

test("no search claims the staging file while the rebuild prepares it", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    const recorder = new IndexBuildRecorder(dbPath);
    expect(enterStagingRead(dbPath)).toBeNull();
    recorder.ready();
    const ticket = enterStagingRead(dbPath);
    expect(ticket).not.toBeNull();
    ticket?.release();
  } finally {
    lease.release();
  }
});

test("a claim whose removal failed stays retryable, and one already gone counts as released", async () => {
  const lease = await acquireWriterLease(dbPath);
  try {
    new IndexBuildRecorder(dbPath).ready();
    const ticket = enterStagingRead(dbPath)!;
    const claim = readdirSync(dir).find((n) => n.includes(".building.reader-"))!;
    // The removal fails: a directory stands where the claim file was.
    rmSync(join(dir, claim));
    mkdirSync(join(dir, claim));
    ticket.release();
    expect(existsSync(join(dir, claim))).toBe(true);
    expect(await waitForStagingReaders(dbPath, 50)).toBe("readers");
    // Once removable again, the next release removes it.
    rmSync(join(dir, claim), { recursive: true });
    writeFileSync(join(dir, claim), String(process.pid));
    ticket.release();
    expect(existsSync(join(dir, claim))).toBe(false);
    expect(await waitForStagingReaders(dbPath, 50)).toBe("drained");
    // A claim someone else removed already is released without a word.
    const gone = enterStagingRead(dbPath)!;
    for (const n of readdirSync(dir)) if (n.includes(".building.reader-")) rmSync(join(dir, n));
    gone.release();
    expect(await waitForStagingReaders(dbPath, 50)).toBe("drained");
  } finally {
    lease.release();
  }
});

test("a claim list that cannot be read is not a drained one", async () => {
  expect(await waitForStagingReaders(join(dir, "absent", "brain.sqlite"), 60)).toBe("unknown");
  expect(await waitForStagingReaders(dbPath, 60)).toBe("drained");
});
