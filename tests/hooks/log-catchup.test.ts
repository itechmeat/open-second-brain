/**
 * The SessionStart cross-agent log catch-up lane (t_3b44cd9a).
 *
 * Opt-in, read-only: when `log_catchup_enabled` resolves on, the hook
 * hands the agent the `Brain/log` lines OTHER agents appended since the
 * lane's last look - newest first under the per-lane cap, with a count of
 * older ones - under the shared untrusted-content fence. The cursor is an
 * un-synced `(date, shardId, line)` watermark in the derived store, never
 * a row in `Brain/log`: the lane is a pure read, and `Brain/log` is
 * byte-identical after every run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { DERIVED_STORE_DIR } from "../../src/core/brain/path-constants.ts";
import {
  firstRunScanCutoffDate,
  logCatchupCursorFilename,
  logCatchupCursorPath,
  LOG_CATCHUP_FIRST_RUN_WINDOW_DATES,
  LOG_CATCHUP_WINDOW_DATES,
} from "../../hooks/lib/log-cursor-state.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "log-catchup.ts",
);
const NOW = "2026-10-17T10:00:00Z";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-catchup-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-catchup-cfg-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

/** The flag-on environment for the agent the lane runs as. */
function flagOn(self: string | null): Record<string, string> {
  const env: Record<string, string> = {
    OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true",
    VAULT_DIR: vault,
  };
  if (self !== null) env["VAULT_AGENT_NAME"] = self;
  return env;
}

const SESSION_START = { hook_event_name: "SessionStart" };

interface InjectedPayload {
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
  };
}

/** The additionalContext of a run that emitted, or null when silent. */
function emitted(run: RunResult): string | null {
  if (run.stdout.trim().length === 0) return null;
  const payload = JSON.parse(run.stdout) as InjectedPayload;
  return payload.hookSpecificOutput?.additionalContext ?? null;
}

/** Append one note-kind event for `agent`, pinned to the legacy un-sharded pair by default. */
function seed(
  agent: string,
  text: string,
  opts: { timestamp?: string; deviceId?: string } = {},
): void {
  appendLogEvent(
    vault,
    {
      timestamp: opts.timestamp ?? NOW,
      eventType: BRAIN_LOG_EVENT_KIND.note,
      agent,
      body: { text },
    },
    { deviceId: opts.deviceId ?? "" },
  );
}

/** Byte fingerprint of every file under `Brain/log`, for the pure-read pin. */
function logFingerprint(): string {
  const root = join(vault, "Brain", "log");
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else parts.push(`${abs}:${statSync(abs).size}:${readFileSync(abs, "utf8")}`);
    }
  };
  if (existsSync(root)) walk(root);
  return parts.join("\u0000");
}

/** The cursor file for one identity on this vault (the hook's own path rule). */
function cursorPath(identity = "agent-b"): string {
  return logCatchupCursorPath(vault, identity);
}

