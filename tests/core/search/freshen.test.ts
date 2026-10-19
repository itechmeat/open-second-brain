import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimFreshen,
  clearFreshenPending,
  decideFreshen,
  FRESHEN_CLAIM_FILE,
  FRESHEN_PENDING_FILE,
  FRESHEN_SKIP,
  freshenCommand,
  freshenSpawnOptions,
  markFreshenPending,
  maybeFreshenIndex,
  nextBackoffMs,
  readFreshenPending,
  readFreshenState,
  releaseFreshen,
  settleFreshenPending,
  takeFreshenPending,
  writeFreshenState,
} from "../../../src/core/search/freshen.ts";
import { acquireWriterLockSync } from "../../../src/core/search/store/writer-lock.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import type { FreshenPending } from "../../../src/core/search/freshen.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

describe("decideFreshen", () => {
  const base = { nowMs: NOW, intervalSeconds: 60, backoffUntilMs: null };

  test("an interval of 0 is off", () => {
    expect(decideFreshen({ ...base, intervalSeconds: 0, lastIndexedAt: ago(3600) })).toEqual({
      action: "skip",
      reason: FRESHEN_SKIP.off,
    });
  });

  test("an index never stamped is left to self-heal", () => {
    expect(decideFreshen({ ...base, lastIndexedAt: null })).toEqual({
      action: "skip",
      reason: FRESHEN_SKIP.noIndex,
    });
  });

  test("an index younger than the interval is fresh", () => {
    expect(decideFreshen({ ...base, lastIndexedAt: ago(30) })).toEqual({
      action: "skip",
      reason: FRESHEN_SKIP.fresh,
    });
  });

  test("an index older than the interval is due", () => {
    expect(decideFreshen({ ...base, lastIndexedAt: ago(61) })).toEqual({ action: "spawn" });
  });

  test("an active backoff wins over a stale index", () => {
    expect(
      decideFreshen({ ...base, lastIndexedAt: ago(3600), backoffUntilMs: NOW + 1000 }),
    ).toEqual({ action: "skip", reason: FRESHEN_SKIP.backoff });
  });

  test("a fresh index is fresh even while a backoff is active", () => {
    expect(decideFreshen({ ...base, lastIndexedAt: ago(30), backoffUntilMs: NOW + 1000 })).toEqual({
      action: "skip",
      reason: FRESHEN_SKIP.fresh,
    });
  });

  test("an unparseable stamp counts as due rather than fresh", () => {
    expect(decideFreshen({ ...base, lastIndexedAt: "not a date" })).toEqual({ action: "spawn" });
  });
});

describe("claim, state and backoff", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osb-freshen-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("only the first of two claims wins", () => {
    expect(claimFreshen(dir, NOW)).toBeString();
    expect(claimFreshen(dir, NOW)).toBeNull();
  });

  test("a claim abandoned for more than ten minutes is taken over", () => {
    writeFileSync(
      join(dir, FRESHEN_CLAIM_FILE),
      JSON.stringify({ token: "dead", at: NOW - 601_000 }),
    );
    const token = claimFreshen(dir, NOW);
    expect(token).toBeString();
    expect(token).not.toBe("dead");
  });

  test("a torn claim file older than the grace is taken over too", () => {
    const path = join(dir, FRESHEN_CLAIM_FILE);
    writeFileSync(path, "{");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(claimFreshen(dir, Date.now())).toBeString();
  });

  test("releasing with a foreign token leaves the claim in place", () => {
    const token = claimFreshen(dir, NOW)!;
    releaseFreshen(dir, "someone-else");
    expect(existsSync(join(dir, FRESHEN_CLAIM_FILE))).toBe(true);
    releaseFreshen(dir, token);
    expect(existsSync(join(dir, FRESHEN_CLAIM_FILE))).toBe(false);
  });

  test("state round-trips and a missing or torn file reads as empty", () => {
    expect(readFreshenState(dir).failures).toBe(0);
    writeFileSync(join(dir, "freshen-state.json"), "{");
    expect(readFreshenState(dir).lastOutcome).toBeNull();
    const state = {
      failures: 2,
      backoffUntil: ago(-120),
      lastOutcome: "failed" as const,
      lastRunAt: ago(5),
      lastDurationMs: 300,
      lastError: "disk full",
      lastChanged: null,
    };
    writeFreshenState(dir, state);
    expect(readFreshenState(dir)).toEqual(state);
  });

  test("backoff doubles from a minute and stops at an hour", () => {
    expect(nextBackoffMs(1)).toBe(60_000);
    expect(nextBackoffMs(2)).toBe(120_000);
    expect(nextBackoffMs(10)).toBe(3_600_000);
  });
});

