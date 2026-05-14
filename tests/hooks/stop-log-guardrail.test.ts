import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "stop-log-guardrail.ts",
);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hook-stop-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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

async function runHook(payload: unknown): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

describe("stop-log-guardrail hook", () => {
  test("blocks once when artifact was produced and no log was called", async () => {
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
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("event_log_append");
  });

  test("passes through when log was called this turn", async () => {
    const transcript_path = writeTranscript([
      ccUser("please add a file"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
      ccAssistantToolUse("event_log_append", { message: "added /tmp/x.md" }),
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

  test("passes through when the agent logged via Bash (`o2b append-event`)", async () => {
    const transcript_path = writeTranscript([
      ccUser("add a file and log it via bash"),
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
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("passes through when the Claude MCP-prefixed event_log_append is called", async () => {
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
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
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
});
