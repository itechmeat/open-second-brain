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
  decideFreshen,
  FRESHEN_CLAIM_FILE,
  FRESHEN_SKIP,
  freshenCommand,
  freshenSpawnOptions,
  maybeFreshenIndex,
  nextBackoffMs,
  readFreshenState,
  releaseFreshen,
  writeFreshenState,
} from "../../../src/core/search/freshen.ts";
import { acquireWriterLockSync } from "../../../src/core/search/store/writer-lock.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
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
