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

function cursorPath(): string {
  return join(vault, DERIVED_STORE_DIR, "log-catchup.cursor.json");
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

  test("a same-second line in a different shard is not skipped", async () => {
    seed("agent-a", "first device line");
    expect(emitted(await runHook(SESSION_START, flagOn("agent-b")))).not.toBeNull();
    // Another device's shard lands a line at the SAME second after B's
    // cursor was written. The per-shard high-water marks must admit it:
    // the merge order interleaves shards, so a bare tuple would drop it.
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
