/**
 * The dream day check (design D2, spec "The check at session entry is
 * nearly free on a closed day", "A due pass is started once, detached",
 * "Automatic dream can be turned off, and needs an owner"). The spawn goes
 * through the spawn helper's seam (`spawnSelfDetached`), spied and never
 * run; the clock is injected.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import * as claim from "../../../../src/core/brain/dream-trigger/claim.ts";
import * as config from "../../../../src/core/config.ts";
import * as gate from "../../../../src/core/brain/dream-owner/gate.ts";
import { dreamDayCheck } from "../../../../src/core/brain/dream-trigger/check.ts";
import { dreamWorkerLogPath } from "../../../../src/core/brain/dream-trigger/due.ts";
import { DREAM_TRIGGER_CLAIM_GRACE_MS } from "../../../../src/core/brain/dream-trigger/constants.ts";
import * as record from "../../../../src/core/brain/dream-trigger/record.ts";
import {
  dreamTriggerClaimPath,
  emptyDreamTriggerRecord,
  writeDreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";
import { DREAM_RUN_ENV } from "../../../../src/core/brain/dream-queue/dream-session.ts";
import { readDreamAuto } from "../../../../src/core/brain/dream-trigger/auto.ts";
import { holdDreamRunClaim } from "../../../../src/core/brain/dream-trigger/outcome.ts";
import * as localLock from "../../../../src/core/store/local-lock.ts";
import * as o2bCommand from "../../../../src/core/maintenance/o2b-command.ts";
import * as streamRead from "../../../../src/core/store/read/stream-read.ts";
import * as storeOpen from "../../../../src/core/store/store-open.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { defaultStoreRoot } from "../../../../src/core/store/store-paths.ts";
import { CHMOD_CANNOT_DENY, homeEnv } from "../../../helpers/platform.ts";
import { startDreamPassHolder } from "../../../helpers/dream-pass-holder.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../../helpers/cli-timeout.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { makeTriggerFixture, type TriggerFixture } from "./fixture.ts";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const TODAY = "2026-11-20";
const clock = (): number => NOW;
const HOUR = 3_600_000;
const GRACE = 600_000 + DREAM_TRIGGER_CLAIM_GRACE_MS;

let f: TriggerFixture;
let spawns: Array<ReadonlyArray<string>>;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // The default layout of a machine with a vault: the store in the vault's
  // folder and no store root named anywhere (the 2.0.5 trigger missed it).
  f = makeTriggerFixture({ layout: "vault" });
  spawns = [];
  spawnSpy = spyOn(o2bCommand, "spawnSelfDetached").mockImplementation(((
    argv: ReadonlyArray<string>,
  ) => {
    spawns.push([...argv]);
    return { pid: 0 };
  }) as typeof o2bCommand.spawnSelfDetached);
});

afterEach(() => {
  spawnSpy.mockRestore();
  f.cleanup();
});

function run(options: Parameters<typeof dreamDayCheck>[1] = {}) {
  return dreamDayCheck(f.config(), { now: clock, ...options });
}

function seed(over: Partial<record.DreamTriggerRecord>): void {
  writeDreamTriggerRecord(f.recordPath, { ...emptyDreamTriggerRecord(f.storeRoot), ...over });
}

/** Run the check counting store opens, config reads and record reads. */
function counted(fn: () => unknown): { opens: number; configReads: number; recordReads: number } {
  const loaded = f.config();
  const opens = spyOn(storeOpen, "openStore");
  const reads = spyOn(config, "discoverConfig");
  const recordReads = spyOn(record, "readDreamTriggerRecord");
  try {
    dreamDayCheck(loaded, { now: clock });
    fn();
    return {
      opens: opens.mock.calls.length,
      configReads: reads.mock.calls.length,
      recordReads: recordReads.mock.calls.length,
    };
  } finally {
    opens.mockRestore();
    reads.mockRestore();
    recordReads.mockRestore();
  }
}

const MINE = { device: "dev-a", agent: "claude", revision: null, mine: true };

