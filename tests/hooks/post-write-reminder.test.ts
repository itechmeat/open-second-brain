import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "post-write-reminder.ts",
);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hook-post-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

describe("post-write-reminder hook", () => {
  test("emits additionalContext for Claude Code Write", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/foo.md", content: "hello" },
    });
    expect(r.exit).toBe(0);
    // Line-oriented runtimes (stream-json on Claude Code) parse hook
    // stdout line-by-line, so the terminator is part of the contract.
    expect(r.stdout.endsWith("\n")).toBe(true);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("`Write`");
    expect(out.hookSpecificOutput.additionalContext).toContain("/tmp/foo.md");
    expect(out.hookSpecificOutput.additionalContext).toContain("brain_feedback");
    expect(out.hookSpecificOutput.additionalContext).toContain("brain_apply_evidence");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("event_log_append");
  });

  test("emits additionalContext for Codex apply_patch with patch body", async () => {
    const patch =
      "*** Begin Patch\n*** Update File: /srv/projects/x/src/index.ts\n@@\n-foo\n+bar\n*** End Patch\n";
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("apply_patch");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "/srv/projects/x/src/index.ts",
    );
  });

  test("stays silent when Claude's tool_response reports an error", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/foo.md", old_string: "x", new_string: "y" },
      tool_response: { is_error: true, error: "old_string not found" },
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when tool_response.success === false", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/foo.md", content: "hi" },
      tool_response: { success: false },
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent for non-artifact tools", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent on empty payload", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });
});
