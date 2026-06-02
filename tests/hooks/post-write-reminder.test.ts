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
    expect(out.hookSpecificOutput.additionalContext).toContain("/srv/projects/x/src/index.ts");
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

  test("Claude Code transcript path triggers the claudecode cadence line", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/foo.md", content: "hi" },
      transcript_path: "/Users/x/.claude/projects/-srv/foo.jsonl",
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("Claude Code session");
  });

  test("Codex apply_patch shape triggers the codex cadence line", async () => {
    const patch = "*** Begin Patch\n*** Update File: /tmp/x\n*** End Patch\n";
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("codex exec");
  });

  test("unknown runtime renders without either cadence line (v0.10.4 baseline)", async () => {
    const r = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/foo.md", content: "hi" },
      // No transcript_path, no Claude triple, no apply_patch shape.
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    const text = out.hookSpecificOutput.additionalContext as string;
    expect(text).not.toContain("Claude Code session");
    expect(text).not.toContain("codex exec");
    // Spot-check the original body is intact.
    expect(text).toContain("brain_feedback");
    expect(text).toContain("brain_apply_evidence");
  });
});

// ── Session cadence (token-diet, t_9cc4f400) ────────────────────────────────

async function runHookEnv(payload: unknown, env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

const claudePayload = (file: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: file, content: "hi" },
  transcript_path: "/Users/x/.claude/projects/-srv/foo.jsonl",
  session_id: "sess-cadence-1",
});

describe("post-write-reminder session cadence", () => {
  test("first Claude Code write gets the full reminder, later writes a short nudge", async () => {
    const stateDir = join(tmp, "markers");
    const env = { O2B_REMINDER_STATE_DIR: stateDir };

    const first = await runHookEnv(claudePayload("/tmp/a.md"), env);
    const firstText = JSON.parse(first.stdout).hookSpecificOutput.additionalContext as string;
    expect(firstText).toContain("Trivial edits");

    const second = await runHookEnv(claudePayload("/tmp/b.md"), env);
    const secondText = JSON.parse(second.stdout).hookSpecificOutput.additionalContext as string;
    expect(secondText).not.toContain("Trivial edits");
    expect(secondText.length).toBeLessThanOrEqual(200);
    expect(secondText).toContain("brain_");
  });

  test("a different session id gets the full reminder again", async () => {
    const stateDir = join(tmp, "markers");
    const env = { O2B_REMINDER_STATE_DIR: stateDir };
    await runHookEnv(claudePayload("/tmp/a.md"), env);

    const other = await runHookEnv({ ...claudePayload("/tmp/b.md"), session_id: "sess-2" }, env);
    const text = JSON.parse(other.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("Trivial edits");
  });

  test("missing session id falls back to the full reminder every time", async () => {
    const stateDir = join(tmp, "markers");
    const env = { O2B_REMINDER_STATE_DIR: stateDir };
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/a.md", content: "hi" },
      transcript_path: "/Users/x/.claude/projects/-srv/foo.jsonl",
    };
    await runHookEnv(payload, env);
    const again = await runHookEnv(payload, env);
    const text = JSON.parse(again.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("Trivial edits");
  });

  test("Codex one-shot runs keep the full reminder on every write", async () => {
    const stateDir = join(tmp, "markers");
    const env = { O2B_REMINDER_STATE_DIR: stateDir };
    const patch = "*** Begin Patch\n*** Update File: /tmp/x\n*** End Patch\n";
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { input: patch },
      session_id: "sess-codex",
    };
    await runHookEnv(payload, env);
    const again = await runHookEnv(payload, env);
    const text = JSON.parse(again.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("codex exec");
    expect(text).toContain("Trivial edits");
  });

  test("unwritable state dir fails soft to the full reminder", async () => {
    const env = { O2B_REMINDER_STATE_DIR: "/proc/definitely-not-writable/x" };
    const r = await runHookEnv(claudePayload("/tmp/a.md"), env);
    expect(r.exit).toBe(0);
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("Trivial edits");
  });
});