describe("the closed-day path", () => {
  const CASES: ReadonlyArray<[string, Partial<record.DreamTriggerRecord>]> = [
    ["a day closed today", { closed: true, day: TODAY, owner: MINE }],
    ["a day closed ahead of the clock", { closed: true, day: "2026-11-21", owner: MINE }],
    ["a retry time still to come", { retry_at: new Date(NOW + HOUR).toISOString(), owner: MINE }],
    ["automatic dream off, read today", { auto: false, owner: MINE, owner_checked_day: TODAY }],
    [
      "a device that is not the owner, read today",
      { owner: { ...MINE, device: "dev-b", mine: false }, owner_checked_day: TODAY },
    ],
  ];
  for (const [name, over] of CASES) {
    test(`${name}: one record read, no store, no config read, nothing started`, () => {
      seed(over);
      const counts = counted(() => {});
      expect(counts).toEqual({ opens: 0, configReads: 0, recordReads: 1 });
      expect(spawns).toEqual([]);
      expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    });
  }
});

describe("the due path", () => {
  test("the first check of a day folds the owner and starts one worker", () => {
    const result = run();
    expect(result.started).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.slice(-4)).toEqual(["dream", "run", "--claim", expect.any(String)]);
    const token = spawns[0]!.at(-1)!;
    const written = JSON.parse(readFileSync(dreamTriggerClaimPath(f.recordPath), "utf8"));
    expect(written.token).toBe(token);
    const r = f.record()!;
    expect(r.owner).toMatchObject({ device: "dev-a", mine: true });
    expect(r.owner_checked_day).toBe(TODAY);
    expect(r.auto).toBe(true);
    expect(r.last_run).toMatchObject({ started_at: new Date(NOW).toISOString(), by: "worker" });
    // The claim stands: the next check starts nothing.
    expect(run().started).toBe(false);
    expect(spawns).toHaveLength(1);
  });

  test("a served vault reaches the owner check and the worker", () => {
    const served = join(f.tmp, "served-vault");
    const opened = spyOn(gate, "openDreamOwnerStore");
    try {
      expect(run({ vault: served }).started).toBe(true);
      expect(opened.mock.calls[0]![0]).toBe(served);
    } finally {
      opened.mockRestore();
    }
    expect(spawns[0]!.slice(-6)).toEqual([
      "dream",
      "run",
      "--vault",
      served,
      "--claim",
      expect.any(String),
    ]);
  });

  test("a check that served no vault starts a worker that runs on no vault", () => {
    expect(run({ vault: null }).started).toBe(true);
    expect(spawns[0]!.slice(-5)).toEqual([
      "dream",
      "run",
      "--no-vault",
      "--claim",
      expect.any(String),
    ]);
  });

  test("a vault still in the legacy tree is not cached as the answer for another vault", () => {
    const legacy = join(f.tmp, "legacy-vault");
    const original = gate.openDreamOwnerStore;
    const opened = spyOn(gate, "openDreamOwnerStore").mockImplementation((vault, configPath) =>
      vault === legacy ? { store: null, reason: "legacy-tree" } : original(vault, configPath),
    );
    try {
      expect(run({ vault: legacy }).started).toBe(false);
      // The next check, for a vault served from the store, reaches its owner check.
      expect(run({ vault: join(f.tmp, "served-vault") }).started).toBe(true);
    } finally {
      opened.mockRestore();
    }
    expect(spawns).toHaveLength(1);
  });

  test("a retry time further ahead than the longest delay was written under a clock ahead", () => {
    seed({ retry_at: new Date(NOW + 30 * HOUR).toISOString(), owner: MINE });
    expect(run().started).toBe(true);
    expect(spawns).toHaveLength(1);
  });

  test("a day closed ahead of the clock while the check took its claim gives the claim back", () => {
    const original = claim.createClaim;
    const spy = spyOn(claim, "createClaim").mockImplementation((path, at) => {
      const token = original(path, at);
      writeDreamTriggerRecord(f.recordPath, {
        ...(f.record() ?? emptyDreamTriggerRecord(f.storeRoot)),
        closed: true,
        day: "2026-11-21",
      });
      return token;
    });
    try {
      expect(run().started).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
  });

  test("the worker gets the config path and the live environment", () => {
    run({ env: { ...process.env, MARK_X: "1" } });
    const opts = spawnSpy.mock.calls[0]![1] as { env: Record<string, string> };
    expect(opts.env["OPEN_SECOND_BRAIN_CONFIG"]).toBe(f.configPath);
    expect(opts.env["MARK_X"]).toBe("1");
    // A copy of the environment keeps each name as the OS spelled it
    // (`Path` on Windows, where the OS matches names without case): the
    // worker gets exactly one search path, the live one.
    const pathKeys = Object.keys(opts.env).filter((k) => k.toUpperCase() === "PATH");
    expect(pathKeys).toHaveLength(1);
    expect(opts.env[pathKeys[0]!]).toBe(process.env["PATH"]);
  });

  test("the record lives under the state root of the caller's environment", () => {
    const other = join(f.tmp, "other-state");
    const env = { ...process.env, XDG_STATE_HOME: other, LOCALAPPDATA: other };
    expect(run({ env }).started).toBe(true);
    const path = record.dreamTriggerRecordPath(f.storeRoot, env);
    expect(path.startsWith(other)).toBe(true);
    expect(record.readDreamTriggerRecord(path, f.storeRoot)?.owner).toMatchObject({ mine: true });
    expect(existsSync(dreamTriggerClaimPath(path))).toBe(true);
    // Nothing under the state root of this process's own environment.
    expect(existsSync(f.recordPath)).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
  });

  test("a day a pass closed while the check took its claim gives the claim back", () => {
    const original = claim.createClaim;
    const spy = spyOn(claim, "createClaim").mockImplementation((path, at) => {
      const token = original(path, at);
      // Another pass closed the day between the fast path's read and the claim.
      writeDreamTriggerRecord(f.recordPath, {
        ...(f.record() ?? emptyDreamTriggerRecord(f.storeRoot)),
        closed: true,
        day: TODAY,
      });
      return token;
    });
    try {
      expect(run().started).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
  });

  test("a retry time a pass wrote while the check took its claim gives the claim back", () => {
    const original = claim.createClaim;
    const spy = spyOn(claim, "createClaim").mockImplementation((path, at) => {
      const token = original(path, at);
      // A failed pass set its retry time between the fast path's read and the claim.
      writeDreamTriggerRecord(f.recordPath, {
        ...(f.record() ?? emptyDreamTriggerRecord(f.storeRoot)),
        closed: false,
        retry_at: new Date(NOW + HOUR).toISOString(),
      });
      return token;
    });
    try {
      expect(run().started).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
  });

  test("a pass running here starts nothing", async () => {
    const until = join(f.tmp, "release");
    const holder = await startDreamPassHolder(f.store("dev-a"), 60_000, until);
    try {
      expect(run().started).toBe(false);
    } finally {
      writeFileSync(until, "");
      await holder.exited;
    }
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
  });

  test("a brain with no owner is never started, and the answer is kept for the day", () => {
    f.cleanup();
    f = makeTriggerFixture({ owner: null });
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()).toMatchObject({
      owner: { device: null, mine: false },
      owner_checked_day: TODAY,
    });
    expect(counted(() => {}).opens).toBe(0);
  });

  test("automatic dream off in the shared setting starts nothing", () => {
    f.setAuto(false);
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()).toMatchObject({ auto: false, owner_checked_day: TODAY });
  });

  test("dream.auto is read from the whole settings fold, as every reader folds it", () => {
    f.setAuto(false);
    const original = streamRead.readStreamRecords;
    const read = spyOn(streamRead, "readStreamRecords").mockImplementation((root, partition, o) => {
      const got = original(root, partition, o);
      if (o?.stream !== "settings") return got;
      // A second delivery of the same record id naming another setting:
      // the fold keeps one version per id, and this one sorts first, so
      // the shared fold has no value for dream.auto (its default, on).
      const other = got.records.map((r) => ({
        ...r,
        body: { authority: "human", key: "dream.apply_drafts", value: "auto" },
      }));
      return { ...got, records: [...got.records, ...other] };
    });
    try {
      expect(readDreamAuto(f.storeRoot)).toBe(true);
    } finally {
      read.mockRestore();
    }
  });

  test("a device that is not the owner starts nothing", () => {
    process.env["O2B_DEVICE_ID"] = "dev-b";
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()?.owner).toMatchObject({ device: "dev-a", mine: false });
  });
});

