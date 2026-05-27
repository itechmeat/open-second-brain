/**
 * Claude Code .jsonl adapter.
 *
 * Each line is a JSON object. Two shapes matter:
 *
 *   - `{ "type": "queue-operation", ... }` — runtime queue events;
 *     ignored.
 *   - `{ "parentUuid": ..., "type": "user"|"assistant",
 *        "message": { "role": ..., "content": ... },
 *        "uuid": ..., "timestamp": ..., "sessionId": ... }`
 *     — actual conversation turns. `content` is either a string (user
 *     plain text) or an array of blocks (`text` / `tool_use` / etc.).
 *
 * The adapter normalises both shapes into {@link SessionTurn} with
 * `text` (flat-text view) and optional `toolCalls`. `system` and
 * `tool` roles are not emitted by Claude Code's JSONL — we map any
 * non-user/non-assistant `type` to skip.
 */

import { readFileSync } from "node:fs";

import type { SessionAdapter, SessionToolCall, SessionTurn } from "./types.ts";

interface ClaudeBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly id?: string;
  readonly input?: Record<string, unknown>;
}

/** Parse a single Claude JSONL line into a `SessionTurn`, or null to skip. */
function turnFromLine(obj: unknown, fallbackIndex: number): SessionTurn | null {
  if (obj === null || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  // queue-operation: not a turn.
  if (o["type"] === "queue-operation") return null;
  const role = o["type"];
  if (role !== "user" && role !== "assistant") return null;

  const turnId =
    typeof o["uuid"] === "string" && o["uuid"].length > 0 ? o["uuid"] : `synth-${fallbackIndex}`;
  const timestamp =
    typeof o["timestamp"] === "string" && o["timestamp"].length > 0
      ? o["timestamp"]
      : new Date(0).toISOString();

  const message = o["message"];
  if (message === null || typeof message !== "object") {
    // Turn without payload — emit empty (still distinguishes user-vs-assistant).
    return { turnId, timestamp, role };
  }
  const content = (message as Record<string, unknown>)["content"];

  if (typeof content === "string") {
    return { turnId, timestamp, role, text: content };
  }
  if (!Array.isArray(content)) {
    return { turnId, timestamp, role };
  }
  const texts: string[] = [];
  const tools: SessionToolCall[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const b = raw as ClaudeBlock;
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      tools.push({
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
        ...(typeof b.id === "string" ? { id: b.id } : {}),
      });
    }
  }
  const turn: SessionTurn = {
    turnId,
    timestamp,
    role,
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
    ...(tools.length > 0 ? { toolCalls: tools } : {}),
  };
  return turn;
}

export const claudeAdapter: SessionAdapter = {
  id: "claude",
  detect(firstLine: string): boolean {
    let obj: unknown;
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return false;
    }
    if (obj === null || typeof obj !== "object") return false;
    const o = obj as Record<string, unknown>;
    if (o["type"] === "queue-operation") return true;
    const hasClaudeShape = "parentUuid" in o && "sessionId" in o && "entrypoint" in o;
    return hasClaudeShape;
  },
  async *iterate(path: string): AsyncIterable<SessionTurn> {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    let i = 0;
    for (const line of lines) {
      i++;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip silently; doctor / report can flag.
      }
      const turn = turnFromLine(obj, i);
      if (turn) yield turn;
    }
  },
};
