/**
 * The delegation boundary the host already delivers (U7 / t_0c6f31ee).
 *
 * Three defects this suite exists to catch:
 *
 *   - `SubagentStop` is in the host's official event list and
 *     `hooks/hooks.json` registered seven events without it, so the one
 *     event that names a delegation boundary was never delivered anywhere.
 *   - The delegated identity the event carries (`agent_id`) was not
 *     normalised, so a sub-agent's lifecycle observation was attributed to
 *     the session's own agent and the roster could not tell the two apart.
 *   - `tool_response` is declared on the hook payload and was lifted past
 *     by the lifecycle normaliser, so a `brain_feedback` call the host
 *     reported as FAILED was still replayed into a signal - a record for a
 *     write that never happened.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { captureSessionLifecycleEvent } from "../../src/core/brain/session-lifecycle.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS_JSON = join(REPO, "hooks", "hooks.json");
const HOOK = join(REPO, "hooks", "session-capture.ts");

/** The event name the host fires when a delegated sub-agent finishes. */
const SUBAGENT_STOP = "SubagentStop";
/** A delegated agent id in the shape the host delivers it. */
const AGENT_ID = "7f3c21ab-9d40-4c6e-8b21-0e5c7a1d33f2";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-subagent-stop-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-subagent-stop-home-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function runHook(
  payload: unknown,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: configHome,
      VAULT_DIR: vault,
      VAULT_AGENT_NAME: "claude-vps-agent",
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exit: await proc.exited };
}

function logBodies(root: string): string {
  const dir = join(root, "Brain", "log");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("hooks.json — SubagentStop registration", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };

  test("registers the delegation boundary alongside Stop", () => {
    const groups = parsed.hooks[SUBAGENT_STOP];
    expect(groups).toBeDefined();
    expect(groups!.length).toBeGreaterThan(0);
    const commands = groups!.flatMap((group) => group.hooks.map((h) => h.command));
    expect(commands.some((cmd) => cmd.includes("session-capture"))).toBe(true);
  });
});

describe("SubagentStop capture", () => {
  test("the hook records the event and stays silent to the runtime", async () => {
    const result = await runHook({
      hook_event_name: SUBAGENT_STOP,
      session_id: "delegation-session",
      agent_id: AGENT_ID,
      cwd: "/tmp",
      stop_hook_active: false,
    });

    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(logBodies(vault)).toContain(SUBAGENT_STOP);
  });

  test("the observation is attributed to the delegated identity", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: SUBAGENT_STOP,
        session_id: "delegation-session",
        agent_id: AGENT_ID,
      },
      { agent: "claude-vps-agent", now: new Date("2026-06-01T09:00:30Z") },
    );

    expect(result.event).toBe(SUBAGENT_STOP);
    expect(result.agent_id).toBe(AGENT_ID);
    const log = logBodies(vault);
    expect(log).toContain("claude-vps-agent-sub-7f3c21ab");
  });

  test("an ordinary Stop carries no delegated identity", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "Stop", session_id: "delegation-session" },
      { agent: "claude-vps-agent", now: new Date("2026-06-01T09:01:00Z") },
    );
    expect(result.agent_id).toBeUndefined();
    expect(logBodies(vault)).not.toContain("-sub-");
  });
});

describe("tool_response — carried, not dropped", () => {
  const feedback = {
    topic: "tool-response",
    signal: "positive",
    principle: "a failed tool call is not a record",
  };

  test("a failed brain_feedback call is not replayed as a signal", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "PostToolUse",
        session_id: "tool-response-session",
        tool_name: "brain_feedback",
        tool_input: feedback,
        tool_response: { is_error: true, content: "write refused" },
      },
      { agent: "claude-vps-agent", now: new Date("2026-06-01T10:00:00Z") },
    );

    expect(result.signals_created).toBe(0);
    expect(result.tool_replays).toBe(0);
    expect(result.malformed).toBe(0);
    expect(result.tool_calls_failed).toBe(1);
    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.endsWith(".md")),
    ).toHaveLength(0);
  });

  test("a successful call is replayed and reports no failure", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "PostToolUse",
        session_id: "tool-response-session",
        tool_name: "brain_feedback",
        tool_input: feedback,
        tool_response: { is_error: false },
      },
      { agent: "claude-vps-agent", now: new Date("2026-06-01T10:00:01Z") },
    );

    expect(result.signals_created).toBe(1);
    expect(result.tool_replays).toBe(1);
    expect(result.tool_calls_failed).toBeUndefined();
  });

  test("a call the host said nothing about is replayed exactly as before", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "PostToolUse",
        session_id: "tool-response-quiet",
        tool_name: "brain_feedback",
        tool_input: { ...feedback, topic: "tool-response-quiet" },
      },
      { agent: "claude-vps-agent", now: new Date("2026-06-01T10:00:02Z") },
    );

    expect(result.signals_created).toBe(1);
    expect(result.tool_calls_failed).toBeUndefined();
  });
});