describe("freshenCommand", () => {
  const base = ["o2b", "search", "index"];
  test("linux runs the child at idle I/O priority when ionice exists", () => {
    expect(freshenCommand(base, (t) => t === "ionice", "linux")).toEqual([
      "ionice",
      "-c3",
      ...base,
    ]);
    expect(freshenCommand(base, () => false, "linux")).toEqual(base);
  });
  test("macOS uses taskpolicy and Windows needs no prefix", () => {
    expect(freshenCommand(base, (t) => t === "taskpolicy", "darwin")).toEqual([
      "taskpolicy",
      "-b",
      ...base,
    ]);
    expect(freshenCommand(base, () => true, "win32")).toEqual(base);
  });
});

describe("freshenSpawnOptions", () => {
  test("the child is detached on every platform so it outlives a short-lived hook", () => {
    const opts = freshenSpawnOptions({ O2B_TEST: "1" });
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect([opts.stdin, opts.stdout, opts.stderr]).toEqual(["ignore", "ignore", "ignore"]);
  });

  test("the child gets a copy of the current environment, not the start-up one", () => {
    const env = { O2B_CONFIG: "/later/config.yaml" };
    const opts = freshenSpawnOptions(env);
    expect(opts.env).toEqual(env);
    expect(opts.env).not.toBe(env);
  });
});