describe("log-catchup hook (SessionStart)", () => {
  test("flag off is an immediate no-op with zero output and no cursor", async () => {
    seed("agent-a", "did the thing");
    const r = await runHook(SESSION_START, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(cursorPath())).toBe(false);
  });

  test("hands agent B exactly agent A's lines since B's cursor, self lines filtered", async () => {
    seed("agent-a", "agent a did the first thing");
    seed("agent-b", "agent b wrote this one itself");
    seed("agent-a", "agent a did the second thing");

    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const context = emitted(r);
    expect(context).not.toBeNull();
    // Only the other agent's lines, framed as untrusted content.
    expect(context).toContain("untrusted_source");
    expect(context).toContain("agent a did the first thing");
    expect(context).toContain("agent a did the second thing");
    expect(context).not.toContain("agent b wrote this one itself");
    expect(context).toContain("agent-a");
  });

  test("the log is byte-identical after every run - the lane is a pure read", async () => {
    seed("agent-a", "before the run");
    const before = logFingerprint();
    await runHook(SESSION_START, flagOn("agent-b"));
    expect(logFingerprint()).toBe(before);
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(logFingerprint()).toBe(before);
    expect(emitted(second)).toBeNull();
  });

  test("a second run with no new lines emits nothing", async () => {
    seed("agent-a", "once");
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    const again = await runHook(SESSION_START, flagOn("agent-b"));
    expect(again.exit).toBe(0);
    expect(again.stdout).toBe("");
  });

  test("the cursor survives as a (date, shardId, line) watermark in the derived store", async () => {
    seed("agent-a", "watermark me");
    await runHook(SESSION_START, flagOn("agent-b"));
    const raw = readFileSync(cursorPath(), "utf8");
    const cursor = JSON.parse(raw) as {
      date: string;
      shardId: string;
      line: number;
      shards: Record<string, number>;
    };
    expect(cursor.date).toBe(NOW.slice(0, 10));
    expect(cursor.shardId).toBe("");
    expect(cursor.line).toBe(0);
    expect(cursor.shards[""]).toBe(0);
  });

  test("an over-long foreign line renders truncated and shorter lines still show", async () => {
    // neutralizeSingleLine does not bound length, so one untrusted
    // 10k-char line would blow the whole block budget; the char-cap trim
    // loop peels oldest-first, drops every shorter line, then cannot fit
    // the long one either - the lane goes silent forever and the frozen
    // cursor rescans the same history every session. A per-line cap must
    // keep every rendered line fittable.
    seed("agent-a", "a short line that must survive");
    const hugeText = `huge ${"x".repeat(10000)}`;
    seed("agent-a", hugeText, { timestamp: "2026-10-17T10:01:00Z" });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("a short line that must survive");
    // The long line shows its head, truncated under the per-line cap -
    // never the full 10k characters.
    expect(context).toContain("huge xxxxxxxxxxxxxxxxxxxx");
    expect(context).not.toContain(hugeText);
    expect(context).not.toContain("x".repeat(600));
    // The watermark still covers both scanned lines.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      shards: Record<string, number>;
    };
    expect(cursor.shards[""]).toBe(1);
  });

  test("a solo agent's silent run still advances the cursor", async () => {
    // Every scanned line is self-authored, so nothing is collected and
    // nothing may be emitted - but the scan DID advance past lines. If
    // the watermark is not parked, every SessionStart rescans the whole
    // history from the beginning, forever.
    seed("agent-b", "my own first line");
    seed("agent-b", "my own second line");
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(first.exit).toBe(0);
    expect(first.stdout).toBe("");
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      date: string;
      shards: Record<string, number>;
    };
    expect(cursor.date).toBe(NOW.slice(0, 10));
    expect(cursor.shards[""]).toBe(1);
    // The second run then scans nothing new and stays silent.
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("a shard named like an Object.prototype member still gets a cursor", async () => {
    // DEVICE_ID_RE admits lowercase names such as "constructor" and
    // "valueOf"; shard-keyed plain objects inherit those members, so the
    // mark for such a shard silently becomes a function and the cursor
    // write fails validation - the lane goes silent and rescans forever.
    seed("agent-a", "a line from the constructor shard", { deviceId: "constructor" });
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(emitted(first)).not.toBeNull();
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      shards: Record<string, number>;
    };
    expect(cursor.shards["constructor"]).toBe(0);
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toBeNull();
  });

  test("a backfilled line with an earlier timestamp still surfaces and marks its true file index", async () => {
    // A shard whose timestamps go backwards (backfill, clock skew) does
    // not merge in file order, so an index COUNTED in merge order does
    // not name the entry's position in the file. The watermark must ride
    // the true per-shard file index, or this backfill - file line 1 but
    // merge-first at 10:03 - reads as "line 0, already seen" and is lost.
    seed("agent-a", "the on-time line", { timestamp: "2026-10-17T10:05:00Z" });
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(emitted(first)).not.toBeNull();
    seed("agent-a", "the backfilled line", { timestamp: "2026-10-17T10:03:00Z" });
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    const context = emitted(second);
    expect(context).not.toBeNull();
    expect(context).toContain("the backfilled line");
    // The mark carries the true file index of the backfill, not the
    // merge-order count.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      shards: Record<string, number>;
    };
    expect(cursor.shards[""]).toBe(1);
  });

  test("each identity on one vault keeps its own cursor", async () => {
    // Several runtimes share a device and a vault but carry different
    // VAULT_AGENT_NAMEs; a vault-wide cursor would let whichever runs
    // first advance the watermark past lines the others never saw.
    seed("agent-a", "a line meant for agent b");
    seed("agent-c", "a line meant for agent a");
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    expect(existsSync(cursorPath("agent-b"))).toBe(true);
    // Agent b's cursor must not speak for agent a: no file yet, and the
    // line addressed to a is still there when a's turn comes.
    expect(existsSync(cursorPath("agent-a"))).toBe(false);
    const asA = await runHook(SESSION_START, flagOn("agent-a"));
    const contextA = emitted(asA);
    expect(contextA).not.toBeNull();
    expect(contextA).toContain("a line meant for agent a");
    expect(existsSync(cursorPath("agent-a"))).toBe(true);
  });

  test("a legacy vault-wide cursor file is ignored, and the identity file replaces it", async () => {
    // Lenient migration: the pre-identity file named what SOME identity
    // on this device last saw, so reading it could hide lines from the
    // identity now asking. A fresh start replays history under the
    // lane's caps instead of risking that silence.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(cursorPath()), { recursive: true });
    writeFileSync(
      cursorPath().replace(/log-catchup\.[^/]*\.cursor\.json$/, "log-catchup.cursor.json"),
      JSON.stringify({
        date: NOW.slice(0, 10),
        shardId: "",
        line: 99,
        shards: { "": 99 },
      }),
      "utf8",
    );
    seed("agent-a", "buried by the legacy watermark if it were read");
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("buried by the legacy watermark if it were read");
    expect(existsSync(cursorPath("agent-b"))).toBe(true);
  });

  test("two identities the sanitizer collides get distinct cursor files", () => {
    // The `[^A-Za-z0-9._-] -> _` rule alone is not one-to-one: "agent b",
    // "agent/b" and "agent_b" all sanitize to "agent_b", and one would
    // read the other's watermark. The file name therefore carries a short
    // digest of the RAW identity beside the sanitized form.
    const a = logCatchupCursorFilename("agent b");
    const b = logCatchupCursorFilename("agent/b");
    const c = logCatchupCursorFilename("agent_b");
    for (const name of [a, b, c]) {
      expect(name).toMatch(/^log-catchup\.agent_b-[0-9a-f]{8}\.cursor\.json$/);
    }
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("an identity name that could traverse is sanitized in the cursor file name", async () => {
    seed("agent-a", "a line under a hostile identity");
    const hostile = await runHook(SESSION_START, flagOn("../../evil"));
    expect(hostile.exit).toBe(0);
    expect(emitted(hostile)).not.toBeNull();
    // The written cursor stays inside the derived store under the
    // sanitized name; nothing escaped the vault directory.
    expect(existsSync(cursorPath("../../evil"))).toBe(true);
    const escaped = readdirSync(join(vault, DERIVED_STORE_DIR)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(escaped).toEqual([logCatchupCursorFilename("../../evil")]);
  });

  test("a shard that syncs in late for an earlier date still surfaces", async () => {
    // Cross-device sync delay is the NORMAL case: yesterday's shard can
    // land after the cursor already moved to today. A date-level skip
    // would drop it forever; the skip decision must be per (date, shard)
    // against the windowed marks.
    seed("agent-a", "yesterdays early line", {
      timestamp: "2026-10-16T09:00:00Z",
      deviceId: "dev-a",
    });
    seed("agent-a", "todays line", { timestamp: "2026-10-17T09:00:00Z", deviceId: "dev-a" });
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    seed("agent-a", "yesterdays late-synced line", {
      timestamp: "2026-10-16T10:00:00Z",
      deviceId: "dev-c",
    });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("yesterdays late-synced line");
    expect(context).not.toContain("yesterdays early line");
  });

  test("a shard that syncs in late for a date with no local file still surfaces", async () => {
    // The windowed marks only cover dates that HAD files when the cursor
    // last parked, but the window itself is a range of calendar dates:
    // one device can own a whole day whose shard reaches this device
    // only after the cursor already moved past it. Keying the date skip
    // on the recorded `days` marks (instead of the calendar window)
    // would drop that day's lines forever - the normal cross-device
    // case the lane exists for.
    seed("agent-a", "todays line", { timestamp: "2026-10-17T09:00:00Z", deviceId: "dev-a" });
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    seed("agent-a", "late shard for a day that had no local file", {
      timestamp: "2026-10-16T09:00:00Z",
      deviceId: "dev-c",
    });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("late shard for a day that had no local file");
    expect(context).not.toContain("todays line");
  });

  test("a future-dated foreign line does not park the cursor past today", async () => {
    // A foreign writer can stamp a log file with a future date. The scan
    // must still read and surface it, but the watermark must never park
    // on a date beyond today: parked at the skew, every real date under
    // it reads as already-seen and the lane goes silent for exactly the
    // days it exists for, until the clock catches up. The skew rides the
    // clock, not a constant, so the test cannot age into a real date.
    const skew = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    seed("agent-a", "a line stamped in the future", { timestamp: `${skew}T09:00:00Z` });
    seed("agent-a", "todays real line");
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(first.exit).toBe(0);
    // The scan still reads the future-dated file: the line surfaces.
    expect(emitted(first)).toContain("a line stamped in the future");
    // The watermark parked on a real date - the newest one the log
    // actually carries - never on the skew.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as { date: string };
    expect(cursor.date <= new Date().toISOString().slice(0, 10)).toBe(true);

    // A line landing later on a real date between today and the skew
    // must still surface instead of reading as covered by the parked
    // cursor.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    seed("agent-a", "tomorrows real line", { timestamp: `${tomorrow}T09:00:00Z` });
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toContain("tomorrows real line");
  });

  test("a future-skewed foreign line shows once, not again before the clock reaches its date", async () => {
    // The clamp parks the cursor on a date of today or earlier, so a
    // foreign line stamped with a future date stays newest in merge order
    // and past the cursor for the whole skew period - without marks for
    // the future dates, every SessionStart re-renders the skew line and
    // it eats the block budget every run. The cursor must record the
    // per-(date, shard) marks of the future dates it scanned, so a skewed
    // line is shown once; a line appended later to the still-future date
    // is past that shard's mark and surfaces normally.
    const skew = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    seed("agent-a", "todays real line");
    seed("agent-a", "a line stamped in the future", { timestamp: `${skew}T09:00:00Z` });
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(first.exit).toBe(0);
    expect(emitted(first)).toContain("a line stamped in the future");

    // The clock is still short of the skew: the line must not reshow.
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toBeNull();

    // A second line on the still-future date is past the shard's mark.
    seed("agent-a", "a second line in the future", { timestamp: `${skew}T10:00:00Z` });
    const third = await runHook(SESSION_START, flagOn("agent-b"));
    expect(third.exit).toBe(0);
    expect(emitted(third)).toContain("a second line in the future");
    expect(emitted(third)).not.toContain("a line stamped in the future");
  });

  test("a first run with no cursor scans only the recent window and counts the older days honestly", async () => {
    // The one unbounded scan left: with no cursor yet, the lane used to
    // walk the WHOLE history - on a vault with years of daily log, the
    // first SessionStart parsed every day only to render the newest 50
    // lines. A first run now scans a bounded recent window and reports
    // the rest as an honest count, instead of quietly parsing history
    // no one will read or, worse, re-listing every shard per date.
    for (const d of ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]) {
      seed("agent-a", `old history line from ${d}`, { timestamp: `${d}T09:00:00Z` });
    }
    seed("agent-a", "a recent line the window still reaches", {
      timestamp: "2026-10-17T09:00:00Z",
    });

    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    // The recent tail surfaces; the unscanned history does not ride
    // along (under the line cap it would, on a vault whose whole
    // history fits the block).
    expect(context).toContain("a recent line the window still reaches");
    expect(context).not.toContain("old history line");
    // The unscanned days are reported, not silently dropped.
    expect(context).toContain("5 older day(s) not scanned");
    // The run still parks the cursor, so the lane starts where it left
    // off next time instead of re-deciding the window.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      date: string;
      shards: Record<string, number>;
    };
    expect(cursor.date).toBe("2026-10-17");
    expect(cursor.shards[""]).toBe(0);
    // And a second run stays silent: nothing new since the park.
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toBeNull();
  });

  test("a first run with nothing foreign to show still reports the unscanned days", async () => {
    // The unscanned-day count used to surface only inside a rendered
    // block: a first run whose every window line is the reader's own
    // collected nothing, emitted nothing, parked the cursor - and the
    // older days were dropped forever, never reported. A header-only
    // block carries the count instead, exactly once: the park below is
    // what keeps the next session silent.
    for (const d of ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]) {
      seed("agent-b", `self-authored old history from ${d}`, { timestamp: `${d}T09:00:00Z` });
    }
    seed("agent-b", "my own recent line", { timestamp: "2026-10-17T09:00:00Z" });

    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("5 older day(s) not scanned");
    expect(context).toContain("0 log line(s)");
    expect(context).not.toContain("self-authored old history");
    // One honest report, not a per-session nag: the cursor parked.
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toBeNull();
  });

  test("a first run whose window holds nothing parseable stays silent", async () => {
    // The header-only report rode on the park that follows it - but a
    // window whose newest shard parses to zero entries parks nothing:
    // lastSeen never moves, the cursor is never written, and every
    // SessionStart repeated the block over the same unscanned days. The
    // report fires only when the cursor will actually be written, so a
    // vault whose readable history all sits outside the window stays
    // silent instead of nagging, and reports once the moment a scan
    // actually advances the watermark.
    for (const d of ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]) {
      seed("agent-a", `foreign history from ${d}`, { timestamp: `${d}T09:00:00Z` });
    }
    // The newest date in the log is real but unreadable: the shard the
    // first-run window scans holds no parseable line at all.
    writeFileSync(join(vault, "Brain", "log", "2026-10-17.jsonl"), "not json at all\n", "utf8");

    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(first.exit).toBe(0);
    expect(emitted(first)).toBeNull();
    expect(existsSync(cursorPath())).toBe(false);
    // The silence holds: the second run sees the same vault, and the
    // block does not come back.
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    expect(emitted(second)).toBeNull();
    expect(existsSync(cursorPath())).toBe(false);
  });

  test("the header names the recent window on a first run, the last read after it", async () => {
    // "Since your last read" names a read that never happened on a first
    // run: with no cursor there is no last look, and the lower bound is
    // the first-run window, not a watermark.
    seed("agent-a", "a line for the first run");
    const first = await runHook(SESSION_START, flagOn("agent-b"));
    expect(first.exit).toBe(0);
    const firstContext = emitted(first);
    expect(firstContext).not.toBeNull();
    expect(firstContext).toContain("in the recent window");
    expect(firstContext).not.toContain("since your last read");

    // Once the cursor exists the bound really is the last read.
    seed("agent-a", "a line for the second run");
    const second = await runHook(SESSION_START, flagOn("agent-b"));
    expect(second.exit).toBe(0);
    const secondContext = emitted(second);
    expect(secondContext).not.toBeNull();
    expect(secondContext).toContain("since your last read");
    expect(secondContext).not.toContain("in the recent window");
  });

  test("a date evicted from the window is still skipped whole", async () => {
    // Six dates: the cursor keeps per-shard marks for the newest three
    // before its date, so 10-10 and 10-13 are evicted - and a brand-new
    // line on an evicted date is not chased, which bounds how far back a
    // delayed sync can resurface.
    const dates = [
      "2026-10-10",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
    ];
    for (const d of dates) {
      seed("agent-a", `line on ${d}`, { timestamp: `${d}T09:00:00Z` });
    }
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      days: Record<string, Record<string, number>>;
    };
    expect(Object.keys(cursor.days).toSorted()).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    seed("agent-a", "a line on the evicted date", { timestamp: "2026-10-10T10:00:00Z" });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    expect(emitted(r)).toBeNull();
  });

  test("the cursor keeps per-shard marks for at most the previous three dates", async () => {
    for (let d = 10; d <= 17; d++) {
      seed("agent-a", `day ${d} line`, { timestamp: `2026-10-${d}T09:00:00Z` });
    }
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      date: string;
      days: Record<string, Record<string, number>>;
    };
    expect(cursor.date).toBe("2026-10-17");
    const window = Object.keys(cursor.days).toSorted();
    expect(window.length).toBeLessThanOrEqual(3);
    for (const d of window) expect(d < cursor.date).toBe(true);
    // The newest three older dates are exactly the ones kept.
    expect(window).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
  });

  test("a same-second line in a different shard is not skipped", async () => {
    // Run 1's cursor must sit on the HIGHER-sorting shard for this test
    // to exercise the interleaving: the dev-z line parks the cursor at
    // shard "dev-z", then run 2's dev-a line lands at the same second,
    // so the merge order places it BEFORE the cursor tuple. A bare
    // (date, shardId, line) comparison would call it already seen and
    // skip it; only the per-shard marks - "dev-a" has no mark yet -
    // admit it.
    seed("agent-a", "first device line", { deviceId: "dev-z" });
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    seed("agent-a", "same-second line from another shard", { deviceId: "dev-a" });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("same-second line from another shard");
  });

  test("more than the per-lane cap shows the newest lines plus an older count", async () => {
    for (let i = 0; i < 55; i++) {
      seed("agent-a", `catch-up line number ${String(i).padStart(2, "0")}`, {
        timestamp: `2026-10-17T10:${String(i).padStart(2, "0")}:00Z`,
      });
    }
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    // The newest 50 survive; the 5 oldest are counted, not rendered.
    expect(context).toContain("catch-up line number 54");
    expect(context).toContain("catch-up line number 05");
    expect(context).not.toContain("catch-up line number 04");
    expect(context).toContain("5 older");
  });

  test("the char cap drops the oldest lines first and the cursor still covers every scanned line", async () => {
    // Fourteen long lines whose rendered block (each truncated to the
    // per-line cap) still blows past LOG_CATCHUP_MAX_CHARS: the trim
    // loop must peel the oldest lines off the front, count each as
    // older, and still advance the watermark past every line it
    // scanned - trimming the render must not freeze the cursor, or the
    // dropped lines would resurface next session.
    for (let i = 0; i < 14; i++) {
      seed("agent-a", `charcap line ${i} ${"x".repeat(1500)}`, {
        timestamp: `2026-10-17T10:${String(i).padStart(2, "0")}:00Z`,
      });
    }
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    // Oldest dropped first: the front of the scan is gone, the newest
    // line survives. (Pin the dropped lines with their first x so the
    // substring cannot match the two-digit line numbers.)
    expect(context).not.toContain("charcap line 0 x");
    expect(context).not.toContain("charcap line 1 x");
    expect(context).toContain("charcap line 13");
    // Any "older" count in the header is the char-trim loop's own work
    // (the line cap alone would have shown all 14).
    const older = context?.match(/\((\d+) older not shown\)/);
    expect(older).not.toBeNull();
    expect(Number(older![1])).toBeGreaterThanOrEqual(1);
    // The watermark advanced past ALL scanned lines despite the trim.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      line: number;
      shards: Record<string, number>;
    };
    expect(cursor.line).toBe(13);
    expect(cursor.shards[""]).toBe(13);
  });

  test("a missing or corrupt cursor fails soft and the lane still exits 0", async () => {
    seed("agent-a", "read me despite the broken cursor");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(cursorPath()), { recursive: true });
    writeFileSync(cursorPath(), "{ not json", "utf8");
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("read me despite the broken cursor");
  });

  test("self identity falls back to the device id when no agent name is configured", async () => {
    seed("dev-b", "the device's own line");
    seed("agent-a", "someone else's line");
    const r = await runHook(SESSION_START, {
      OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true",
      VAULT_DIR: vault,
      O2B_DEVICE_ID: "dev-b",
    });
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("someone else's line");
    expect(context).not.toContain("the device's own line");
  });

  test("device fallback filters own lines by shard when the writer stamped the placeholder agent", async () => {
    // The writer-realistic shape: an unconfigured install stamps the
    // payload `agent` with the `resolveAgentName` placeholder ("agent")
    // and puts its device id in the shard name - the payload never
    // carries the device id. Fallback authorship must therefore be read
    // off the shard (the shard id IS the device id), or the install
    // replays its own lines back as cross-agent catch-up.
    seed("agent", "the device's own writer-realistic line", { deviceId: "dev-b" });
    seed("agent-a", "a genuinely other agent's line", { deviceId: "dev-c" });
    const r = await runHook(SESSION_START, {
      OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true",
      VAULT_DIR: vault,
      O2B_DEVICE_ID: "dev-b",
    });
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("a genuinely other agent's line");
    expect(context).not.toContain("the device's own writer-realistic line");
  });

  test("a configured agent name stays the identity even across device shards", async () => {
    // When an agent name is configured it is the identity: a same-name
    // line from another device's shard is still self, and the shard id
    // is not consulted at all.
    seed("agent-b", "my own line from another device", { deviceId: "dev-other" });
    seed("agent-a", "another agent's cross-device line", { deviceId: "dev-other" });
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("another agent's cross-device line");
    expect(context).not.toContain("my own line from another device");
  });

  test("agent identity compares trimmed on both sides", async () => {
    // The configured name can arrive padded through the env and the
    // entry attribution padded through the log; both sides must
    // normalize before the comparison or the agent's own line reads as
    // foreign.
    seed(" agent-b ", "my paddedly attributed line");
    seed("agent-a", "someone else's plainly attributed line");
    const r = await runHook(SESSION_START, flagOn("  agent-b  "));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    expect(context).toContain("someone else's plainly attributed line");
    expect(context).not.toContain("my paddedly attributed line");
  });

  test("an event that cannot carry additionalContext gets nothing", async () => {
    seed("agent-a", "quiet on this event");
    const r = await runHook({ hook_event_name: "PostToolUse" }, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(cursorPath())).toBe(false);
  });

  test("no vault resolves to silence", async () => {
    const r = await runHook(SESSION_START, { OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true" });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("first-run scan window", () => {
  test("a no-cursor run scans only the first-run window behind the newest real date", () => {
    // The window rides the NEWEST date in the log that is today or
    // earlier, not today itself: a vault whose newest entry is months
    // old still catches up on its own recent tail instead of reporting
    // its whole history unscanned. The +2 slack over the cursor window
    // keeps the first run's reach a superset of what a parked cursor
    // would still rescan.
    expect(LOG_CATCHUP_FIRST_RUN_WINDOW_DATES).toBe(LOG_CATCHUP_WINDOW_DATES + 2);
    const dates = [
      "2026-01-05",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-10-17",
    ];
    expect(firstRunScanCutoffDate(dates, "2026-10-18")).toBe("2026-10-12");
    // The boundary is inclusive: a date exactly on the cutoff scans.
    expect(firstRunScanCutoffDate(["2026-10-12"], "2026-10-18")).toBe("2026-10-07");
    // A future-skewed newest date must not widen the window past every
    // real day - the reference clamps to the newest date of today or
    // earlier, the watermark parking clamp again.
    expect(firstRunScanCutoffDate([...dates, "2026-12-02"], "2026-10-18")).toBe("2026-10-12");
    // Every date future: the reference falls back to today, so the skew
    // lines still surface instead of reading as unscanned history.
    expect(firstRunScanCutoffDate(["2026-12-02"], "2026-10-18")).toBe("2026-10-13");
    // An empty log has no window and no cutoff.
    expect(firstRunScanCutoffDate([], "2026-10-18")).toBeNull();
  });
});
