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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { DERIVED_STORE_DIR } from "../../src/core/brain/path-constants.ts";
import { logCatchupCursorPath } from "../../hooks/lib/log-cursor-state.ts";
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
    const { mkdirSync, writeFileSync } = await import("node:fs");
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

  test("an identity name that could traverse is sanitized in the cursor file name", async () => {
    seed("agent-a", "a line under a hostile identity");
    const hostile = await runHook(SESSION_START, flagOn("../../evil"));
    expect(hostile.exit).toBe(0);
    expect(emitted(hostile)).not.toBeNull();
    // The written cursor stays inside the derived store under the
    // sanitized name; nothing escaped the vault directory.
    expect(existsSync(cursorPath(".._.._evil"))).toBe(true);
    const escaped = readdirSync(join(vault, DERIVED_STORE_DIR)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(escaped).toEqual(["log-catchup..._.._evil.cursor.json"]);
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
    // Eight well-under-the-line-cap lines whose rendered block blows
    // past LOG_CATCHUP_MAX_CHARS: the trim loop must peel the oldest
    // lines off the front, count each as older, and still advance the
    // watermark past every line it scanned - trimming the render must
    // not freeze the cursor, or the dropped lines would resurface next
    // session.
    for (let i = 0; i < 8; i++) {
      seed("agent-a", `charcap line ${i} ${"x".repeat(1500)}`, {
        timestamp: `2026-10-17T10:0${i}:00Z`,
      });
    }
    const r = await runHook(SESSION_START, flagOn("agent-b"));
    expect(r.exit).toBe(0);
    const context = emitted(r);
    expect(context).not.toBeNull();
    // Oldest dropped first: the front of the scan is gone, the newest
    // line survives.
    expect(context).not.toContain("charcap line 0");
    expect(context).not.toContain("charcap line 1");
    expect(context).not.toContain("charcap line 4");
    expect(context).toContain("charcap line 7");
    // The line cap alone would have shown all 8, so any "older" count
    // in the header is the char-trim loop's own growth.
    const older = context?.match(/\((\d+) older not shown\)/);
    expect(older).not.toBeNull();
    expect(Number(older![1])).toBeGreaterThanOrEqual(1);
    // The watermark advanced past ALL scanned lines despite the trim.
    const cursor = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      line: number;
      shards: Record<string, number>;
    };
    expect(cursor.line).toBe(7);
    expect(cursor.shards[""]).toBe(7);
  });

  test("a missing or corrupt cursor fails soft and the lane still exits 0", async () => {
    seed("agent-a", "read me despite the broken cursor");
    const { mkdirSync, writeFileSync } = await import("node:fs");
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