describe("maybeFreshenIndex", () => {
  let vault: string;
  let config: ResolvedSearchConfig;
  let calls: string[][];
  const spawn = (argv: string[]): void => {
    calls.push(argv);
  };

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-freshen-vault-"));
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    calls = [];
    config = {
      vault,
      dbPath: join(vault, ".open-second-brain", "brain.sqlite"),
      freshen: { intervalSeconds: 60, embeddings: false, configPath: "/cfg/config.yaml" },
    } as unknown as ResolvedSearchConfig;
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  test("a stale index spawns one index run carrying the vault, config and claim", () => {
    expect(maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn })).toBe(
      "spawned",
    );
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv.join(" ")).toContain(`search index --vault ${vault} --config /cfg/config.yaml`);
    const claim = JSON.parse(
      readFileSync(join(vault, ".open-second-brain", FRESHEN_CLAIM_FILE), "utf8"),
    ) as { token: string };
    expect(argv.slice(-2)).toEqual(["--freshen", claim.token]);
  });

  test("a second reader while the first run holds the claim spawns nothing", () => {
    maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn });
    expect(maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn })).toBe(
      FRESHEN_SKIP.claimed,
    );
    expect(calls).toHaveLength(1);
  });

  test("a fresh index spawns nothing", () => {
    expect(maybeFreshenIndex(config, { lastIndexedAt: ago(5), nowMs: NOW, spawn })).toBe(
      FRESHEN_SKIP.fresh,
    );
    expect(calls).toHaveLength(0);
  });

  test("a read-only open never freshens a vault it does not own", () => {
    expect(
      maybeFreshenIndex(config, { lastIndexedAt: ago(3600), nowMs: NOW, spawn, readOnly: true }),
    ).toBe(FRESHEN_SKIP.readOnly);
    expect(calls).toHaveLength(0);
  });

  test("a config without freshen settings is off", () => {
    const { freshen: _drop, ...rest } = config as unknown as Record<string, unknown>;
    expect(
      maybeFreshenIndex(rest as unknown as ResolvedSearchConfig, {
        lastIndexedAt: ago(3600),
        nowMs: NOW,
        spawn,
      }),
    ).toBe(FRESHEN_SKIP.off);
  });

  test("an indexer already holding the writer lock is left alone", () => {
    const release = acquireWriterLockSync(config.dbPath);
    try {
      expect(maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn })).toBe(
        FRESHEN_SKIP.writerLock,
      );
      expect(calls).toHaveLength(0);
    } finally {
      release();
    }
  });

  test("an active backoff from a failed run spawns nothing", () => {
    writeFreshenState(join(vault, ".open-second-brain"), {
      failures: 1,
      backoffUntil: new Date(NOW + 30_000).toISOString(),
      lastOutcome: "failed",
      lastRunAt: ago(10),
      lastDurationMs: 100,
      lastError: "boom",
      lastChanged: null,
    });
    expect(maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn })).toBe(
      FRESHEN_SKIP.backoff,
    );
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an index directory that refuses the claim is reported as unwritable, not claimed",
    () => {
      const dir = join(vault, ".open-second-brain");
      chmodSync(dir, 0o555);
      try {
        expect(maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn })).toBe(
          FRESHEN_SKIP.unwritable,
        );
        expect(calls).toHaveLength(0);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  test("a fresh index is decided without the state file, so a backoff there is not consulted", () => {
    writeFreshenState(join(vault, ".open-second-brain"), {
      failures: 1,
      backoffUntil: new Date(NOW + 30_000).toISOString(),
      lastOutcome: "failed",
      lastRunAt: ago(10),
      lastDurationMs: 100,
      lastError: "boom",
      lastChanged: null,
    });
    expect(maybeFreshenIndex(config, { lastIndexedAt: ago(5), nowMs: NOW, spawn })).toBe(
      FRESHEN_SKIP.fresh,
    );
  });

  test("a spawner that throws is reported as a skip and releases the claim", () => {
    const decision = maybeFreshenIndex(config, {
      lastIndexedAt: ago(300),
      nowMs: NOW,
      spawn: () => {
        throw new Error("no fork");
      },
    });
    expect(decision).toBe(FRESHEN_SKIP.spawnFailed);
    expect(existsSync(join(vault, ".open-second-brain", FRESHEN_CLAIM_FILE))).toBe(false);
  });

  test("force spawns despite a fresh index - a write that just happened is due by definition", () => {
    expect(
      maybeFreshenIndex(config, { lastIndexedAt: ago(5), nowMs: NOW, spawn, force: true }),
    ).toBe("spawned");
    expect(calls).toHaveLength(1);
    // The child argv is the same run the interval path starts: same
    // command, same claim protocol.
    expect(calls[0]!.join(" ")).toContain(`search index --vault ${vault}`);
  });

  // There is deliberately no freshness floor against the write's own
  // instant: the stamp marks when a run FINISHED, and a run that finished
  // after the write began may have scanned before the write landed - a
  // stamp cannot prove the index has seen the write, so a floor built on
  // one would silently leave the write unindexed until the next interval
  // or the next write. The test above is the pin: the youngest stamp
  // that is not "never stamped" still spawns. A run already in flight is
  // the collapse that remains, and the claim exclusivity test below
  // holds it.

  test("force with the interval at 0 still refuses - config off means off", () => {
    const offConfig = {
      ...config,
      freshen: { intervalSeconds: 0, embeddings: false, configPath: "/cfg/config.yaml" },
    } as unknown as ResolvedSearchConfig;
    expect(
      maybeFreshenIndex(offConfig, { lastIndexedAt: ago(300), nowMs: NOW, spawn, force: true }),
    ).toBe(FRESHEN_SKIP.off);
    expect(calls).toHaveLength(0);
  });

  test("force with no freshen settings at all still refuses", () => {
    const { freshen: _drop, ...rest } = config as unknown as Record<string, unknown>;
    expect(
      maybeFreshenIndex(rest as unknown as ResolvedSearchConfig, {
        lastIndexedAt: ago(300),
        nowMs: NOW,
        spawn,
        force: true,
      }),
    ).toBe(FRESHEN_SKIP.off);
    expect(calls).toHaveLength(0);
  });

  test("an index never stamped stays self-heal's even under force", () => {
    expect(maybeFreshenIndex(config, { lastIndexedAt: null, nowMs: NOW, spawn, force: true })).toBe(
      FRESHEN_SKIP.noIndex,
    );
    expect(calls).toHaveLength(0);
  });

  test("claim exclusivity holds under force: the second claimant spawns nothing", () => {
    expect(
      maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn, force: true }),
    ).toBe("spawned");
    expect(
      maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn, force: true }),
    ).toBe(FRESHEN_SKIP.claimed);
    expect(calls).toHaveLength(1);
  });

  test("an active backoff from a failed run still refuses under force", () => {
    writeFreshenState(join(vault, ".open-second-brain"), {
      failures: 1,
      backoffUntil: new Date(NOW + 30_000).toISOString(),
      lastOutcome: "failed",
      lastRunAt: ago(10),
      lastDurationMs: 100,
      lastError: "boom",
      lastChanged: null,
    });
    expect(
      maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn, force: true }),
    ).toBe(FRESHEN_SKIP.backoff);
    expect(calls).toHaveLength(0);
  });

  test("an indexer already holding the writer lock is left alone under force", () => {
    const release = acquireWriterLockSync(config.dbPath);
    try {
      expect(
        maybeFreshenIndex(config, { lastIndexedAt: ago(300), nowMs: NOW, spawn, force: true }),
      ).toBe(FRESHEN_SKIP.writerLock);
      expect(calls).toHaveLength(0);
    } finally {
      release();
    }
  });

  test("a read-only open never freshens a vault it does not own, force included", () => {
    expect(
      maybeFreshenIndex(config, {
        lastIndexedAt: ago(300),
        nowMs: NOW,
        spawn,
        force: true,
        readOnly: true,
      }),
    ).toBe(FRESHEN_SKIP.readOnly);
    expect(calls).toHaveLength(0);
  });
});

