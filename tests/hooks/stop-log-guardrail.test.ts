import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STOP_GUARDRAIL_DEFERRED_TEXT, STOP_GUARDRAIL_TEXT } from "../../hooks/lib/messages.ts";
import { stopAdvisoryHandoverDir } from "../../hooks/lib/stop-advisory-handover.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
const HOOK = join(HOOKS_DIR, "stop-log-guardrail.ts");
const DELIVER = join(HOOKS_DIR, "stop-advisory-deliver.ts");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hook-stop-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(stopAdvisoryHandoverDir(), { recursive: true, force: true });
});

function ccUser(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function ccAssistantToolUse(name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_" + name, name, input }],
    },
  });
}

function writeTranscript(lines: readonly string[]): string {
  const path = join(tmp, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(
  payload: unknown,
  envOverrides: Record<string, string> = {},
  hook: string = HOOK,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", hook], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Bun hands a child without `env` the environment this process STARTED
    // with, not the live `process.env`: pass it so the child sees the
    // throwaway config tests/setup.ts installs, not the operator's real one.
    env: { ...process.env, ...envOverrides },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

/** A Claude Code transcript under `.claude/projects` with one Write. */
function claudeTranscript(): string {
  // Reuse the per-test `tmp` so afterEach cleans this up too.
  const transcript_path = join(tmp, ".claude", "projects", "session.jsonl");
  mkdirSync(dirname(transcript_path), { recursive: true });
  writeFileSync(
    transcript_path,
    [ccUser("write something"), ccAssistantToolUse("Write", { file_path: "/tmp/x.md" })].join(
      "\n",
    ) + "\n",
  );
  return transcript_path;
}

describe("stop-log-guardrail hook", () => {
  test("blocks once when artifact was produced and no brain event was recorded", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    const out = JSON.parse(r.stdout);
    // An unrecognised runtime gets the portable one-line block.
    expect(out).toEqual({ decision: "block", reason: STOP_GUARDRAIL_TEXT });
    // §32 (v0.10.8): event_log_append must not appear in the guardrail
    // body — the tool is retired across every runtime.
    expect(out.reason).not.toContain("event_log_append");
  });

  test("passes through when brain_feedback was called this turn", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      ccAssistantToolUse("brain_feedback", {
        topic: "x",
        signal: "positive",
        principle: "p",
      }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("passes through when brain_note was called this turn (§32B)", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      ccAssistantToolUse("brain_note", { text: "added /tmp/x.md" }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("passes through when no artifact was produced", async () => {
    const transcript_path = writeTranscript([
      ccUser("what's in the README?"),
      ccAssistantToolUse("Read", { file_path: "/tmp/README.md" }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("never blocks twice in a row (stop_hook_active === true)", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: true,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when transcript_path is missing", async () => {
    const r = await runHook({
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when transcript_path does not exist on disk", async () => {
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path: join(tmp, "missing.jsonl"),
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("passes through when the agent logged via Bash (`o2b brain feedback`)", async () => {
    const transcript_path = writeTranscript([
      ccUser("add a file and record a signal via bash"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_b",
              name: "Bash",
              input: {
                command: "o2b brain feedback --topic x --signal positive --principle p",
              },
            },
          ],
        },
      }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("blocks even when the deprecated `o2b append-event` bash needle is used (§32)", async () => {
    // §32 (v0.10.8) drops `o2b append-event` from the brain-event
    // detector. The CLI still works for humans / cron, but it no
    // longer suppresses the stop guardrail.
    const transcript_path = writeTranscript([
      ccUser("add a file and write the legacy log line"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_b",
              name: "Bash",
              input: { command: "o2b append-event 'added /tmp/x.md'" },
            },
          ],
        },
      }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
  });

  test("blocks even when the deprecated MCP-prefixed event_log_append is called (§32)", async () => {
    const transcript_path = writeTranscript([
      ccUser("add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      ccAssistantToolUse("mcp__plugin_open-second-brain_open-second-brain__event_log_append", {
        message: "added /tmp/x.md",
      }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
  });

  test("blocks for Codex apply_patch with no logging", async () => {
    const transcript_path = writeTranscript([
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "patch the file" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: "" },
      }),
    ]);
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
  });

  // Only this producer runs in these tests: the deliver hook must not wait
  // for a quote check that never starts.
  const ONLY_GUARDRAIL = { OPEN_SECOND_BRAIN_QUOTE_CHECK_ENABLED: "0" };

  const DEFERRED_STREAM =
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: STOP_GUARDRAIL_DEFERRED_TEXT,
      },
    }) + "\n";

  test("Claude Code: the synchronous hook prints nothing and the async deliver hook prints the deferred line once", async () => {
    const payload = {
      hook_event_name: "Stop",
      session_id: "sess-guardrail-1",
      prompt_id: "prompt-1",
      transcript_path: claudeTranscript(),
      stop_hook_active: false,
      last_assistant_message: "done",
    };
    // A synchronous Stop hook with no output shows nothing in the chat and
    // adds no turn; its line waits in the hand-over.
    const sync = await runHook(payload);
    expect(sync.exit).toBe(0);
    expect(sync.stdout).toBe("");
    // The exact stream Claude Code receives from the async entry: it hands
    // this additionalContext to the model with the next user message.
    const first = await runHook(payload, ONLY_GUARDRAIL, DELIVER);
    expect(first.exit).toBe(0);
    expect(first.stdout).toBe(DEFERRED_STREAM);
    const second = await runHook(payload, ONLY_GUARDRAIL, DELIVER);
    expect(second.stdout).toBe("");
  });

  test("a Claude Code Stop payload outside ~/.claude is handed over too", async () => {
    // A CLAUDE_CONFIG_DIR such as ~/.claude-work misses the path needle;
    // the Stop payload shape (stop_hook_active + last_assistant_message,
    // no Codex turn_id) still names the runtime.
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const payload = {
      hook_event_name: "Stop",
      session_id: "sess-guardrail-2",
      transcript_path,
      stop_hook_active: false,
      last_assistant_message: "done",
    };
    expect((await runHook(payload)).stdout).toBe("");
    expect((await runHook(payload, ONLY_GUARDRAIL, DELIVER)).stdout).toBe(DEFERRED_STREAM);
  });

  test("stop_advisory_delivery sync: the synchronous hook prints the line itself and nothing is handed over", async () => {
    const payload = {
      hook_event_name: "Stop",
      session_id: "sess-guardrail-3",
      transcript_path: claudeTranscript(),
      stop_hook_active: false,
      last_assistant_message: "done",
    };
    const env = { ...ONLY_GUARDRAIL, OPEN_SECOND_BRAIN_STOP_ADVISORY_DELIVERY: "sync" };
    const sync = await runHook(payload, env);
    // The form for one-shot `claude -p` runs: Claude Code prints it as
    // "Stop hook says: ..." and continues the turn once.
    expect(sync.stdout).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_GUARDRAIL_TEXT },
      }) + "\n",
    );
    expect((await runHook(payload, env, DELIVER)).stdout).toBe("");
  });

  test("a Claude Code payload with no session id falls back to the synchronous line", async () => {
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path: claudeTranscript(),
      stop_hook_active: false,
    });
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_GUARDRAIL_TEXT },
    });
  });

  test("stop_guardrail_enabled false in the machine config silences the hook", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, 'stop_guardrail_enabled: "false"\n');
    const r = await runHook(
      { hook_event_name: "Stop", transcript_path, stop_hook_active: false },
      { OPEN_SECOND_BRAIN_CONFIG: configPath, OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED: "" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED=0 silences the hook over a config that says on", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, 'stop_guardrail_enabled: "true"\n');
    const r = await runHook(
      { hook_event_name: "Stop", transcript_path, stop_hook_active: false },
      { OPEN_SECOND_BRAIN_CONFIG: configPath, OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED: "0" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("Codex transcript path gets the one-line block reason", async () => {
    // Reuse the per-test `tmp` so afterEach cleans this up too.
    const transcript_path = join(tmp, ".codex", "sessions", "session.jsonl");
    mkdirSync(dirname(transcript_path), { recursive: true });
    writeFileSync(
      transcript_path,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "patch the file" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "c1",
            input: "",
          },
        }),
      ].join("\n") + "\n",
    );
    const r = await runHook({
      hook_event_name: "Stop",
      transcript_path,
      stop_hook_active: false,
    });
    const out = JSON.parse(r.stdout);
    // Codex documents only decision/reason for Stop; the reason becomes the
    // continuation prompt, so it stays one line.
    expect(out).toEqual({ decision: "block", reason: STOP_GUARDRAIL_TEXT });
  });

  test("Grok Build payload gets the one-line block reason", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ]);
    const r = await runHook({
      hookEventName: "Stop",
      workspaceRoot: tmp,
      transcript_path,
      stop_hook_active: false,
    });
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: STOP_GUARDRAIL_TEXT });
  });
});

describe("STOP_GUARDRAIL_TEXT and STOP_GUARDRAIL_DEFERRED_TEXT", () => {
  test("each is one short line that names the three brain-event tools", () => {
    for (const text of [STOP_GUARDRAIL_TEXT, STOP_GUARDRAIL_DEFERRED_TEXT]) {
      expect(text).not.toContain("\n");
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text).toStartWith("Open Second Brain:");
      expect(text).not.toContain("!");
      for (const tool of ["brain_feedback", "brain_apply_evidence", "brain_note", "brain-memory"]) {
        expect(text).toContain(tool);
      }
    }
  });

  test("the deferred line names the previous turn, the continuation line this turn", () => {
    expect(STOP_GUARDRAIL_DEFERRED_TEXT).toContain("the previous turn");
    expect(STOP_GUARDRAIL_TEXT).toContain("this turn");
  });
});
