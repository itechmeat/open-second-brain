/**
 * Transcript parser shared by the Stop hook. Reads the JSONL transcript
 * pointed at by `transcript_path` and extracts the turn's signal:
 * which tool calls happened since the last user message, and what their
 * canonical tool_name is.
 *
 * Both Claude Code and Codex pass `transcript_path` in the hook stdin
 * payload but each runtime uses a different on-disk shape:
 *
 *   Claude Code: one line per message, top-level `type: "user" | "assistant"`,
 *   tool calls inside `message.content[*]` as `{type:"tool_use", name, ...}`.
 *
 *   Codex: one line per record, top-level `{type: "response_item" |
 *   "event_msg" | "session_meta" | "turn_context", payload: ...}`. Tool
 *   calls land as `payload.type === "function_call"` (shell, MCP) or
 *   `payload.type === "custom_tool_call"` (apply_patch). The
 *   `payload.name` is the canonical tool name.
 *
 * We detect the format from the first non-empty line and apply the
 * right reader. The output is a normalized list of `ToolCall` records
 * since the last user-turn boundary.
 */

import { readFileSync, existsSync } from "node:fs";

export interface ToolCall {
  readonly name: string;
}

export interface TurnSignal {
  readonly toolCalls: readonly ToolCall[];
  /**
   * Plain-text shell commands the agent ran this turn. Surfaced
   * separately from `toolCalls` because the Stop guardrail wants to
   * treat `o2b append-event …` or `vault-log …` invoked through
   * Bash / `exec_command` as a valid log call.
   */
  readonly bashCommands: readonly string[];
}

type Format = "claude" | "codex" | "unknown";

// Strong signals to distinguish the two transcript shapes:
//   - Codex always wraps records as `{type, payload: {...}}`.
//   - Claude Code emits records with a `message` object that has a
//     `role` field. (Bookkeeping records like `queue-operation` /
//     `attachment` / `permission-mode` also use `type` + `sessionId`
//     but they DON'T carry `message.role`, so we can't anchor on
//     `sessionId` alone — we'd flip detection to "claude" off a
//     bookkeeping line and the actual format check below would still
//     work, but in a brittle way. Anchoring on `message.role` is the
//     stable signal.)
//
// Returns "unknown" when neither signal is present so the caller can
// scan more lines (real transcripts have many bookkeeping records
// before the first proper message).
export function detectFormat(firstLine: string): Format {
  if (firstLine.length === 0) return "unknown";
  let obj: unknown;
  try {
    obj = JSON.parse(firstLine);
  } catch {
    return "unknown";
  }
  if (obj === null || typeof obj !== "object") return "unknown";
  const o = obj as Record<string, unknown>;
  const payload = o.payload;
  if (
    "type" in o &&
    payload !== null &&
    typeof payload === "object" &&
    "type" in (payload as Record<string, unknown>)
  ) {
    return "codex";
  }
  const message = o.message;
  if (
    "type" in o &&
    message !== null &&
    typeof message === "object" &&
    "role" in (message as Record<string, unknown>)
  ) {
    return "claude";
  }
  return "unknown";
}

const EMPTY_SIGNAL: TurnSignal = { toolCalls: [], bashCommands: [] };

export function parseTranscript(jsonl: string): TurnSignal {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return EMPTY_SIGNAL;
  // Scan until we find a line that parses to a recognisable shape. A
  // malformed leading line (rare in practice — only seen during disk
  // races where the writer crashed mid-line) must not flip the whole
  // transcript to "unknown".
  let format: Format = "unknown";
  for (const line of lines) {
    format = detectFormat(line);
    if (format !== "unknown") break;
  }
  if (format === "claude") return parseClaude(lines);
  if (format === "codex") return parseCodex(lines);
  return EMPTY_SIGNAL;
}