describe("claim races", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osb-freshen-race-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a zero-byte claim younger than the grace is a claim being written, not a dead one", () => {
    writeFileSync(join(dir, FRESHEN_CLAIM_FILE), "");
    expect(claimFreshen(dir, Date.now())).toBeNull();
  });

  test("a zero-byte claim older than the grace is taken over", () => {
    const path = join(dir, FRESHEN_CLAIM_FILE);
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(claimFreshen(dir, Date.now())).toBeString();
  });

  test("a stale claim taken over by one reader is not taken over again by the next", () => {
    writeFileSync(
      join(dir, FRESHEN_CLAIM_FILE),
      JSON.stringify({ token: "dead", at: Date.now() - 601_000 }),
    );
    expect(claimFreshen(dir, Date.now())).toBeString();
    expect(claimFreshen(dir, Date.now())).toBeNull();
  });

  test("of eight processes racing on a stale claim exactly one wins", async () => {
    writeFileSync(
      join(dir, FRESHEN_CLAIM_FILE),
      JSON.stringify({ token: "dead", at: Date.now() - 601_000 }),
    );
    const module = join(import.meta.dir, "..", "..", "..", "src", "core", "search", "freshen.ts");
    const script = `const { claimFreshen } = await import(${JSON.stringify(module)});
      const go = Number(process.argv[1]);
      while (Date.now() < go) {}
      console.log(claimFreshen(process.argv[2], Date.now()) === null ? "lost" : "won");`;
    const go = String(Date.now() + 1500);
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", "-e", script, go, dir], { stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    expect(outs.map((o) => o.trim()).filter((o) => o === "won")).toHaveLength(1);
  });
});

