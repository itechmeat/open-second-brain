/**
 * Grok Build hook-payload compatibility.
 *
 * Grok delivers the hook event on stdin with camelCase field names and a
 * snake_case event VALUE (`{hookEventName: "session_start", sessionId,
 * workspaceRoot, toolName, toolInput, ...}`), where Claude Code and Codex use
 * snake_case keys and a PascalCase event value (`{hook_event_name:
 * "SessionStart", session_id, tool_name, tool_input}`). The shared parser
 * normalizes grok into the internal snake_case shape so every downstream hook
 * (active-context inject, post-write reminder, session capture) works under
 * grok unchanged, and runtime detection recognizes grok.
 *
 * Verified against grok 0.2.45 bundled docs (user-guide/10-hooks.md).
 */

import { describe, expect, test } from "bun:test";

import { asHookPayload, normalizeHookPayload } from "../../hooks/lib/stdin.ts";
import { detectHookRuntime, isArtifactToolName } from "../../hooks/lib/detect.ts";
import { isContextEventName } from "../../hooks/lib/context-events.ts";

const GROK_PRE_TOOL = {
  hookEventName: "pre_tool_use",
  sessionId: "abc-123",
  cwd: "/home/u/project",
  workspaceRoot: "/home/u/project",
  toolName: "run_terminal_command",
  toolInput: { command: "npm test" },
  timestamp: "2026-06-11T12:00:00Z",
};

const GROK_SESSION_START = { hookEventName: "session_start", sessionId: "s1", cwd: "/w" };

const CLAUDE_PRE_TOOL = {
  hook_event_name: "PreToolUse",
  session_id: "c-1",
  cwd: "/home/u/project",
  tool_use_id: "tu-1",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  transcript_path: "/home/u/.claude/projects/x/abc.jsonl",
};

describe("normalizeHookPayload - grok camelCase to internal snake_case", () => {
  test("maps the documented grok keys", () => {
    const n = normalizeHookPayload(GROK_PRE_TOOL) as Record<string, unknown>;
    expect(n["hook_event_name"]).toBe("PreToolUse");
    expect(n["session_id"]).toBe("abc-123");
    expect(n["tool_name"]).toBe("run_terminal_command");
    expect(n["tool_input"]).toEqual({ command: "npm test" });
  });

  test("converts the snake_case event value to the canonical PascalCase", () => {
    expect(
      (normalizeHookPayload({ hookEventName: "session_start" }) as Record<string, unknown>)[
        "hook_event_name"
      ],
    ).toBe("SessionStart");
    expect(
      (normalizeHookPayload({ hookEventName: "user_prompt_submit" }) as Record<string, unknown>)[
        "hook_event_name"
      ],
    ).toBe("UserPromptSubmit");
  });

  test("leaves a Claude snake_case payload byte-for-byte equivalent", () => {
    const n = normalizeHookPayload(CLAUDE_PRE_TOOL) as Record<string, unknown>;
    expect(n["hook_event_name"]).toBe("PreToolUse");
    expect(n["session_id"]).toBe("c-1");
    expect(n["tool_name"]).toBe("Bash");
    expect(n["transcript_path"]).toBe("/home/u/.claude/projects/x/abc.jsonl");
  });

  test("passes non-object values through unchanged", () => {
    expect(normalizeHookPayload(null)).toBeNull();
    expect(normalizeHookPayload("x")).toBe("x");
  });
});

describe("asHookPayload - typed access for grok", () => {
  test("exposes grok fields through the snake_case accessors", () => {
    const p = asHookPayload(GROK_PRE_TOOL);
    expect(p.hook_event_name).toBe("PreToolUse");
    expect(p.session_id).toBe("abc-123");
    expect(p.tool_name).toBe("run_terminal_command");
  });

  test("a grok SessionStart payload is recognized as a context event", () => {
    const p = asHookPayload(GROK_SESSION_START);
    expect(p.hook_event_name).toBe("SessionStart");
    expect(isContextEventName(p.hook_event_name ?? "")).toBe(true);
  });

  test("grok omits transcript_path; the field stays undefined, not faked", () => {
    expect(asHookPayload(GROK_PRE_TOOL).transcript_path).toBeUndefined();
  });
});

describe("detectHookRuntime - grok", () => {
  test("detects grok from the camelCase payload shape", () => {
    expect(detectHookRuntime(GROK_PRE_TOOL)).toBe("grok");
    expect(detectHookRuntime(GROK_SESSION_START)).toBe("grok");
  });

  test("detects grok from the GROK_* environment when the payload is opaque", () => {
    expect(detectHookRuntime({}, { GROK_HOOK_EVENT: "session_start" })).toBe("grok");
  });

  test("still detects Claude Code and Codex unchanged", () => {
    expect(detectHookRuntime(CLAUDE_PRE_TOOL, {})).toBe("claudecode");
    expect(
      detectHookRuntime(
        { tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n" } },
        {},
      ),
    ).toBe("codex");
  });

  test("an opaque payload with no grok signal stays unknown", () => {
    expect(detectHookRuntime({ foo: 1 }, {})).toBe("unknown");
  });
});

describe("artifact tool name - grok", () => {
  test("grok's search_replace counts as a file-mutating tool", () => {
    expect(isArtifactToolName("search_replace")).toBe(true);
    // The cross-runtime names still count.
    expect(isArtifactToolName("Write")).toBe(true);
    expect(isArtifactToolName("apply_patch")).toBe(true);
  });
});
