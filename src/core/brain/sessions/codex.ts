/**
 * Codex CLI .jsonl adapter.
 *
 * Each line is `{ timestamp, type, payload }`. We care about:
 *
 *   - `type === "response_item"` AND
 *     - `payload.type === "message"` — a user / assistant / system turn
 *       whose `payload.content` is an array of typed blocks
 *       (`input_text` / `output_text`, both carry `.text`).
 *     - `payload.type === "function_call"` — a tool-use call. The
 *       `arguments` field is a JSON-encoded **string**, not a value;
 *       we parse it back to an object so downstream code reads the
 *       same shape as Claude tool_use input.
 *
 * Everything else (`event_msg`, `token_count`, `session_meta`,
 * `reasoning`, ...) is skipped.
 *
 * Function-call turns are emitted under `role: "assistant"` because
 * the agent is the one issuing the call. We keep the original turn
 * id (`payload.call_id` falls back to a synthetic seq) so the
 * orchestrator can construct a stable `session_ref` for dedup.
 */

import { readFileSync } from "node:fs";

import type { SessionAdapter, SessionToolCall, SessionTurn } from "./types.ts";

interface CodexBlock {
  readonly type?: string;
  readonly text?: string;
}

function buildMessageTurn(
  obj: Record<string, unknown>,
  fallbackIndex: number,
): SessionTurn | null {
  const payload = obj["payload"] as Record<string, unknown> | undefined;
  if (!payload) return null;
  const role = payload["role"];
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const turnId = `codex-msg-${fallbackIndex}`;
  const timestamp =
    typeof obj["timestamp"] === "string"
      ? (obj["timestamp"] as string)
      : new Date(0).toISOString();

  const content = payload["content"];
  if (!Array.isArray(content)) {
    return { turnId, timestamp, role: role as SessionTurn["role"] };
  }
  const texts: string[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const b = raw as CodexBlock;
    if (
      (b.type === "input_text" || b.type === "output_text") &&
      typeof b.text === "string"
    ) {
      texts.push(b.text);
    }
  }
  return {
    turnId,
    timestamp,
    role: role as SessionTurn["role"],
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
  };
}

function buildFunctionCallTurn(
  obj: Record<string, unknown>,
  fallbackIndex: number,
): SessionTurn | null {
  const payload = obj["payload"] as Record<string, unknown> | undefined;
  if (!payload) return null;
  const name = payload["name"];
  if (typeof name !== "string" || name.length === 0) return null;
  const callId =
    typeof payload["call_id"] === "string"
      ? (payload["call_id"] as string)
      : undefined;
  // `arguments` is a JSON-encoded string in Codex's schema. Decode
  // defensively — a malformed JSON string surfaces as the raw text
  // under `_raw_arguments` so downstream validation can still report
  // a useful error.
  let input: Record<string, unknown> = {};
  const rawArgs = payload["arguments"];
  if (typeof rawArgs === "string" && rawArgs.length > 0) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        input = parsed as Record<string, unknown>;
      } else {
        input = { _raw_arguments: rawArgs };
      }
    } catch {
      input = { _raw_arguments: rawArgs };
    }
  } else if (
    rawArgs !== undefined &&
    rawArgs !== null &&
    typeof rawArgs === "object"
  ) {
    input = rawArgs as Record<string, unknown>;
  }
  const tc: SessionToolCall = {
    name,
    input,
    ...(callId !== undefined ? { id: callId } : {}),
  };
  const turnId =
    callId !== undefined ? `codex-fc-${callId}` : `codex-fc-${fallbackIndex}`;
  const timestamp =
    typeof obj["timestamp"] === "string"
      ? (obj["timestamp"] as string)
      : new Date(0).toISOString();
  return {
    turnId,
    timestamp,
    role: "assistant",
    toolCalls: [tc],
  };
}

export const codexAdapter: SessionAdapter = {
  id: "codex",
  defaultAgent: "codex",
  detect(firstLine: string): boolean {
    let obj: unknown;
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return false;
    }
    if (obj === null || typeof obj !== "object") return false;
    const o = obj as Record<string, unknown>;
    if (o["type"] !== "session_meta") return false;
    const payload = o["payload"];
    if (payload === null || typeof payload !== "object") return false;
    const p = payload as Record<string, unknown>;
    return (
      p["originator"] === "codex_exec" || typeof p["cli_version"] === "string"
    );
  },
  async *iterate(path: string): AsyncIterable<SessionTurn> {
    const text = readFileSync(path, "utf8");
    let i = 0;
    for (const line of text.split("\n")) {
      i++;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== "object") continue;
      const o = obj as Record<string, unknown>;
      if (o["type"] !== "response_item") continue;
      const payload = o["payload"] as Record<string, unknown> | undefined;
      if (!payload) continue;
      if (payload["type"] === "message") {
        const turn = buildMessageTurn(o, i);
        if (turn) yield turn;
      } else if (payload["type"] === "function_call") {
        const turn = buildFunctionCallTurn(o, i);
        if (turn) yield turn;
      }
      // Other payload types (reasoning, function_call_output, ...) are
      // skipped — they don't carry signals or tool-use calls we want.
    }
  },
};