describe("the pending-refresh marker a refused forced claim leaves", () => {
  // A write that lands while another run holds the claim used to be
  // answered `not_claimed` and forgotten: the in-flight run may already
  // have walked past the changed files, and its fresh stamp then
  // suppressed freshen-on-read for a whole interval. The marker is the
  // queue: the forced caller writes "pending since <instant>" beside the
  // freshen state, and the child - before releasing the claim - runs ONE
  // more incremental pass when the marker is newer than its scan start.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osb-freshen-pending-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("marks, reads and clears beside the freshen state", () => {
    expect(readFreshenPending(dir)).toBeNull();
    markFreshenPending(dir, NOW);
    // Same directory the claim and the state live in - the child is
    // handed exactly this directory as `--freshen-state`.
    const raw = JSON.parse(readFileSync(join(dir, FRESHEN_PENDING_FILE), "utf8")) as {
      since: number;
    };
    expect(raw.since).toBe(NOW);
    expect(readFreshenPending(dir)).toEqual({ since: NOW });
    clearFreshenPending(dir);
    expect(readFreshenPending(dir)).toBeNull();
    // Clearing an absent marker is nothing to fail a write over.
    expect(() => clearFreshenPending(dir)).not.toThrow();
  });

  test("a take puts the marker back on restore, and drops it on drop", () => {
    markFreshenPending(dir, NOW);
    const taken = takeFreshenPending(dir)!;
    expect(taken.pending).toEqual({ since: NOW });
    // While taken, the path is empty: a concurrent reader sees no marker.
    expect(readFreshenPending(dir)).toBeNull();
    taken.restore();
    expect(readFreshenPending(dir)).toEqual({ since: NOW });

    const again = takeFreshenPending(dir)!;
    again.drop();
    expect(readFreshenPending(dir)).toBeNull();
  });

  test("a writer that re-marks while the settle holds a take keeps the path", () => {
    // The race the take exists to close: the old read-then-clear settle
    // could unlink a marker a writer had JUST written newer, losing the
    // newest write its instant stood for. The restore answers the
    // occupied path atomically - the newer marker stays, the taken one
    // is superseded, never merged.
    markFreshenPending(dir, NOW);
    const taken = takeFreshenPending(dir)!;
    markFreshenPending(dir, NOW + 60_000);
    taken.restore();
    expect(readFreshenPending(dir)).toEqual({ since: NOW + 60_000 });

    // And a drop of a stale take never touches a newer marker either.
    const stale = takeFreshenPending(dir)!;
    expect(stale.pending).toEqual({ since: NOW + 60_000 });
    markFreshenPending(dir, NOW + 120_000);
    stale.drop();
    expect(readFreshenPending(dir)).toEqual({ since: NOW + 120_000 });
  });

  test("a take of an absent marker is null, and a torn marker survives a settle untouched", async () => {
    expect(takeFreshenPending(dir)).toBeNull();
    // A torn marker is not a readable instant: the settle neither runs
    // a pass on it nor destroys the file - the next real mark overwrites
    // it, and the next run judges the readable one.
    writeFileSync(join(dir, FRESHEN_PENDING_FILE), "{ not json", "utf8");
    let passes = 0;
    const ran = await settleFreshenPending(dir, NOW, async () => {
      passes++;
    });
    expect(ran).toBe(false);
    expect(passes).toBe(0);
    expect(existsSync(join(dir, FRESHEN_PENDING_FILE))).toBe(true);
  });

  test("a marker newer than the scan start runs ONE more pass, and the pass that covers it clears it", async () => {
    // Instants are pinned to the real clock here because the settle
    // compares the extra pass against its own scan start, which is
    // real: `Date.now()` in this suite ran ahead of any fixed fixture,
    // and a clock behind the fixture would flip the verdict.
    const markedAt = Date.now() - 1_000;
    markFreshenPending(dir, markedAt);
    // The in-flight run started scanning BEFORE the write landed: its
    // stamp cannot prove it saw the write, so the child owes one pass.
    const scanStart = markedAt - 5_000;
    let passes = 0;
    const ran = await settleFreshenPending(dir, scanStart, async () => {
      passes++;
    });
    expect(ran).toBe(true);
    expect(passes).toBe(1);
    // The extra pass started after the marker's instant, so it covered
    // the pending write - and the marker goes with it. A marker that
    // outlived its own coverage would push every later run into an
    // extra pass forever.
    expect(readFreshenPending(dir)).toBeNull();
  });

  test("a marker the main pass already covered is cleared without a second pass", async () => {
    markFreshenPending(dir, NOW - 60_000);
    const scanStart = NOW; // the run started after the pending write
    let passes = 0;
    const ran = await settleFreshenPending(dir, scanStart, async () => {
      passes++;
    });
    expect(ran).toBe(false);
    expect(passes).toBe(0);
    expect(readFreshenPending(dir)).toBeNull();
  });

  test("the bound holds: a marker landing during the extra pass survives it, and no second pass runs", async () => {
    // Instants are pinned to the real clock here because the settle
    // compares markers against its own scan starts, which are real:
    // `Date.now()` in this suite ran ahead of any fixed fixture.
    markFreshenPending(dir, Date.now() - 1_000);
    const scanStart = Date.now() - 5_000;
    let passes = 0;
    let passStart = 0;
    const ran = await settleFreshenPending(dir, scanStart, async () => {
      passes++;
      passStart = Date.now();
      // Another write lands while the extra pass is in flight: the
      // forced caller re-marks with the newer instant. One extra pass
      // is the bound - this write waits for the next run, which covers
      // it and clears the marker then.
      markFreshenPending(dir, passStart + 60_000);
    });
    expect(ran).toBe(true);
    expect(passes).toBe(1);
    // Newer than the extra pass's own scan start: NOT covered by it.
    expect(readFreshenPending(dir)).toEqual({ since: passStart + 60_000 });
    // The NEXT run's child, with its own later scan start, covers it.
    let nextPasses = 0;
    await settleFreshenPending(dir, passStart + 120_000, async () => {
      nextPasses++;
    });
    expect(nextPasses).toBe(0);
    expect(readFreshenPending(dir)).toBeNull();
  });

  test("a child that cannot run a pass (config unresolvable) leaves the marker for the next run", async () => {
    markFreshenPending(dir, NOW);
    const ran = await settleFreshenPending(dir, NOW - 5_000, null);
    expect(ran).toBe(false);
    // Still queued - dropping it here would be the silent loss the
    // marker exists to prevent.
    expect(readFreshenPending(dir)).toEqual({ since: NOW });
  });

  test("no marker, no pass", async () => {
    let passes = 0;
    const ran = await settleFreshenPending(dir, NOW - 5_000, async () => {
      passes++;
    });
    expect(ran).toBe(false);
    expect(passes).toBe(0);
  });

  test("a hard kill during the extra pass leaves the marker standing on its path", async () => {
    // The take-first settle moved the marker into its hold file BEFORE
    // the extra pass ran, so a child killed mid-pass stranded the marker
    // where nothing reads it again: the write stood unqueued and
    // unmarked. The settle now reads without taking and takes only once
    // the pass has finished, so at every instant up to and including the
    // kill the marker is exactly where the next run reads it.
    const markedAt = Date.now() - 1_000;
    markFreshenPending(dir, markedAt);
    const scanStart = markedAt - 5_000;
    let observedDuringPass: FreshenPending | null | undefined;
    const killDuringPass = new Promise<void>((resolve) => {
      void settleFreshenPending(dir, scanStart, async () => {
        // The kill lands here in a real child: the pass never returns,
        // and nothing the settle does after it ever runs.
        observedDuringPass = readFreshenPending(dir);
        resolve();
        await new Promise<void>(() => {});
      }).catch(() => {});
    });
    await killDuringPass;
    // Mid-pass, the marker is still on its own path - not hidden in the
    // settle's hold file, where the kill would leave it for good.
    expect(observedDuringPass).toEqual({ since: markedAt });
    expect(readFreshenPending(dir)).toEqual({ since: markedAt });
  });

  test("a failed extra pass leaves the marker queued for the next run", async () => {
    // A pass that threw covered nothing, so the marker goes back on its
    // path - it must not stay stranded in the settle's hold file, where
    // nothing would read it again. This is the pin the CLI child's
    // "an uncovered marker survives for the next run" rests on.
    const markedAt = Date.now() - 1_000;
    markFreshenPending(dir, markedAt);
    const scanStart = markedAt - 5_000;
    let passes = 0;
    try {
      await settleFreshenPending(dir, scanStart, async () => {
        passes++;
        throw new Error("indexer exploded");
      });
      throw new Error("the settle should have propagated the pass failure");
    } catch (e) {
      expect((e as Error).message).toBe("indexer exploded");
    }
    expect(passes).toBe(1);
    expect(readFreshenPending(dir)).toEqual({ since: markedAt });
  });
});

test("the spawned run is told where its state lives", () => {
  const vault = mkdtempSync(join(tmpdir(), "osb-freshen-statedir-"));
  try {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const calls: string[][] = [];
    const config = {
      vault,
      dbPath: join(vault, ".open-second-brain", "brain.sqlite"),
      freshen: { intervalSeconds: 60, embeddings: false, configPath: null },
    } as unknown as ResolvedSearchConfig;
    maybeFreshenIndex(config, {
      lastIndexedAt: new Date(Date.now() - 300_000).toISOString(),
      spawn: (argv) => calls.push(argv),
    });
    const argv = calls[0]!;
    const at = argv.indexOf("--freshen-state");
    expect(argv[at + 1]).toBe(join(vault, ".open-second-brain"));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