/**
 * A claim made at `at`, by default by a maker that still lives (this
 * process: a long-lived MCP server). Not pid 1: it is a live process on
 * POSIX and none on Windows, where a claim no worker proved, whose maker
 * is gone, is abandoned instead.
 */
function writeClaim(at: number, pids: { pid?: number; worker_pid?: number } = {}): void {
  writeFileSync(
    dreamTriggerClaimPath(f.recordPath),
    JSON.stringify({ token: "t0", at, pid: process.pid, ...pids }),
  );
}

/** The pid of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, ...homeEnv(join(f.tmp, "home")) },
  });
  await child.exited;
  return child.pid;
}

describe("the claim", () => {
  test("a young claim means a worker was started: nothing more starts", () => {
    writeClaim(NOW - GRACE + 1000);
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(true);
    expect(f.record()?.failures ?? 0).toBe(0);
  });

  test("an old claim whose worker holds no pass lock is a lost worker", () => {
    writeClaim(NOW - GRACE - 1000);
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    const r = f.record()!;
    expect(r.failures).toBe(1);
    expect(r.closed).toBe(false);
    expect(r.retry_at).toBe(new Date(NOW + HOUR).toISOString());
    expect(r.last_run?.outcome).toBe("lost");
    expect(r.lost_worker_at).toBe(new Date(NOW).toISOString());
    // Before the retry time nothing starts; after it, a new worker.
    expect(run().started).toBe(false);
    expect(dreamDayCheck(f.config(), { now: () => NOW + HOUR + 1 }).started).toBe(true);
    expect(spawns).toHaveLength(1);
  });

  test("an old claim whose worker wrote its pid and lives is not lost", () => {
    writeClaim(NOW - GRACE - 1000, { worker_pid: process.pid });
    expect(run().started).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(true);
    expect(f.record()?.failures ?? 0).toBe(0);
  });

  test("an old claim whose worker wrote its pid and is gone is a lost worker", async () => {
    writeClaim(NOW - GRACE - 1000, { worker_pid: await deadPid() });
    expect(run().started).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    expect(f.record()?.last_run?.outcome).toBe("lost");
  });

  test("a lost worker after a closed day leaves that day closed and opens its own day", async () => {
    // The previous day closed by a pass run by hand; today's worker, started
    // by the first session of the day, ended without recording an outcome.
    seed({
      day: "2026-11-19",
      closed: true,
      owner: MINE,
      last_run: {
        started_at: new Date(NOW - GRACE - 1000).toISOString(),
        ended_at: null,
        outcome: null,
        by: "worker",
      },
    });
    writeClaim(NOW - GRACE - 1000, { worker_pid: await deadPid() });
    expect(run().started).toBe(false);
    const r = f.record()!;
    expect(r.last_run?.outcome).toBe("lost");
    // The day the attempt was made is the one left open, never the closed one.
    expect(r.day).toBe(TODAY);
    expect(r.closed).toBe(false);
    expect(r.reason).toBe("the dream worker ended without recording an outcome");
  });

  test("a claim no worker proved, whose maker is gone, is abandoned without a failure", async () => {
    const pid = await deadPid();
    // Within the start window a worker may still be starting.
    writeClaim(NOW - DREAM_TRIGGER_CLAIM_GRACE_MS + 1000, { pid });
    expect(run().started).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(true);
    writeClaim(NOW - DREAM_TRIGGER_CLAIM_GRACE_MS, { pid });
    expect(run().started).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    const r = f.record()!;
    expect(r.failures).toBe(0);
    expect(r.retry_at).toBeNull();
    expect(r.lost_worker_at).toBeNull();
    // The next check starts a worker.
    expect(run().started).toBe(true);
  });

  test("the claim is the last step before the spawn: the log is ready before it", () => {
    const original = claim.createClaim;
    const order: string[] = [];
    const created = spyOn(claim, "createClaim").mockImplementation((path, at) => {
      order.push(existsSync(join(dirname(dreamWorkerLogPath(f.store("dev-a"))))) ? "log-dir" : "");
      order.push("claim");
      return original(path, at);
    });
    spawnSpy.mockImplementation(((argv: ReadonlyArray<string>) => {
      order.push("spawn");
      spawns.push([...argv]);
      return { pid: 0 };
    }) as typeof o2bCommand.spawnSelfDetached);
    try {
      expect(run().started).toBe(true);
    } finally {
      created.mockRestore();
    }
    expect(order).toEqual(["log-dir", "claim", "spawn"]);
  });

  test("a claim read whole that is not a claim ages by its file and is reported", () => {
    const path = dreamTriggerClaimPath(f.recordPath);
    writeFileSync(path, "not a claim");
    const old = (NOW - GRACE - 1000) / 1000;
    utimesSync(path, old, old);
    expect(run().started).toBe(false);
    expect(existsSync(path)).toBe(false);
    const r = f.record()!;
    expect(r.failures).toBe(1);
    expect(r.reason).toContain("could not be read");
    expect(r.retry_at).toBe(new Date(NOW + HOUR).toISOString());
  });

  // chmod 000 denies nothing to root or on Windows (tests/helpers/platform.ts).
  test.skipIf(CHMOD_CANNOT_DENY)("a claim that cannot be read now is never aged out", () => {
    const path = dreamTriggerClaimPath(f.recordPath);
    writeClaim(0);
    const old = (NOW - GRACE - 1000) / 1000;
    utimesSync(path, old, old);
    chmodSync(path, 0o000);
    try {
      expect(run().started).toBe(false);
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(spawns).toEqual([]);
    expect(f.record()?.failures ?? 0).toBe(0);
  });

  test("a lost claim that cannot be removed is a failed attempt with its reason", () => {
    writeClaim(NOW - GRACE - 1000);
    const removal = spyOn(claim, "removeClaimIf").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    try {
      expect(run().started).toBe(false);
    } finally {
      removal.mockRestore();
    }
    const r = f.record()!;
    expect(r.failures).toBe(1);
    expect(r.reason).toContain("cannot be removed: EACCES");
    expect(r.retry_at).toBe(new Date(NOW + HOUR).toISOString());
    // The retry time keeps the next checks from trying again at once.
    expect(run().started).toBe(false);
    expect(f.record()!.failures).toBe(1);
  });

  test("an old claim whose worker holds the pass lock is not lost", async () => {
    writeClaim(NOW - GRACE - 1000);
    const until = join(f.tmp, "release");
    const holder = await startDreamPassHolder(f.store("dev-a"), 60_000, until);
    try {
      expect(run().started).toBe(false);
    } finally {
      writeFileSync(until, "");
      await holder.exited;
    }
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(true);
    expect(f.record()?.failures ?? 0).toBe(0);
  });

  test("a spawn that throws gives the claim back and records a failed attempt", () => {
    spawnSpy.mockImplementation(() => {
      throw new Error("no runtime");
    });
    expect(run().started).toBe(false);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    const r = f.record()!;
    expect(r.failures).toBe(1);
    expect(r.reason).toContain("no runtime");
    expect(r.last_run?.outcome).toBe("failed");
  });

  test("an attempt that cannot be recorded before the spawn gives the claim back", () => {
    const original = record.updateDreamTriggerRecord;
    const update = spyOn(record, "updateDreamTriggerRecord").mockImplementation(
      (path, root, change) =>
        original(path, root, (r) => {
          const next = change(r);
          // The pending attempt: started, not ended.
          if (next?.last_run?.started_at != null && next.last_run.ended_at === null) {
            throw new Error("ENOSPC: no space left on device");
          }
          return next;
        }),
    );
    try {
      expect(run().started).toBe(false);
    } finally {
      update.mockRestore();
    }
    expect(spawns).toEqual([]);
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(false);
    const r = f.record()!;
    expect(r.failures).toBe(1);
    expect(r.reason).toContain("ENOSPC");
  });

  test("a whole run's claim whose release failed does not stand for the rest of the process", () => {
    const release = holdDreamRunClaim(f.configPath, clock);
    const path = dreamTriggerClaimPath(f.recordPath);
    expect(JSON.parse(readFileSync(path, "utf8")).worker_pid).toBe(process.pid);
    const lock = spyOn(localLock, "withLocalLock").mockImplementation(() => {
      throw new Error("EIO: i/o error");
    });
    try {
      release();
    } finally {
      lock.mockRestore();
    }
    // Left behind, carrying this live process's pid.
    expect(existsSync(path)).toBe(true);
    // The next run of this process takes the claim, and the day check after it starts a worker.
    const next = holdDreamRunClaim(f.configPath, clock);
    next();
    expect(existsSync(path)).toBe(false);
    expect(run().started).toBe(true);
  });

  test("a claim lock held past the wait before the claim is judged records nothing", () => {
    writeClaim(NOW - GRACE - 1000);
    const removal = spyOn(claim, "removeClaimIf").mockImplementation(() => {
      const busy: NodeJS.ErrnoException = new Error("store lock busy: still held");
      busy.code = "ELOCKED";
      throw busy;
    });
    try {
      expect(run().started).toBe(false);
    } finally {
      removal.mockRestore();
    }
    expect(existsSync(dreamTriggerClaimPath(f.recordPath))).toBe(true);
    const r = f.record()!;
    expect(r.failures).toBe(0);
    expect(r.retry_at).toBeNull();
    // The next check judges the claim.
    expect(run().started).toBe(false);
    expect(f.record()!.failures).toBe(1);
  });

  test("the attempt is recorded before the worker starts, and the worker's outcome stands", () => {
    const atSpawn: Array<record.DreamTriggerRecord["last_run"]> = [];
    spawnSpy.mockImplementation(((argv: ReadonlyArray<string>) => {
      spawns.push([...argv]);
      atSpawn.push(f.record()!.last_run);
      // A worker that ends before the check returns writes its outcome.
      writeDreamTriggerRecord(f.recordPath, {
        ...f.record()!,
        closed: true,
        day: TODAY,
        last_run: {
          started_at: new Date(NOW).toISOString(),
          ended_at: new Date(NOW + 1).toISOString(),
          outcome: "complete",
          by: "worker",
        },
      });
      return { pid: 0 };
    }) as typeof o2bCommand.spawnSelfDetached);
    expect(run().started).toBe(true);
    expect(atSpawn).toEqual([
      { started_at: new Date(NOW).toISOString(), ended_at: null, outcome: null, by: "worker" },
    ]);
    expect(f.record()!.last_run).toMatchObject({ outcome: "complete", by: "worker" });
  });

  test(
    "two checks racing in two processes start one worker",
    async () => {
      const go = join(f.tmp, "go");
      const script = [
        'import { existsSync } from "node:fs";',
        'import { discoverConfig } from "./src/core/config.ts";',
        'import { dreamDayCheck } from "./src/core/brain/dream-trigger/check.ts";',
        "let spawned = 0;",
        // The child's own spawn: counted, never run. The worker is started
        // through the launcher that reparents it (`spawnSelfDetached`), a
        // synchronous spawn whose environment carries the worker's argv.
        "const spawnSync = Bun.spawnSync;",
        "Bun.spawnSync = (o) => { if (o?.env?.O2B_REPARENT_PAYLOAD === undefined) return spawnSync(o); spawned += 1; return { exitCode: 0, stdout: Buffer.from('pid:0') }; };",
        "Bun.spawn = () => { spawned += 1; return { pid: 0, unref() {} }; };",
        'process.stdout.write("ready\\n");',
        "while (!existsSync(Bun.argv[1])) await Bun.sleep(5);",
        `const r = dreamDayCheck(discoverConfig(process.env.OPEN_SECOND_BRAIN_CONFIG), { now: () => ${NOW} });`,
        "process.stdout.write(JSON.stringify({ started: r.started, spawned }) + '\\n');",
      ].join("\n");
      const env = {
        ...process.env,
        ...homeEnv(join(f.tmp, "home")),
        OPEN_SECOND_BRAIN_CONFIG: f.configPath,
        [STORE_ROOT_ENV]: f.storeRoot,
        O2B_DEVICE_ID: "dev-a",
        OPEN_SECOND_BRAIN_DREAM_AUTO: "true",
      };
      // Each child is tracked as it starts and stopped and awaited in
      // `finally`, so none outlives the fixture when a step below fails.
      const children: Array<ReturnType<typeof Bun.spawn>> = [];
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      const outs = ["", ""];
      let exits: number[];
      let stderr: string[];
      try {
        for (let i = 0; i < 2; i++) {
          children.push(
            Bun.spawn([process.execPath, "-e", script, go], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env,
            }),
          );
        }
        const readers = children.map((c) => (c.stdout as ReadableStream<Uint8Array>).getReader());
        const decoder = new TextDecoder();
        // Both children are waiting on `go` before it is written; the wait
        // is bounded, so a child stuck before it is ready fails the test.
        await Promise.race([
          Promise.all(
            readers.map(async (reader, i) => {
              while (!outs[i]!.includes("ready")) {
                // oxlint-disable-next-line no-await-in-loop -- reads are sequential by nature
                const { value, done } = await reader.read();
                if (done) throw new Error(`child ${i} ended before it was ready`);
                outs[i] += decoder.decode(value);
              }
            }),
          ),
          new Promise((_, reject) => {
            readyTimer = setTimeout(
              () => reject(new Error("the children were not ready in time")),
              CLI_SPAWN_BUDGET_MS,
            );
          }),
        ]);
        writeFileSync(go, "");
        await Promise.all(
          readers.map(async (reader, i) => {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- reads are sequential by nature
              const { value, done } = await reader.read();
              if (done) break;
              outs[i] += decoder.decode(value);
            }
          }),
        );
        exits = await Promise.all(children.map((c) => c.exited));
        stderr = await Promise.all(
          children.map((c) => new Response(c.stderr as ReadableStream<Uint8Array>).text()),
        );
      } finally {
        clearTimeout(readyTimer);
        for (const c of children) if (c.exitCode === null) c.kill();
        await Promise.all(children.map((c) => c.exited));
      }
      expect({ exits, stderr }).toEqual({ exits: [0, 0], stderr: ["", ""] });
      const results = outs.map((o) => JSON.parse(o.split("\n").findLast(Boolean)!));
      expect(results.filter((r) => r.started)).toHaveLength(1);
      expect(results.reduce((n, r) => n + r.spawned, 0)).toBe(1);
      // Longer than the readiness bound, so a stuck child fails the test
      // through it and is stopped in `finally`.
    },
    2 * CLI_SPAWN_BUDGET_MS,
  );
});

function cli(args: string[]) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: f.configPath } });
}

describe("a change of role or of dream.auto made today", () => {
  test("taking the role here makes the next check of the same day look again", async () => {
    f.cleanup();
    f = makeTriggerFixture({ owner: null });
    expect(run().started).toBe(false);
    expect(f.record()).toMatchObject({ owner: { mine: false }, owner_checked_day: TODAY });
    expect((await cli(["dream", "owner", "--here", "--json"])).returncode).toBe(0);
    expect(f.record()?.owner_checked_day).toBeNull();
    expect(run().started).toBe(true);
  });

  test("giving the role up makes the next check of the same day look again", async () => {
    expect(run().started).toBe(true);
    expect(f.record()?.owner_checked_day).toBe(TODAY);
    expect((await cli(["dream", "owner", "--release", "--json"])).returncode).toBe(0);
    expect(f.record()?.owner_checked_day).toBeNull();
  });

  test("turning dream.auto on makes the next check of the same day start a worker", async () => {
    f.setAuto(false);
    expect(run().started).toBe(false);
    expect(f.record()).toMatchObject({ auto: false, owner_checked_day: TODAY });
    expect((await cli(["brain", "settings", "set", "dream.auto", "true"])).returncode).toBe(0);
    expect(f.record()?.owner_checked_day).toBeNull();
    expect(run().started).toBe(true);
  });
});

describe("the check never fails its caller", () => {
  test("a throw inside the check is swallowed", () => {
    const spy = spyOn(record, "readDreamTriggerRecord").mockImplementation(() => {
      throw new Error("disk on fire");
    });
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(run()).toEqual({ started: false });
      expect(String(write.mock.calls[0]?.[0])).toContain("disk on fire");
    } finally {
      spy.mockRestore();
      write.mockRestore();
    }
    expect(spawns).toEqual([]);
  });

  test("no machine config: nothing is checked", () => {
    expect(dreamDayCheck(null)).toEqual({ started: false });
  });

  test("no check inside a dream session", () => {
    const counts = { opens: 0 };
    const opens = spyOn(storeOpen, "openStore");
    try {
      expect(run({ env: { ...process.env, [DREAM_RUN_ENV]: "run-1" } }).started).toBe(false);
      counts.opens = opens.mock.calls.length;
    } finally {
      opens.mockRestore();
    }
    expect(counts.opens).toBe(0);
    expect(spawns).toEqual([]);
    expect(f.record()).toBeNull();
  });

  test("the machine switch turns the check off", () => {
    expect(run({ env: { ...process.env, OPEN_SECOND_BRAIN_DREAM_AUTO: "false" } }).started).toBe(
      false,
    );
    expect(spawns).toEqual([]);
    expect(f.record()).toBeNull();
  });
});

describe("a claim this process failed to give back", () => {
  test("stays queued while the claim cannot be read, and is given back once it can", () => {
    const path = dreamTriggerClaimPath(f.recordPath);
    mkdirSync(dirname(path), { recursive: true });
    const token = claim.createClaim(path, NOW, process.pid)!;
    const lock = spyOn(localLock, "withLocalLock").mockImplementation(() => {
      throw new Error("lock busy");
    });
    try {
      expect(() => claim.releaseClaim(path, token)).toThrow("lock busy");
    } finally {
      lock.mockRestore();
    }
    // The retry finds the claim there but unreadable (a directory reads EISDIR).
    const held = readFileSync(path, "utf8");
    rmSync(path);
    mkdirSync(path);
    expect(claim.releaseClaim(path, token)).toBe(false);
    rmSync(path, { recursive: true });
    writeFileSync(path, held);
    // Readable again: the next claim gives the queued one back first.
    expect(claim.createClaim(path, NOW)).not.toBeNull();
  });
});

// Open Second Brain 2.0.5 keyed the record by the root resolved as if
// no vault were configured: the per-user default, which holds no store.
const legacyRoot = (): string => defaultStoreRoot();
const legacyPath = (): string => record.dreamTriggerRecordPath(legacyRoot());

function seedLegacy(over: Partial<record.DreamTriggerRecord>): void {
  writeDreamTriggerRecord(legacyPath(), { ...emptyDreamTriggerRecord(legacyRoot()), ...over });
}

describe("a record an earlier install wrote under the old key", () => {
  test("a day it closed stays closed: nothing is started, and the record moves to the right key", () => {
    expect(f.vault).not.toBeNull();
    expect(legacyPath()).not.toBe(f.recordPath);
    seedLegacy({ closed: true, day: TODAY, owner: MINE });
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()).toMatchObject({ store_root: f.storeRoot, closed: true, day: TODAY });
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("its retry time and failure count hold", () => {
    const retryAt = new Date(NOW + HOUR).toISOString();
    seedLegacy({ day: TODAY, failures: 3, retry_at: retryAt, owner: MINE });
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()).toMatchObject({ failures: 3, retry_at: retryAt });
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("a day it closed before today is due: one worker starts, the failure count carried", () => {
    seedLegacy({ closed: true, day: "2026-11-19", failures: 1, owner: MINE });
    expect(run().started).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(f.record()).toMatchObject({ failures: 1, owner_checked_day: TODAY });
  });

  test("a record already under the right key wins, and the old file is not read", () => {
    seed({ closed: true, day: TODAY, owner: MINE });
    seedLegacy({ day: "2026-11-19", failures: 5 });
    expect(run().started).toBe(false);
    expect(f.record()).toMatchObject({ closed: true, day: TODAY, failures: 0 });
    // The right key held a record: the old file is left as it is, unread.
    expect(existsSync(legacyPath())).toBe(true);
  });

  test("a session on another vault (VAULT_DIR) leaves it to the configured vault, which keeps its closed day", () => {
    seedLegacy({ closed: true, day: TODAY, owner: MINE });
    const other = join(f.tmp, "other-vault");
    mkdirSync(other, { recursive: true });
    process.env["VAULT_DIR"] = other;
    try {
      const there = record.dreamTriggerLocation(f.config());
      expect(there.storeRoot).not.toBe(f.storeRoot);
      expect(existsSync(there.recordPath)).toBe(false);
      expect(existsSync(legacyPath())).toBe(true);
    } finally {
      delete process.env["VAULT_DIR"];
    }
    // The first session on the configured vault carries it: no second pass today.
    expect(run().started).toBe(false);
    expect(spawns).toEqual([]);
    expect(f.record()).toMatchObject({ store_root: f.storeRoot, closed: true, day: TODAY });
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("while the old key's claim stands, both files are left; once it is gone the record is carried", () => {
    const retryAt = new Date(NOW + HOUR).toISOString();
    seedLegacy({ day: TODAY, failures: 2, retry_at: retryAt, owner: MINE });
    const legacyClaim = dreamTriggerClaimPath(legacyPath());
    writeFileSync(legacyClaim, "{}\n");
    record.dreamTriggerLocation(f.config());
    expect(existsSync(f.recordPath)).toBe(false);
    expect(existsSync(legacyPath())).toBe(true);
    expect(existsSync(legacyClaim)).toBe(true);
    rmSync(legacyClaim);
    record.dreamTriggerLocation(f.config());
    expect(f.record()).toMatchObject({ store_root: f.storeRoot, failures: 2, retry_at: retryAt });
    expect(existsSync(legacyPath())).toBe(false);
  });
});