export function readTranscript(transcriptPath: string): TurnSignal {
  if (!existsSync(transcriptPath)) return EMPTY_SIGNAL;
  const text = readFileSync(transcriptPath, "utf8");
  return parseTranscript(text);
}

interface ClaudeContentBlock {
  readonly type?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly text?: string;
}

interface ClaudeRecord {
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: ClaudeContentBlock[] | string;
  };
}

function parseClaude(lines: readonly string[]): TurnSignal {
  // Walk from the end backward to find the boundary index of the last
  // user message. Then collect tool_use entries from records strictly
  // after that index.
  const records: ClaudeRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as ClaudeRecord);
    } catch {
      // skip malformed lines
    }
  }
  let boundary = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type === "user" && r.message?.role === "user" && !isToolResultOnly(r)) {
      boundary = i;
      break;
    }
  }
  // No real user prompt in this transcript yet → there is no "current
  // turn" to evaluate. Return empty so the guardrail stays silent.
  if (boundary === -1) return EMPTY_SIGNAL;
  const toolCalls: ToolCall[] = [];
  const bashCommands: string[] = [];
  for (let i = boundary + 1; i < records.length; i++) {
    const r = records[i]!;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      toolCalls.push({ name: block.name });
      if (block.name === "Bash") {
        const cmd = block.input?.command;
        if (typeof cmd === "string") bashCommands.push(cmd);
      }
    }
  }
  return { toolCalls, bashCommands };
}

// Claude marks tool-results as `type: "user"` records that carry a
// `tool_result` content block — those are *not* real user turn
// boundaries; only treat plain user messages as boundaries.
function isToolResultOnly(r: ClaudeRecord): boolean {
  const content = r.message?.content;
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((b) => b?.type === "tool_result");
}

interface CodexRecord {
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly role?: string;
    readonly name?: string;
    readonly arguments?: string;
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  };
}

function parseCodex(lines: readonly string[]): TurnSignal {
  const records: CodexRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as CodexRecord);
    } catch {
      // skip
    }
  }
  let boundary = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    const p = r.payload;
    if (
      r.type === "response_item" &&
      p?.type === "message" &&
      p?.role === "user" &&
      !isCodexEnvelope(p)
    ) {
      boundary = i;
      break;
    }
  }
  if (boundary === -1) return EMPTY_SIGNAL;
  const toolCalls: ToolCall[] = [];
  const bashCommands: string[] = [];
  for (let i = boundary + 1; i < records.length; i++) {
    const r = records[i]!;
    const p = r.payload;
    if (!p) continue;
    if (
      (p.type === "function_call" || p.type === "custom_tool_call") &&
      typeof p.name === "string"
    ) {
      toolCalls.push({ name: p.name });
      if (p.name === "exec_command" || p.name === "shell") {
        const cmd = extractCodexShellCommand(p.arguments);
        if (cmd !== null) bashCommands.push(cmd);
      }
    }
  }
  return { toolCalls, bashCommands };
}

// Codex serialises function_call `arguments` as a JSON string. Pull
// out the `cmd` (older Codex) / `command` (newer) field if present.
// Returns null when the shape is anything else so the caller can
// fall through silently.
function extractCodexShellCommand(serialized: string | undefined): string | null {
  if (typeof serialized !== "string") return null;
  let args: unknown;
  try {
    args = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (args === null || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.cmd === "string") return a.cmd;
  if (typeof a.command === "string") return a.command;
  // exec_command sometimes uses argv-array form.
  if (Array.isArray(a.command)) {
    return a.command.filter((x) => typeof x === "string").join(" ");
  }
  return null;
}

// Codex prepends a synthetic `<environment_context>` user message at the
// start of every turn. We want to anchor at the *real* user prompt, not
// that envelope. Same for `<user_instructions>` blocks.
function isCodexEnvelope(p: NonNullable<CodexRecord["payload"]>): boolean {
  const content = p.content;
  if (!Array.isArray(content)) return false;
  const text = content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("");
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>")
  );
}
