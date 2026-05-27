import { describe, expect, test } from "bun:test";

import { detectFormat, parseTranscript } from "../../hooks/lib/transcript.ts";

// Minimal builders that mirror the on-disk shapes verified against
// live `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`
// rollouts. Each helper produces ONE JSONL line; tests join them.

function ccUser(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function ccToolResult(toolUseId: string, text = "ok"): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    },
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

function ccAssistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function cxUserEnvelope(text = "<environment_context>"): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}

function cxUser(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}

function cxFunctionCall(name: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name, call_id: "call_" + name, arguments: "{}" },
  });
}

function cxCustomToolCall(name: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", name, call_id: "call_" + name, input: "" },
  });
}

describe("detectFormat", () => {
  test("recognises Claude transcript", () => {
    expect(detectFormat(ccUser("hi"))).toBe("claude");
  });

  test("recognises Codex transcript", () => {
    expect(detectFormat(cxUser("hi"))).toBe("codex");
  });

  test("treats empty and malformed input as unknown", () => {
    expect(detectFormat("")).toBe("unknown");
    expect(detectFormat("not-json")).toBe("unknown");
    expect(detectFormat("[]")).toBe("unknown");
  });

  test("returns unknown for Claude bookkeeping records (no message.role)", () => {
    // Real Claude transcripts start with records like queue-operation,
    // permission-mode, attachment. They have `type` and `sessionId`
    // but no `message.role`. Detection must keep scanning so a real
    // user/assistant line drives the decision.
    expect(detectFormat(JSON.stringify({ type: "queue-operation", sessionId: "abc" }))).toBe(
      "unknown",
    );
    expect(
      detectFormat(JSON.stringify({ type: "permission-mode", permissionMode: "default" })),
    ).toBe("unknown");
  });
});

describe("parseTranscript — Claude", () => {
  test("collects tool_use calls after the last user message", () => {
    const jsonl = [
      ccUser("first user message"),
      ccAssistantToolUse("Read"),
      ccUser("second user message"),
      ccAssistantToolUse("Write", { file_path: "/tmp/a.md" }),
      ccAssistantToolUse("Edit", { file_path: "/tmp/a.md" }),
      ccAssistantText("done"),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual(["Write", "Edit"]);
  });

  test("does NOT treat tool_result records as user-turn boundaries", () => {
    // A `tool_result` is sent as `type:"user"` by the runtime but it is
    // NOT a real user prompt. The boundary must stay at the actual user
    // message, so tool_uses *before* the tool_result still count.
    const jsonl = [
      ccUser("real user prompt"),
      ccAssistantToolUse("Write", { file_path: "/tmp/a.md" }),
      ccToolResult("toolu_Write"),
      ccAssistantText("finished"),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual(["Write"]);
  });

  test("returns empty for sessions with no user message yet", () => {
    const jsonl = [ccAssistantText("system init")].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls).toEqual([]);
  });
});

describe("parseTranscript — Codex", () => {
  test("collects function_call and custom_tool_call after last user message", () => {
    const jsonl = [
      cxUserEnvelope(),
      cxUser("real user prompt"),
      cxFunctionCall("event_log_append"),
      cxCustomToolCall("apply_patch"),
      cxFunctionCall("exec_command"),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual([
      "event_log_append",
      "apply_patch",
      "exec_command",
    ]);
  });

  test("skips synthetic <environment_context> envelopes when finding the boundary", () => {
    // If we anchored at the envelope, we'd include tool calls from prior
    // turns. The real user prompt is the anchor.
    const jsonl = [
      cxUserEnvelope("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"),
      cxUser("real user prompt"),
      cxCustomToolCall("apply_patch"),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual(["apply_patch"]);
  });

  test("returns empty when there is no user prompt yet", () => {
    const jsonl = [cxUserEnvelope(), cxFunctionCall("exec_command")].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls).toEqual([]);
  });
});

describe("parseTranscript — robustness", () => {
  test("skips malformed lines silently", () => {
    const jsonl = ["not-json", ccUser("hi"), "{broken", ccAssistantToolUse("Write")].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual(["Write"]);
  });

  test("scans past Claude bookkeeping records before the first proper message", () => {
    const jsonl = [
      JSON.stringify({ type: "queue-operation", sessionId: "abc" }),
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
      ccUser("hi"),
      ccAssistantToolUse("Write", { file_path: "/tmp/x.md" }),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.toolCalls.map((t) => t.name)).toEqual(["Write"]);
  });
});

describe("parseTranscript — Bash commands", () => {
  test("Claude: collects Bash tool_use commands this turn", () => {
    const jsonl = [
      ccUser("log this"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_b",
              name: "Bash",
              input: { command: "o2b append-event 'fixed bug'" },
            },
          ],
        },
      }),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.bashCommands).toEqual(["o2b append-event 'fixed bug'"]);
  });

  test("Codex: collects exec_command arguments this turn", () => {
    const jsonl = [
      cxUserEnvelope(),
      cxUser("log this"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ cmd: "vault-log 'noted finding'" }),
        },
      }),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.bashCommands).toEqual(["vault-log 'noted finding'"]);
  });

  test("Codex: handles `command` field as fallback", () => {
    const jsonl = [
      cxUserEnvelope(),
      cxUser("log this"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c2",
          arguments: JSON.stringify({ command: ["o2b", "append-event", "x"] }),
        },
      }),
    ].join("\n");
    const sig = parseTranscript(jsonl);
    expect(sig.bashCommands).toEqual(["o2b append-event x"]);
  });
});
