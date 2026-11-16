/**
 * The shards this machine has seen (`seen-shards.ts`, design D14 fail
 * closed): a shard read before and gone now is named unreadable by the
 * stream reader and the partition reader, unless a compaction replaced it
 * or a human retired the device that wrote it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendDecisionLedger,
  queryDecisionLedger,
  type DecisionLedgerRow,
} from "../../../src/core/brain/permissions/ledger.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { COMPACTED_KIND, DEVICE_RETIRE_KIND } from "../../../src/core/store/constants.ts";
import { LedgerUnreadableError } from "../../../src/core/store/read/ledger-rows.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { withoutSeenRecording } from "../../../src/core/store/seen-shards.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { openStore, readStoreId } from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor, partitionDir } from "../../../src/core/store/store-paths.ts";
import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);
const OCT = Date.UTC(2026, 9, 6, 9);

function note(e: StoreEnv, device: string, at = NOV): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device }),
    {
      partition: "shared",
      stream: "events",
      kind: "note",
      agent: "t",
      body: { device },
    },
    { now: () => at },
  ).path;
}

const events = (e: StoreEnv, options = {}) =>
  readStreamRecords(e.storeRoot, "shared", { stream: "events" }, options);

function partitionUnreadable(e: StoreEnv): string[] {
  const out: string[] = [];
  readPartition(partitionDir(e.storeRoot, "shared"), {
    onUnreadable: ({ rel }) => out.push(rel),
  });
  return out;
}

describe("a shard this machine has seen", () => {
  test("gone now: the stream and partition readers name it, never read it as empty", () => {
    env = makeStoreEnv("osb-seen-gone-", { legacyTree: false });
    note(env, "dev-a");
    const peer = note(env, "dev-b");
    expect(events(env).unreadable).toEqual([]);
    rmSync(peer);
    const read = events(env);
    expect(read.unreadable).toEqual(["events/dev-b/2026-11.jsonl"]);
    expect(read.records).toHaveLength(1);
    expect(partitionUnreadable(env)).toEqual(["events/dev-b/2026-11.jsonl"]);
  });

  test("a read limited to a device or a month names only the shards it covers", () => {
    env = makeStoreEnv("osb-seen-scope-", { legacyTree: false });
    note(env, "dev-a");
    const old = note(env, "dev-b", OCT);
    events(env);
    rmSync(old);
    expect(events(env, { device: "dev-a" }).unreadable).toEqual([]);
    expect(events(env, { month: (m: string) => m === "2026-11" }).unreadable).toEqual([]);
    expect(events(env, { device: "dev-b" }).unreadable).toEqual(["events/dev-b/2026-10.jsonl"]);
  });

  test("never seen on this machine: an absent shard is just absent", () => {
    env = makeStoreEnv("osb-seen-never-", { legacyTree: false });
    const peer = note(env, "dev-b");
    rmSync(peer);
    expect(events(env).unreadable).toEqual([]);
  });

  test("a store created anew under the same root starts a fresh ledger", () => {
    env = makeStoreEnv("osb-seen-recreated-", { legacyTree: false });
    note(env, "dev-b");
    events(env);
    rmSync(env.storeRoot, { recursive: true, force: true });
    initStore({ root: env.storeRoot, partitions: ["shared", "private"] });
    expect(events(env).unreadable).toEqual([]);
  });
});

describe("a read-only surface", () => {
  test("records nothing, and still names a shard the ledger knows that is gone", () => {
    env = makeStoreEnv("osb-seen-readonly-", { legacyTree: false });
    const unseen = note(env, "dev-b");
    withoutSeenRecording(() => events(env!));
    rmSync(unseen);
    expect(events(env).unreadable).toEqual([]);
    const known = note(env, "dev-c");
    events(env);
    rmSync(known);
    expect(withoutSeenRecording(() => events(env!).unreadable)).toEqual([
      "events/dev-c/2026-11.jsonl",
    ]);
  });
});

describe("a shard removed on purpose is not reported", () => {
  test("every shard of a device a human retired", () => {
    env = makeStoreEnv("osb-seen-retired-", { legacyTree: false });
    const peer = note(env, "dev-b");
    events(env);
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_RETIRE_KIND,
      agent: "o2b",
      body: { authority: "human", device: "dev-b" },
    });
    rmSync(peer);
    expect(events(env).unreadable).toEqual([]);
    expect(partitionUnreadable(env)).toEqual([]);
  });

  test("a shard a compaction replaced", () => {
    env = makeStoreEnv("osb-seen-compacted-", { legacyTree: false });
    const old = note(env, "dev-b", OCT);
    events(env);
    appendRecord(
      openStore({ root: env.storeRoot, device: "dev-b" }),
      {
        partition: "shared",
        stream: "events",
        kind: COMPACTED_KIND,
        agent: "o2b",
        body: {
          replaces: ["events/dev-b/2026-10.jsonl"],
          into: ["events/dev-b/2026-11.jsonl"],
        },
      },
      { now: () => NOV },
    );
    rmSync(old);
    expect(events(env).unreadable).toEqual([]);
  });
});

describe("the decision ledger, an accountability ledger", () => {
  test("a shard of it gone since this machine read it throws, never reads as no decision", () => {
    env = makeStoreEnv("osb-seen-decisions-", {
      legacyTree: false,
      configureVault: false,
    });
    const row: DecisionLedgerRow = {
      ts: "2026-11-06T10:00:00Z",
      actor: "codex",
      via: "token",
      action: "write",
      target: "notes/foo.md",
      verdict: "deny",
      source: "entry:freeze-notes",
      reason: "target-scoped entry freeze-notes",
    };
    expect(appendDecisionLedger(null, row)).toEqual({ logged: true });
    expect(queryDecisionLedger(null)).toHaveLength(1);
    const ledger = join(env.storeRoot, "private", "ledgers", "permissions");
    for (const device of readdirSync(ledger)) rmSync(join(ledger, device), { recursive: true });
    expect(() => queryDecisionLedger(null)).toThrow(LedgerUnreadableError);
  });
});

describe("two processes on one machine", () => {
  test("a shard one tracks and a partition clearing the other runs both survive", async () => {
    env = makeStoreEnv("osb-seen-two-proc-", { legacyTree: false });
    const ROUNDS = 200;
    appendRecord(openStore({ root: env.storeRoot, device: "leave-0" }), {
      partition: "private",
      stream: "events",
      kind: "note",
      agent: "t",
      body: {},
    });
    const readyDir = join(env.parent, "ready");
    const goFile = join(env.parent, "go");
    const stopFile = join(env.parent, "stop");
    mkdirSync(readyDir, { recursive: true });
    const worker = join(import.meta.dir, "fixtures", "seen-ledger-worker.ts");
    const [tracker, leaver] = (["track", "leave"] as const).map((role) =>
      Bun.spawn(
        [
          process.execPath,
          worker,
          env!.storeRoot,
          role,
          String(ROUNDS),
          readyDir,
          goFile,
          stopFile,
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      ),
    ) as [Bun.Subprocess<"ignore", "pipe", "pipe">, Bun.Subprocess<"ignore", "pipe", "pipe">];
    const readyBy = Date.now() + 30_000;
    while (readdirSync(readyDir).length < 2 && Date.now() < readyBy) await Bun.sleep(5);
    writeFileSync(goFile, "go\n");
    // The pipes are drained while waiting, so a noisy worker cannot block on a full pipe.
    const errors = Promise.all([tracker, leaver].map((child) => new Response(child.stderr).text()));
    const removed = new Response(tracker.stdout).text();
    const leaverOut = new Response(leaver.stdout).text();
    const trackCode = await tracker.exited;
    writeFileSync(stopFile, "stop\n");
    const leaveCode = await leaver.exited;
    expect((await errors).filter((e) => e.trim() !== "")).toEqual([]);
    expect([trackCode, leaveCode]).toEqual([0, 0]);

    // The tracking process removed every shard right after reading it. A
    // shard the ledger held then (`kept`) must still be named gone after
    // all the clearings of the other process; one whose best-effort update
    // gave way to a busy lock (`skipped`) makes no claim. Most rounds keep
    // theirs, so the check is never empty.
    const lines = (await removed).split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(ROUNDS);
    const rounds = lines.map((line) => {
      const [state, rel, ms] = line.split(" ");
      return { kept: state === "kept", rel: rel!, ms: Number(ms) };
    });
    const kept = rounds.filter((r) => r.kept).map((r) => r.rel);
    if (kept.length < ROUNDS / 2) {
      // What a slow runner needs to say: how often the update gave way, how
      // long a skipped round took (about the lock budget: it waited; about
      // nothing: it was backed off), and how hard the other process ran.
      const skipped = rounds.filter((r) => !r.kept);
      const ms = skipped.map((r) => r.ms).toSorted((a, b) => a - b);
      throw new Error(
        `tracking kept ${kept.length} of ${ROUNDS} rounds on ${process.platform}; ` +
          `first skipped round ${rounds.findIndex((r) => !r.kept)}, skipped round ms ` +
          `min ${ms[0]} median ${ms[Math.floor(ms.length / 2)]} max ${ms.at(-1)}; ` +
          `kept round ms max ${Math.max(0, ...rounds.filter((r) => r.kept).map((r) => r.ms))}; ` +
          `${(await leaverOut).trim()}`,
      );
    }
    const gone = new Set(withoutSeenRecording(() => events(env!).unreadable));
    expect(kept.filter((rel) => !gone.has(rel))).toEqual([]);
    rmSync(join(env.storeRoot, "private", "events"), {
      recursive: true,
      force: true,
    });
    // The last clearing held: no private entry came back.
    const priv = withoutSeenRecording(
      () => readStreamRecords(env!.storeRoot, "private", { stream: "events" }).unreadable,
    );
    expect(priv).toEqual([]);
    // Rounds, not a clock, bound the workers; this only stops a hang.
  }, 300_000);
});

describe("a ledger lock a crashed process left behind", () => {
  test("costs the tracking reads of a process one bounded wait, not one per read", () => {
    env = makeStoreEnv("osb-seen-busy-", { legacyTree: false });
    note(env, "dev-a");
    events(env);
    const storeId = readStoreId(partitionDir(env.storeRoot, "shared")) as string;
    const dir = deviceStateDirFor(storeId, processDirsEnv());
    const ledger = readdirSync(dir).find(
      (n) => n.startsWith("seen-shards-") && n.endsWith(".json"),
    );
    // A fresh lock directory, as a holder that died mid-update leaves it.
    mkdirSync(join(dir, `${ledger!}.lock`));
    // The first tracking read waits out its budget once.
    note(env, "dev-b");
    expect(events(env).unreadable).toEqual([]);
    // The next eight skip without waiting. Timed apart from the first, the
    // bound separates no wait from one half-second wait per read (at least
    // four seconds) with room for a slow runner's appends and listings.
    const started = Date.now();
    for (const device of ["dev-c", "dev-d", "dev-e", "dev-f", "dev-g", "dev-h", "dev-i", "dev-j"]) {
      note(env, device);
      expect(events(env).unreadable).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

describe("a tracking update that gave way to a busy lock", () => {
  test("keeps the shard it saw, so its loss is still named", () => {
    env = makeStoreEnv("osb-seen-queued-", { legacyTree: false });
    note(env, "dev-a");
    events(env);
    const storeId = readStoreId(partitionDir(env.storeRoot, "shared")) as string;
    const dir = deviceStateDirFor(storeId, processDirsEnv());
    const ledger = readdirSync(dir).find(
      (n) => n.startsWith("seen-shards-") && n.endsWith(".json"),
    );
    // A lock directory a crashed process left: the next update gives way.
    mkdirSync(join(dir, `${ledger!}.lock`));
    const peer = note(env, "dev-b");
    expect(events(env).unreadable).toEqual([]);
    rmSync(peer);
    expect(events(env).unreadable).toEqual(["events/dev-b/" + peer.split(/[\\/]/).at(-1)]);
  });

  test("stays queued in this process: the ledger file another process reads does not hold it yet", () => {
    env = makeStoreEnv("osb-seen-queued-file-", { legacyTree: false });
    note(env, "dev-a");
    events(env);
    const storeId = readStoreId(partitionDir(env.storeRoot, "shared")) as string;
    const dir = deviceStateDirFor(storeId, processDirsEnv());
    const ledger = readdirSync(dir).find(
      (n) => n.startsWith("seen-shards-") && n.endsWith(".json"),
    );
    mkdirSync(join(dir, `${ledger!}.lock`));
    const peer = note(env, "dev-b");
    events(env);
    rmSync(peer);
    const rel = "events/dev-b/" + peer.split(/[\\/]/).at(-1);
    // This process names the shard from its queue...
    expect(withoutSeenRecording(() => events(env!).unreadable)).toEqual([rel]);
    // ...but the file holds only what an update wrote, so a process that
    // ends before its next update leaves no claim another one can check.
    const file = JSON.parse(readFileSync(join(dir, ledger!), "utf8")) as {
      shards: { shared: string[] };
    };
    expect(file.shards.shared).not.toContain(rel);
  });
});
