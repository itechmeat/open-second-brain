/**
 * Hermes Agent .jsonl adapter.
 *
 * First line is a meta block `{ "role": "session_meta", "tools":
 * [...], ... }`. Conversation turns:
 *
 *   - `{ "role": "user" | "assistant" | "tool",
 *        "content": string-or-empty,
 *        "tool_calls"?: [{ id, call_id, type: "function",
 *                          function: { name, arguments: "json-string" } }],
 *        "timestamp": "ISO" }`
 *
 * The `tool` role is skipped — it carries function-call results, not
 * agent-issued signals. `session_meta` is skipped too. User and
 * assistant rows are emitted; assistant rows with `tool_calls` get
 * the calls flattened into `SessionToolCall[]` with JSON-decoded
 * arguments.
 *
 * Hermes timestamps are stored without a `Z` suffix (e.g.
 * `2026-05-03T19:59:06.411024`). We accept them as-is — they parse
 * the same with `new Date()`.
 */

import { readFileSync } from "node:fs";

import type { SessionAdapter, SessionToolCall, SessionTurn } from "./types.ts";

interface HermesToolCall {
  readonly id?: string;
  readonly call_id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

function decodeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw_arguments: raw };
    } catch {
      return { _raw_arguments: raw };
    }
  }
  if (raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function buildTurn(obj: Record<string, unknown>, fallbackIndex: number): SessionTurn | null {
  const role = obj["role"];
  if (role !== "user" && role !== "assistant") return null;
  const turnId = `hermes-${fallbackIndex}`;
  const timestamp =
    typeof obj["timestamp"] === "string" && obj["timestamp"].length > 0
      ? (obj["timestamp"] as string)
      : new Date(0).toISOString();

  const text =
    typeof obj["content"] === "string" && obj["content"].length > 0
      ? (obj["content"] as string)
      : undefined;

  const rawCalls = obj["tool_calls"];
  let toolCalls: SessionToolCall[] | undefined;
  if (Array.isArray(rawCalls)) {
    const collected: SessionToolCall[] = [];
    for (const raw of rawCalls) {
      if (raw === null || typeof raw !== "object") continue;
      const tc = raw as HermesToolCall;
      const fn = tc.function;
      if (!fn || typeof fn.name !== "string") continue;
      const id = tc.id ?? tc.call_id;
      collected.push({
        name: fn.name,
        input: decodeArguments(fn.arguments),
        ...(typeof id === "string" ? { id } : {}),
      });
    }
    if (collected.length > 0) toolCalls = collected;
  }

  return {
    turnId,
    timestamp,
    role,
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

export const hermesAdapter: SessionAdapter = {
  id: "hermes",
  defaultAgent: "hermes",
  detect(firstLine: string): boolean {
    let obj: unknown;
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return false;
    }
    if (obj === null || typeof obj !== "object") return false;
    const o = obj as Record<string, unknown>;
    if (o["role"] !== "session_meta") return false;
    // `tools` is the discriminator that separates Hermes from any
    // other "role: session_meta" shape (Claude / Codex meta lines
    // never set `tools` as a top-level array).
    return Array.isArray(o["tools"]);
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
      const turn = buildTurn(obj as Record<string, unknown>, i);
      if (turn) yield turn;
    }
  },
};
